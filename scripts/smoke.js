// End-to-end smoke test against a running server (default http://localhost:3000).
// Exercises: create folder, upload (root + subfolder), list, view image, download, delete.
// Requires the server to be configured against an S3-compatible backend (MinIO or R2).

const BASE = process.env.BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD || "";

let cookie = "";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok  -", msg);
}

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers, redirect: "manual" });
  return res;
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const TXT = Buffer.from("hello r2 file browser\n");

async function main() {
  // Health
  let res = await req("/api/health");
  const health = await res.json();
  assert(res.status === 200 && health.configured, "server healthy + storage configured");

  // Login if needed
  if (PASSWORD) {
    res = await fetch(BASE + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert(res.ok, "login");
    cookie = res.headers.get("set-cookie").split(";")[0];
  }

  // Create folder
  res = await req("/api/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", name: "smoke-photos" }),
  });
  assert(res.ok, "create folder smoke-photos/");

  // Upload text to root
  let fd = new FormData();
  fd.append("files", new Blob([TXT], { type: "text/plain" }), "note.txt");
  res = await fetch(BASE + "/api/upload", { method: "POST", body: fd, headers: cookie ? { Cookie: cookie } : {} });
  assert(res.ok, "upload note.txt to root");

  // Upload image into subfolder
  fd = new FormData();
  fd.append("files", new Blob([PNG], { type: "image/png" }), "pixel.png");
  res = await fetch(BASE + "/api/upload?prefix=smoke-photos/", {
    method: "POST",
    body: fd,
    headers: cookie ? { Cookie: cookie } : {},
  });
  assert(res.ok, "upload pixel.png to smoke-photos/");

  // List root
  res = await req("/api/list?prefix=");
  let data = await res.json();
  assert(
    data.folders.some((f) => f.name === "smoke-photos"),
    "root listing shows smoke-photos folder"
  );
  assert(data.files.some((f) => f.name === "note.txt"), "root listing shows note.txt");

  // List subfolder
  res = await req("/api/list?prefix=smoke-photos/");
  data = await res.json();
  assert(data.files.some((f) => f.name === "pixel.png"), "subfolder listing shows pixel.png");

  // If the bucket is public (S3_PUBLIC_BASE_URL set), list items carry a direct
  // public url. Fetch it anonymously (no cookie) and verify the bytes.
  const pixel = data.files.find((f) => f.name === "pixel.png");
  if (pixel && pixel.url) {
    const pub = await fetch(pixel.url);
    const pubBytes = Buffer.from(await pub.arrayBuffer());
    assert(pubBytes.equals(PNG), "public url serves image bytes anonymously");
    assert((pub.headers.get("content-type") || "").includes("image"), "public url content-type is image/*");
  } else {
    console.log("ok  - (public base URL not set; skipping public-url check)");
  }

  // View image -> presigned redirect -> fetch actual bytes
  res = await req("/api/view?key=smoke-photos/pixel.png");
  assert(res.status === 302 && res.headers.get("location"), "view returns presigned redirect");
  let bin = await fetch(res.headers.get("location"));
  const viewBytes = Buffer.from(await bin.arrayBuffer());
  assert(viewBytes.equals(PNG), "viewed image bytes match uploaded PNG");
  assert((bin.headers.get("content-type") || "").includes("image"), "viewed image content-type is image/*");

  // Download -> presigned redirect with attachment
  res = await req("/api/download?key=note.txt");
  assert(res.status === 302, "download returns presigned redirect");
  bin = await fetch(res.headers.get("location"));
  const dlBytes = Buffer.from(await bin.arrayBuffer());
  assert(dlBytes.equals(TXT), "downloaded bytes match uploaded note.txt");

  // Text preview endpoint returns the file content, same-origin.
  res = await req("/api/text?key=note.txt");
  assert(res.status === 200, "text preview returns 200");
  assert((res.headers.get("content-type") || "").includes("text/plain"), "text preview content-type is text/plain");
  const previewText = await res.text();
  assert(previewText === TXT.toString(), "text preview body matches uploaded note.txt");

  // Delete file
  res = await req("/api/object?key=note.txt", { method: "DELETE" });
  assert(res.ok, "delete note.txt");

  // Delete folder (recursive)
  res = await req("/api/object?key=smoke-photos/", { method: "DELETE" });
  assert(res.ok, "delete smoke-photos/ recursively");

  // Confirm cleanup
  res = await req("/api/list?prefix=");
  data = await res.json();
  assert(!data.files.some((f) => f.name === "note.txt"), "note.txt gone after delete");
  assert(!data.folders.some((f) => f.name === "smoke-photos"), "smoke-photos gone after delete");

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
