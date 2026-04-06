# MailArchive

A self-hosted Gmail archiver that syncs emails via IMAP to `.eml` files on a PVC, with a three-pane web UI. Runs on any Kubernetes cluster with persistent storage.

## Features

- Syncs all Gmail labels to `.eml` files on a persistent volume
- Incremental sync — only fetches new emails on subsequent runs (state tracked per folder)
- 24-hour automatic sync schedule, with manual full sync and per-folder sync available from the UI
- Three-pane UI (folder list / email list / email detail) mimicking a traditional email client
- Virtual scrolling on the email list — handles folders with thousands of emails without lag
- In-memory backend cache — folders load instantly after the first access
- Export any individual email as a `.eml` file directly from the UI
- HTML email rendering in a sandboxed iframe, with plaintext fallback
- Attachment detection and display (name, type, size)
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
│  mailarchive-frontend│     │  APScheduler (24hr)   │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  PVC 50Gi           │
                              │  /mail/             │
                              │    .sync_state.json │
                              │    INBOX/           │
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

# Check sync status via API
kubectl port-forward -n mailarchive svc/mailarchive-backend 8000:8000
curl http://localhost:8000/api/status
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

## Storage Layout

```
/mail/
  .sync_state.json          ← last synced UID per folder
  INBOX/
    1_abc123def456.eml
    2_fed654cba321.eml
    ...
  Work/
    ...
  Personal/
    ...
  Work & Projects/          ← spaces and & in folder names are supported
    ...
  (one directory per Gmail label)
```

## Caching

The backend maintains an in-memory cache of email header lists per folder. On first access, it reads the first 8KB of every `.eml` file (headers only) to extract date, from, and subject, then stores the sorted result in memory. Subsequent requests for the same folder are served instantly without any disk I/O.

The cache is invalidated automatically when:
- A full sync downloads new emails into a folder
- A per-folder sync completes with new emails

The cache does not persist across pod restarts — it rebuilds on first access per folder.

## Expanding the PVC

The PVC is provisioned at 50Gi with no explicit StorageClass set, so it will use your cluster's default. If you need more space, provided your StorageClass supports online expansion:

```bash
kubectl patch pvc mailarchive-pvc -n mailarchive \
  -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

## Redeploying Without Losing Sync Progress

Because sync state is stored on the PVC (not in pod memory), you can safely scale down, update the image, and scale back up:

```bash
kubectl scale deployment mailarchive-backend -n mailarchive --replicas=0
# push new image
kubectl scale deployment mailarchive-backend -n mailarchive --replicas=1
```

The new pod will read `.sync_state.json` from the PVC and continue from where it left off. It will not trigger a new automatic sync on startup (since the state file already exists) — use the Sync Now button if you want one immediately.

> Note: The deployment uses `strategy: Recreate` rather than `RollingUpdate` because RWO volumes can only be mounted by one pod at a time.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/status` | GET | Sync status, last run time, emails downloaded |
| `POST /api/sync` | POST | Trigger a full sync of all folders |
| `POST /api/sync/folder/{folder}` | POST | Trigger immediate sync of a single folder |
| `GET /api/folders` | GET | List all folders with email counts |
| `GET /api/emails/{folder}` | GET | List emails in a folder (`?skip=0&limit=5000`) |
| `GET /api/email/{folder}/{filename}` | GET | Full email detail — body, headers, attachments |
| `GET /api/email/{folder}/{filename}/download` | GET | Download the raw `.eml` file |

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
