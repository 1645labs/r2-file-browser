# R2 Drive — a simple file browser for Cloudflare R2

A lightweight, Google-Drive-style web UI for browsing a Cloudflare R2 bucket over
the S3-compatible API. Upload, download, browse subfolders, preview images (and
video / audio / PDF), create folders, and delete — no build step, deploys to
Render as a single Node web service.

## Features

- 📁 Browse folders and subfolders with breadcrumb navigation
- ⬆ Upload files (button or drag-and-drop) with progress, streamed straight to R2
- ⬇ Download via short-lived presigned URLs
- 🖼️ Built-in viewer: images (with grid thumbnails), video, audio, PDF
- 🗑 Delete files and folders (recursive)
- 🔒 Optional shared-password gate (`APP_PASSWORD`)

## Architecture

- **Backend:** Node + Express, `@aws-sdk/client-s3` pointed at the R2 endpoint.
  Uploads stream through `@aws-sdk/lib-storage`; downloads/previews use presigned
  GET URLs so bytes flow browser ↔ R2 directly.
- **Frontend:** static vanilla-JS SPA in `public/` (no bundler).
- Credentials never reach the browser; the server signs every URL.

## Configuration

Copy `.env.example` to `.env` and fill in your R2 details:

| Var | Description |
| --- | --- |
| `S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` for R2 |
| `S3_BUCKET` | bucket to browse |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from an R2 API token |
| `APP_PASSWORD` | optional; gate the app behind a password |
| `PRESIGN_TTL` | presigned URL lifetime, seconds (default 300) |

Create the R2 credentials in the Cloudflare dashboard under
**R2 → Manage R2 API Tokens** (Object Read & Write).

## Run locally

```bash
npm install
cp .env.example .env   # then fill in R2 details
npm start              # http://localhost:3000
```

## Deploy to Render

The repo includes `render.yaml`. Either connect the repo as a Blueprint in the
Render dashboard, or the service is created via the Render CLI. After the service
exists, set the `S3_*` (and optional `APP_PASSWORD`) environment variables in the
Render dashboard / via `render services update`, then redeploy.

## Smoke test

With the server running against an S3-compatible backend (MinIO or R2):

```bash
BASE_URL=http://localhost:3000 npm run smoke
```

This creates a folder, uploads a text file and image, lists, previews the image,
downloads, and deletes — verifying the full round trip.
