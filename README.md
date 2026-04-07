# MailArchive

A self-hosted Gmail archiver that syncs emails via IMAP to `.eml` files on a PVC, with a three-pane web UI. Runs on any Kubernetes cluster with persistent storage.

## What's New

- **Full-text search** across all folders using a Whoosh index — searches subject, from, to, and body with relevance ranking and body snippets
- **Attachment download** — click any attachment chip in the email detail pane to open or download it directly
- **Persistent header cache** — email list cache is saved to disk as `.cache.json` per folder, surviving pod restarts with no rebuild needed
- **Search index progress bar** — top bar shows indexing progress as a percentage with folder count while the Whoosh index builds on first startup
- **Bulk export** — two-stage export button: click once to build the zip on the PVC (with progress bar), then click Download Ready to stream it to your browser

## Features

- Syncs all Gmail labels to `.eml` files on a persistent volume
- Incremental sync — only fetches new emails on subsequent runs (state tracked per folder)
- 24-hour automatic sync schedule, with manual full sync and per-folder sync available from the UI
- Three-pane UI (folder list / email list / email detail) mimicking a traditional email client
- Virtual scrolling on the email list — handles folders with thousands of emails without lag
- Persistent disk-backed header cache — folders load instantly after the first access, survives pod restarts
- Full-text search across all folders via Whoosh index stored on the PVC
- Export any individual email as a `.eml` file directly from the UI
- Download email attachments directly from the detail pane
- Bulk export of all emails as a zip file, preserving folder structure
- HTML email rendering in a sandboxed iframe, with plaintext fallback
- IMAP modified UTF-7 encoding — correctly handles label names containing `&` (e.g. Work & Projects)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser                                                  │
│  ┌──────────────┬──────────────────┐                    │
│  │ Folder List  │ Email List       │  ← top 42%         │
│  ├──────────────┴──────────────────┤                    │
│  │ Email Detail (HTML rendered)    │  ← bottom 58%      │
│  └─────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────┐     ┌──────────────────────┐
│  Frontend (nginx)    │────▶│  Backend (FastAPI)    │
│  React SPA           │     │  IMAP sync engine     │
│  mailarchive-frontend│     │  Whoosh search index  │
└──────────────────────┘     │  APScheduler (24hr)   │
                             └──────────┬───────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  PVC 50Gi           │
                              │  /mail/             │
                              │    .sync_state.json │
                              │    .index/          │
                              │    INBOX/           │
                              │      *.eml          │
                              │      .cache.json    │
                              │    Work/            │
                              │    Personal/        │
                              │    ... (your labels)│
                              └─────────────────────┘
```

## Gmail Setup

Before deploying, you need a Gmail App Password:

1. Go to your Google Account → Security
2. Enable 2-Step Verification (required for app passwords)
3. Go to Security → App passwords
4. Create a new app password (name it "MailArchive")
5. Copy the 16-character password — you'll need it below

## Quick Start

### 1. Build and push images

```bash
# Backend
cd backend/
docker build -t your-registry/mailarchive-backend:latest .
docker push your-registry/mailarchive-backend:latest

# Frontend
cd ../frontend/
docker build -t your-registry/mailarchive-frontend:latest .
docker push your-registry/mailarchive-frontend:latest
```

### 2. Edit credentials

Edit `k8s/secret.yaml` with your Gmail address and app password:

```yaml
stringData:
  IMAP_USER: "yourname@gmail.com"
  IMAP_PASS: "xxxx xxxx xxxx xxxx"  # 16-char app password (spaces are fine)
```

### 3. Update image references

Edit `k8s/backend-deployment.yaml` and `k8s/frontend-deployment.yaml` and replace the image field:

```yaml
image: your-registry/mailarchive-backend:latest
image: your-registry/mailarchive-frontend:latest
```

### 4. Update ingress hostname

Edit `k8s/frontend-deployment.yaml`, find the Ingress section and set your hostname:

```yaml
host: mail.example.com
```

### 5. Deploy

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml
```

### 6. Verify

```bash
# Check all pods are running
kubectl get pods -n mailarchive

# Watch backend logs (first sync starts automatically if no state file exists)
kubectl logs -n mailarchive -l component=backend -f

# Check sync and index status
kubectl port-forward -n mailarchive svc/mailarchive-backend 8000:8000
curl http://localhost:8000/api/status
curl http://localhost:8000/api/search/status
```

## Configuration

All backend config is via environment variables in `k8s/backend-deployment.yaml`:

| Variable | Default | Description |
|---|---|---|
| `IMAP_HOST` | `imap.gmail.com` | IMAP server hostname |
| `IMAP_PORT` | `993` | IMAP SSL port |
| `IMAP_USER` | *(from secret)* | Gmail address |
| `IMAP_PASS` | *(from secret)* | 16-character app password |
| `MAIL_ROOT` | `/mail` | PVC mount path |
| `SYNC_INTERVAL_HOURS` | `24` | Hours between automatic syncs |

## Sync Behaviour

- **First run**: No `.sync_state.json` is present, so a full sync of all labels kicks off automatically on pod startup. This will take a while for large mailboxes — watch the logs.
- **Subsequent runs**: Only fetches emails with UIDs higher than the last seen UID per folder. Progress is saved after each folder completes, so a mid-sync pod restart won't lose work.
- **State file**: Stored at `/mail/.sync_state.json` on the PVC. Delete this file to force a full re-sync on next startup.
- **Manual full sync**: Click "Sync Now" in the top bar, or `POST /api/sync`.
- **Per-folder sync**: Hover over any folder in the sidebar and click the ⟳ icon to sync just that folder immediately, outside the normal 24-hour cycle.
- **During sync**: You can browse folders and read emails normally. The UI polls status every 3 seconds and updates folder counts as each label completes.

## Search

Search is powered by a Whoosh full-text index stored at `/mail/.index/` on the PVC.

- On first startup, a background thread walks all existing `.eml` files and indexes any not yet in the index. The top bar shows a progress bar while this runs.
- New emails are indexed immediately as they are downloaded during sync.
- The index persists across pod restarts — it only rebuilds entries that are missing.
- Search covers subject (2x boost), from (1.5x boost), to, and full body text.
- Whoosh query syntax is supported: `from:amazon receipt`, `subject:"order confirmation"`, `holiday OR travel`, `"exact phrase"`
- Results are displayed inline in the email list pane, replacing the folder view. Each result shows the source folder, date, from, subject, and a body snippet.
- Clear the search with Escape or the ✕ button to return to normal folder browsing.

To check index progress or document count:

```bash
kubectl exec -n mailarchive <pod-name> -- python3 -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/search/status').read().decode())"
```

## Caching

Each folder has a `.cache.json` file stored alongside its `.eml` files on the PVC. This contains the pre-sorted email header list (date, from, subject) used to populate the email list pane.

- Built on first access to a folder, then loaded from disk on all subsequent accesses including after pod restarts
- Invalidated automatically when a sync downloads new emails into that folder
- Eliminates the need to scan `.eml` headers on every folder open

## Bulk Export

The export feature builds a zip of all `.eml` files preserving the folder structure, then makes it available for download.

The export button has three states:

1. **⬇ Export All** (grey) — click to start building the zip on the PVC
2. **Preparing X%** (green progress bar) — zip is being built in the background, polling every 2 seconds
3. **⬇ Download Ready** (yellow) — zip is complete, click to download to your browser

The zip is stored as a temp file on the PVC (`/mail/.export-TIMESTAMP.zip`) and is cleaned up automatically at the start of the next export build. It remains available for download until then, so you can close the browser and come back.

The zip structure mirrors the PVC folder layout:
```
mailarchive-export-20260407-120000.zip
  INBOX/
    1_abc123.eml
    ...
  Work/
    ...
  Personal/
    ...
```

This format is directly importable into Thunderbird (via ImportExportTools NG), Apple Mail, or any IMAP client. See the **Importing Emails** section below.

## Importing Emails

The `.eml` format is universally supported. Options for importing into a new provider:

**Thunderbird** — install the ImportExportTools NG add-on, then use Tools → ImportExportTools NG → Import all messages from a directory. Point it at each folder from the zip.

**Apple Mail** — drag and drop `.eml` files onto a mailbox, or use File → Import Mailboxes.

**Any IMAP provider** — use a script with `imaplib` to `APPEND` each `.eml` back to the correct folder on the new server. This is the most universal approach and works with any provider.

**Convert to Mbox** — if your new provider prefers Mbox format, each folder's `.eml` files can be concatenated into a single `.mbox` file with a simple Python script.

## Storage Layout

```
/mail/
  .sync_state.json          ← last synced UID per folder
  .index/                   ← Whoosh full-text search index
  INBOX/
    .cache.json             ← persistent header cache for this folder
    1_abc123def456.eml
    2_fed654cba321.eml
    ...
  Work/
    .cache.json
    ...
  Work & Projects/          ← spaces and & in folder names are supported
    .cache.json
    ...
```

## Expanding the PVC

The PVC is provisioned at 50Gi with no explicit StorageClass set, so it will use your cluster's default. If you need more space, provided your StorageClass supports online expansion:

```bash
kubectl patch pvc mailarchive-pvc -n mailarchive \
  -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

## Redeploying Without Losing Sync Progress

Because all state is stored on the PVC, you can safely scale down, update the image, and scale back up:

```bash
kubectl scale deployment mailarchive-backend -n mailarchive --replicas=0
# push new image
kubectl scale deployment mailarchive-backend -n mailarchive --replicas=1
```

The new pod will read `.sync_state.json` from the PVC and continue from where it left off. The search index and all header caches are also preserved. No automatic sync is triggered on startup when the state file exists — use Sync Now if you want one immediately.

> Note: The deployment uses `strategy: Recreate` rather than `RollingUpdate` because RWO volumes can only be mounted by one pod at a time.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/status` | GET | Sync status, last run time, emails downloaded, index status |
| `POST /api/sync` | POST | Trigger a full sync of all folders |
| `POST /api/sync/folder/{folder}` | POST | Trigger immediate sync of a single folder |
| `GET /api/folders` | GET | List all folders with email counts |
| `GET /api/emails/{folder}` | GET | List emails in a folder (`?skip=0&limit=5000`) |
| `GET /api/email/{folder}/{filename}` | GET | Full email detail — body, headers, attachments |
| `GET /api/email/{folder}/{filename}/download` | GET | Download the raw `.eml` file |
| `GET /api/email/{folder}/{filename}/attachment/{index}` | GET | Download a specific attachment by index |
| `GET /api/search?q={query}` | GET | Full-text search across all folders |
| `GET /api/search/status` | GET | Search index document count and status |
| `POST /api/export/build` | POST | Start building the export zip in the background |
| `GET /api/export/status` | GET | Export build progress — state, folders done/total, size |
| `GET /api/export/download` | GET | Download the completed export zip |

## Adding or Removing Labels

Edit the `GMAIL_LABELS` list near the top of `backend/main.py`, then rebuild and push the backend image. New labels will have their folders created automatically on the next sync.

## Local Development

```bash
# Backend
cd backend/
pip install -r requirements.txt
IMAP_USER=you@gmail.com IMAP_PASS="xxxx xxxx xxxx xxxx" MAIL_ROOT=./mail python main.py

# Frontend (in a separate terminal)
cd frontend/
npm install
npm run dev   # Vite proxies /api calls to localhost:8000
```
