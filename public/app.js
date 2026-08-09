"use strict";

// ---------------------------------------------------------------------------
// State + helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let currentPrefix = ""; // "" = root, otherwise "a/b/"
let lastData = null; // last listing payload, for re-rendering on view toggle
let viewMode = localStorage.getItem("rfb_view") || "list"; // "list" (default) | "grid"

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
const TEXT_EXT = [
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "less", "html", "htm",
  "xml", "svg", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cc", "cs", "php", "pl", "lua", "r", "sql",
  "gradle", "dockerfile", "makefile", "gitignore", "diff", "patch", "tex",
];
const TEXT_PREVIEW_LIMIT = 1024 * 1024; // keep in sync with server /api/text

function ext(name) {
  const i = name.lastIndexOf(".");
  return i > -1 ? name.slice(i + 1).toLowerCase() : "";
}
function isImage(name) {
  return IMAGE_EXT.includes(ext(name));
}
function isText(name) {
  const e = ext(name);
  if (TEXT_EXT.includes(e)) return true;
  // extension-less common text files (Dockerfile, Makefile, LICENSE, README)
  if (!e && /^(dockerfile|makefile|license|readme|changelog|authors|notice)$/i.test(name)) return true;
  return false;
}
function iconFor(name) {
  const e = ext(name);
  if (VIDEO_EXT.includes(e)) return "🎬";
  if (AUDIO_EXT.includes(e)) return "🎵";
  if (["pdf"].includes(e)) return "📕";
  if (["zip", "tar", "gz", "rar", "7z"].includes(e)) return "🗜️";
  if (["doc", "docx", "txt", "md", "rtf"].includes(e)) return "📄";
  if (["xls", "xlsx", "csv"].includes(e)) return "📊";
  if (["ppt", "pptx"].includes(e)) return "📽️";
  if (["js", "ts", "json", "html", "css", "py", "go", "rs", "sh"].includes(e)) return "💻";
  return "📄";
}
function fmtSize(bytes) {
  if (bytes == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.includes("/login")) {
    showLogin();
    throw new Error("Unauthorized");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function showLogin() {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-password").focus();
}
function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const password = $("login-password").value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    showApp();
    navigate(readHash());
  } else {
    const j = await res.json().catch(() => ({}));
    $("login-error").textContent = j.error || "Login failed";
  }
});

$("btn-logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function readHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (!h) return "";
  return h.endsWith("/") ? h : h + "/";
}
function setHash(prefix) {
  const target = prefix ? "#/" + prefix : "#/";
  if (location.hash !== target) location.hash = target;
}
function navigate(prefix) {
  currentPrefix = prefix || "";
  setHash(currentPrefix);
  renderBreadcrumbs();
  loadListing();
}
window.addEventListener("hashchange", () => {
  const p = readHash();
  if (p !== currentPrefix) {
    currentPrefix = p;
    renderBreadcrumbs();
    loadListing();
  }
});

function renderBreadcrumbs() {
  const bc = $("breadcrumbs");
  bc.innerHTML = "";
  const parts = currentPrefix.split("/").filter(Boolean);
  const root = document.createElement("span");
  root.className = "crumb" + (parts.length === 0 ? " current" : "");
  root.textContent = "🏠 My R2";
  root.onclick = () => navigate("");
  bc.appendChild(root);

  let acc = "";
  parts.forEach((part, idx) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    bc.appendChild(sep);
    acc += part + "/";
    const crumb = document.createElement("span");
    const isLast = idx === parts.length - 1;
    crumb.className = "crumb" + (isLast ? " current" : "");
    crumb.textContent = part;
    const p = acc;
    if (!isLast) crumb.onclick = () => navigate(p);
    bc.appendChild(crumb);
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------
async function loadListing() {
  const listing = $("listing");
  $("empty").classList.add("hidden");
  $("error-banner").classList.add("hidden");
  $("loading").classList.remove("hidden");
  listing.innerHTML = "";
  try {
    const res = await api(`/api/list?prefix=${encodeURIComponent(currentPrefix)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to list");
    renderListing(data);
  } catch (err) {
    showError(err.message);
  } finally {
    $("loading").classList.add("hidden");
  }
}

function showError(msg) {
  const b = $("error-banner");
  b.textContent = msg;
  b.classList.remove("hidden");
}

function renderListing(data) {
  lastData = data;
  const listing = $("listing");
  listing.className = "listing " + viewMode;
  listing.innerHTML = "";
  const total = data.folders.length + data.files.length;
  $("empty").classList.toggle("hidden", total > 0);

  for (const folder of data.folders) {
    listing.appendChild(folderCard(folder));
  }
  for (const file of data.files) {
    listing.appendChild(fileCard(file));
  }
}

function setViewMode(mode) {
  viewMode = mode === "grid" ? "grid" : "list";
  localStorage.setItem("rfb_view", viewMode);
  $("view-list").classList.toggle("active", viewMode === "list");
  $("view-grid").classList.toggle("active", viewMode === "grid");
  if (lastData) renderListing(lastData);
  else $("listing").className = "listing " + viewMode;
}
$("view-list").addEventListener("click", () => setViewMode("list"));
$("view-grid").addEventListener("click", () => setViewMode("grid"));
// reflect the persisted choice on the toggle at load
$("view-list").classList.toggle("active", viewMode === "list");
$("view-grid").classList.toggle("active", viewMode === "grid");

function folderCard(folder) {
  const card = document.createElement("div");
  card.className = "card folder";
  card.innerHTML = `
    <div class="card-thumb">📁</div>
    <div class="card-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
    <div class="card-meta">Folder</div>
    <div class="card-actions">
      <button class="icon-btn danger" title="Delete folder">🗑</button>
    </div>`;
  card.onclick = () => navigate(folder.prefix);
  card.querySelector(".icon-btn.danger").onclick = (e) => {
    e.stopPropagation();
    deleteEntry(folder.prefix, folder.name, true);
  };
  return card;
}

// Prefer the direct public URL (public bucket) for reads; else the presigned proxy.
function viewUrl(file) {
  return file.url || `/api/view?key=${encodeURIComponent(file.key)}`;
}

function fileCard(file) {
  const card = document.createElement("div");
  card.className = "card file";
  const thumb = isImage(file.name)
    ? `<div class="card-thumb"><img loading="lazy" src="${viewUrl(file)}" alt="" onerror="this.parentNode.textContent='🖼️'"/></div>`
    : `<div class="card-thumb">${iconFor(file.name)}</div>`;
  card.innerHTML = `
    ${thumb}
    <div class="card-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
    <div class="card-meta">${fmtSize(file.size)} · ${fmtDate(file.lastModified)}</div>
    <div class="card-actions">
      <button class="icon-btn" title="Download">⬇</button>
      <button class="icon-btn danger" title="Delete">🗑</button>
    </div>`;
  card.onclick = () => openFile(file);
  const [dl, del] = card.querySelectorAll(".icon-btn");
  dl.onclick = (e) => {
    e.stopPropagation();
    downloadFile(file.key);
  };
  del.onclick = (e) => {
    e.stopPropagation();
    deleteEntry(file.key, file.name, false);
  };
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// File actions
// ---------------------------------------------------------------------------
function downloadFile(key) {
  window.location.href = `/api/download?key=${encodeURIComponent(key)}`;
}

async function deleteEntry(key, name, isFolder) {
  const msg = isFolder
    ? `Delete folder "${name}" and everything inside it?`
    : `Delete "${name}"?`;
  if (!confirm(msg)) return;
  try {
    const res = await api(`/api/object?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Delete failed");
    loadListing();
  } catch (err) {
    showError(err.message);
  }
}

$("btn-new-folder").addEventListener("click", async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    const res = await api("/api/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: currentPrefix, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create folder");
    loadListing();
  } catch (err) {
    showError(err.message);
  }
});

// ---------------------------------------------------------------------------
// Viewer (image / video / audio / pdf)
// ---------------------------------------------------------------------------
function openFile(file) {
  const url = viewUrl(file);
  const e = ext(file.name);
  const body = $("viewer-body");
  body.innerHTML = "";
  $("viewer-name").textContent = file.name;
  $("viewer-download").href = `/api/download?key=${encodeURIComponent(file.key)}`;

  if (isImage(file.name)) {
    const img = document.createElement("img");
    img.src = url;
    body.appendChild(img);
  } else if (VIDEO_EXT.includes(e)) {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    body.appendChild(v);
  } else if (AUDIO_EXT.includes(e)) {
    const a = document.createElement("audio");
    a.src = url;
    a.controls = true;
    a.autoplay = true;
    body.appendChild(a);
  } else if (e === "pdf") {
    const f = document.createElement("iframe");
    f.src = url;
    f.style.width = "90vw";
    f.style.height = "85vh";
    f.style.border = "0";
    f.style.borderRadius = "8px";
    f.style.background = "#fff";
    body.appendChild(f);
  } else if (isText(file.name)) {
    const pre = document.createElement("pre");
    pre.className = "viewer-text";
    pre.textContent = "Loading…";
    body.appendChild(pre);
    fetch(`/api/text?key=${encodeURIComponent(file.key)}`)
      .then(async (r) => {
        if (r.status === 401) {
          closeViewer();
          showLogin();
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        pre.textContent = text.length ? text : "(empty file)";
        if (typeof file.size === "number" && file.size > TEXT_PREVIEW_LIMIT) {
          const note = document.createElement("div");
          note.className = "viewer-truncated";
          note.textContent = `Showing first ${fmtSize(TEXT_PREVIEW_LIMIT)} of ${fmtSize(file.size)}.`;
          body.insertBefore(note, pre);
        }
      })
      .catch((err) => {
        pre.textContent = "Could not load preview: " + err.message;
      });
  } else {
    // Non-previewable: offer download.
    const div = document.createElement("div");
    div.className = "viewer-fallback";
    div.innerHTML = `<div style="font-size:64px">${iconFor(file.name)}</div>
      <p>No preview available for this file type.</p>`;
    body.appendChild(div);
  }
  $("viewer").classList.remove("hidden");
}

function closeViewer() {
  $("viewer").classList.add("hidden");
  $("viewer-body").innerHTML = "";
}
$("viewer-close").addEventListener("click", closeViewer);
$("viewer").addEventListener("click", (e) => {
  if (e.target === $("viewer") || e.target === $("viewer-body")) closeViewer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeViewer();
});

// ---------------------------------------------------------------------------
// Upload (XHR for progress) + drag & drop
// ---------------------------------------------------------------------------
$("btn-upload").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  if (e.target.files.length) uploadFiles(e.target.files);
  e.target.value = "";
});

function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);

  const toast = $("upload-toast");
  const bar = $("upload-progress-bar");
  const title = $("upload-toast-title");
  toast.classList.remove("hidden");
  title.textContent = `Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`;
  bar.style.width = "0%";

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?prefix=${encodeURIComponent(currentPrefix)}`);
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) {
      bar.style.width = `${Math.round((ev.loaded / ev.total) * 100)}%`;
    }
  };
  xhr.onload = () => {
    if (xhr.status === 401) {
      toast.classList.add("hidden");
      showLogin();
      return;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      bar.style.width = "100%";
      title.textContent = "Upload complete";
      setTimeout(() => toast.classList.add("hidden"), 1200);
      loadListing();
    } else {
      let err = "Upload failed";
      try {
        err = JSON.parse(xhr.responseText).error || err;
      } catch {}
      title.textContent = err;
      setTimeout(() => toast.classList.add("hidden"), 3000);
    }
  };
  xhr.onerror = () => {
    title.textContent = "Upload failed";
    setTimeout(() => toast.classList.add("hidden"), 3000);
  };
  xhr.send(form);
}

const dz = $("drop-zone");
const overlay = $("drop-overlay");
let dragDepth = 0;
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragenter") dragDepth++;
    overlay.classList.remove("hidden");
  })
);
dz.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    overlay.classList.add("hidden");
  }
});
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add("hidden");
  const files = e.dataTransfer.files;
  if (files && files.length) uploadFiles(files);
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const res = await fetch("/api/session");
    const s = await res.json();
    if (s.authRequired && !s.authed) {
      showLogin();
    } else {
      showApp();
      $("btn-logout").classList.toggle("hidden", !s.authRequired);
      navigate(readHash());
    }
  } catch {
    showApp();
    navigate(readHash());
  }
})();
