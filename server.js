import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import busboy from "busboy";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Accept both the S3_* names and Cloudflare's own R2 dashboard names.
const env = (...names) => {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return undefined;
};
const ACCOUNT_ID = env("R2_ACCOUNT_ID", "ACCOUNT_ID");
const BUCKET = env("S3_BUCKET", "R2_BUCKET", "BUCKET");
const ENDPOINT =
  env("S3_ENDPOINT", "S3_API_ENDPOINT", "R2_ENDPOINT") ||
  (ACCOUNT_ID ? `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const REGION = env("S3_REGION", "R2_REGION") || "auto";
const ACCESS_KEY_ID = env("S3_ACCESS_KEY_ID", "ACCESS_KEY_ID", "R2_ACCESS_KEY_ID");
const SECRET_ACCESS_KEY = env("S3_SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY");
const APP_PASSWORD = process.env.APP_PASSWORD || ""; // optional gate
const PRESIGN_TTL = Number(process.env.PRESIGN_TTL || 300); // seconds
// Public bucket base URL (R2 r2.dev URL or custom domain). When set, reads
// (thumbnails, image/media viewing) go straight to the public URL instead of
// server-proxied presigned URLs. Writes/listing still use the S3 credentials.
const PUBLIC_BASE = (env("S3_PUBLIC_BASE_URL", "R2_PUBLIC_BASE_URL") || "").replace(/\/+$/, "");

const configured = Boolean(BUCKET && ENDPOINT && ACCESS_KEY_ID && SECRET_ACCESS_KEY);

const s3 = configured
  ? new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true, // R2 + MinIO friendly
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    })
  : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function requireConfigured(res) {
  if (!configured) {
    res
      .status(503)
      .json({ error: "Storage not configured. Set S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY." });
    return false;
  }
  return true;
}

// Normalize a prefix to either "" (root) or "some/path/" (trailing slash, no leading slash).
function normalizePrefix(raw) {
  let p = (raw || "").replace(/^\/+/, "");
  if (p && !p.endsWith("/")) p += "/";
  // block traversal
  if (p.split("/").some((seg) => seg === "..")) return "";
  return p;
}

// Sanitize a single path segment (file or folder name) from user input.
function safeName(name) {
  return String(name || "")
    .replace(/[\/\\]/g, "") // no path separators
    .replace(/^\.+$/, "") // no . or ..
    .trim();
}

function keyOk(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.split("/").some((seg) => seg === "..")) return false;
  return true;
}

// Build a direct public URL for a key when a public base is configured.
function publicUrl(key) {
  if (!PUBLIC_BASE) return null;
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${PUBLIC_BASE}/${encoded}`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json());

// Optional shared-password gate. Uses an httpOnly cookie holding an HMAC token.
const cookieSecret = crypto.createHash("sha256").update(APP_PASSWORD || "unset").digest();
function makeToken() {
  return crypto.createHmac("sha256", cookieSecret).update("ok").digest("hex");
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  if (!APP_PASSWORD) return true;
  return parseCookies(req).rfb_auth === makeToken();
}

app.post("/api/login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const supplied = String(req.body?.password || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_PASSWORD);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: "Invalid password" });
  res.setHeader(
    "Set-Cookie",
    `rfb_auth=${makeToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`
  );
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "rfb_auth=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// Gate every /api route except login/logout/health.
app.use("/api", (req, res, next) => {
  if (["/login", "/logout", "/health"].includes(req.path)) return next();
  if (!authed(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured, authRequired: Boolean(APP_PASSWORD), publicBase: Boolean(PUBLIC_BASE) });
});

// Whether the client currently has access (drives the login screen).
app.get("/api/session", (req, res) => {
  res.json({ authed: authed(req), authRequired: Boolean(APP_PASSWORD), configured, publicBase: Boolean(PUBLIC_BASE) });
});

// List folders + files under a prefix.
app.get("/api/list", async (req, res) => {
  if (!requireConfigured(res)) return;
  const prefix = normalizePrefix(req.query.prefix);
  try {
    const folders = [];
    const files = [];
    let ContinuationToken;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken,
        })
      );
      for (const cp of out.CommonPrefixes || []) {
        const full = cp.Prefix;
        const name = full.slice(prefix.length).replace(/\/$/, "");
        if (name) folders.push({ name, prefix: full });
      }
      for (const obj of out.Contents || []) {
        if (obj.Key === prefix) continue; // the folder placeholder object itself
        const name = obj.Key.slice(prefix.length);
        if (!name || name.endsWith("/")) continue; // nested placeholder
        files.push({
          key: obj.Key,
          name,
          size: obj.Size,
          lastModified: obj.LastModified,
          url: publicUrl(obj.Key),
        });
      }
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ prefix, folders, files });
  } catch (err) {
    console.error("list error", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a folder (zero-byte placeholder key ending in "/").
app.post("/api/folder", async (req, res) => {
  if (!requireConfigured(res)) return;
  const prefix = normalizePrefix(req.body?.prefix);
  const name = safeName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Invalid folder name" });
  const key = `${prefix}${name}/`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "" }));
    res.json({ ok: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming multipart upload -> S3. Supports multiple files. ?prefix=folder/
app.post("/api/upload", (req, res) => {
  if (!requireConfigured(res)) return;
  const prefix = normalizePrefix(req.query.prefix);
  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });
  } catch {
    return res.status(400).json({ error: "Invalid upload request" });
  }
  const uploaded = [];
  const pending = [];
  let aborted = false;

  bb.on("file", (_field, stream, info) => {
    const name = safeName(info.filename);
    if (!name) {
      stream.resume();
      return;
    }
    const key = `${prefix}${name}`;
    const up = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: stream,
        ContentType: info.mimeType || "application/octet-stream",
      },
    });
    pending.push(
      up
        .done()
        .then(() => uploaded.push({ key, name }))
        .catch((err) => {
          aborted = true;
          stream.resume();
          throw err;
        })
    );
  });

  bb.on("error", (err) => {
    aborted = true;
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  bb.on("close", async () => {
    try {
      await Promise.all(pending);
      if (!aborted && !res.headersSent) res.json({ ok: true, uploaded });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  req.pipe(bb);
});

// Redirect to a presigned URL for inline viewing (used by <img>, previews).
app.get("/api/view", async (req, res) => {
  if (!requireConfigured(res)) return;
  const key = req.query.key;
  if (!keyOk(key)) return res.status(400).json({ error: "Invalid key" });
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: PRESIGN_TTL }
    );
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redirect to a presigned URL that forces download.
app.get("/api/download", async (req, res) => {
  if (!requireConfigured(res)) return;
  const key = req.query.key;
  if (!keyOk(key)) return res.status(400).json({ error: "Invalid key" });
  const filename = key.split("/").pop() || "download";
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
      }),
      { expiresIn: PRESIGN_TTL }
    );
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a file, or recursively delete a folder (key ending in "/").
app.delete("/api/object", async (req, res) => {
  if (!requireConfigured(res)) return;
  const key = req.query.key;
  if (!keyOk(key)) return res.status(400).json({ error: "Invalid key" });
  try {
    if (key.endsWith("/")) {
      // recursive delete of everything under the prefix
      let ContinuationToken;
      do {
        const out = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: key, ContinuationToken })
        );
        const objects = (out.Contents || []).map((o) => ({ Key: o.Key }));
        if (objects.length) {
          await s3.send(
            new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } })
          );
        }
        ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (ContinuationToken);
      // remove the placeholder itself if present
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
    } else {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`r2-file-browser listening on :${PORT} (configured=${configured})`);
  if (!configured) {
    console.warn("Storage not configured — set S3_* env vars to enable file operations.");
  }
});

export { app };
