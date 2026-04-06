# MailArchive

A self-hosted Gmail archiver that syncs emails via IMAP to `.eml` files on a PVC, with a three-pane web UI. Runs on RKE2/Kubernetes with Longhorn storage.

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
│  mailarchive-frontend│     │  mailarchive-backend  │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  Longhorn PVC 50Gi  │
                              │  /mail/             │
                              │    INBOX/           │
                              │    Amazon/          │
                              │    Apple/           │
                              │    ... (19 labels)  │
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

> Replace `your-registry` with your Harbor instance (you're running Harbor on the cluster).

### 2. Edit credentials

Edit `k8s/secret.yaml` with your Gmail address and app password:

```yaml
stringData:
  IMAP_USER: "yourname@gmail.com"
  IMAP_PASS: "xxxx xxxx xxxx xxxx"  # 16-char app password (spaces OK)
```

### 3. Update image references

Edit `k8s/backend-deployment.yaml` and `k8s/frontend-deployment.yaml`:
```yaml
image: your-registry/mailarchive-backend:latest
image: your-registry/mailarchive-frontend:latest
```

### 4. Update ingress hostname

Edit `k8s/frontend-deployment.yaml`, find the Ingress section:
```yaml
host: mail.home  # Change to match your Pi-hole .home TLD setup
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

# Watch backend logs (first sync will start automatically)
kubectl logs -n mailarchive -l component=backend -f

# Check sync status via API
kubectl port-forward -n mailarchive svc/mailarchive-backend 8000:8000
curl http://localhost:8000/api/status
```

## Configuration

All backend config is via environment variables in `k8s/backend-deployment.yaml`:

| Variable | Default | Description |
|---|---|---|
| `IMAP_HOST` | `imap.gmail.com` | IMAP server |
| `IMAP_PORT` | `993` | IMAP SSL port |
| `IMAP_USER` | *(from secret)* | Gmail address |
| `IMAP_PASS` | *(from secret)* | App password |
| `MAIL_ROOT` | `/mail` | PVC mount path |
| `SYNC_INTERVAL_HOURS` | `24` | Hours between syncs |

## Sync Behaviour

- **First run**: Full sync of all 19 labels + INBOX. This may take a while for large mailboxes.
- **Subsequent runs**: Only fetches emails with UIDs higher than the last seen UID per folder.
- **State file**: Stored at `/mail/.sync_state.json` on the PVC. Delete this file to force a full re-sync.
- **Manual sync**: Hit the "Sync Now" button in the UI, or `POST /api/sync`.

## Storage Layout

```
/mail/
  .sync_state.json          ← sync state (last UID per folder)
  INBOX/
    1_abc123def456.eml
    2_fed654cba321.eml
    ...
  Amazon/
    ...
  Ebay & Paypal/
    ...
  (one folder per Gmail label)
```

## Expanding the PVC

If you need more space:

```bash
kubectl patch pvc mailarchive-pvc -n mailarchive \
  -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

Longhorn will handle the expansion online without downtime.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Sync status and stats |
| `/api/sync` | POST | Trigger manual sync |
| `/api/folders` | GET | List all folders with email counts |
| `/api/emails/{folder}` | GET | List emails in folder (`?skip=0&limit=200`) |
| `/api/email/{folder}/{filename}` | GET | Full email detail with body and attachments |

## Adding/Removing Labels

Edit the `GMAIL_LABELS` list in `backend/main.py` and rebuild the backend image. New labels will be created as folders on the next sync.

## Local Development

```bash
# Backend
cd backend/
pip install -r requirements.txt
IMAP_USER=you@gmail.com IMAP_PASS=yourapppass MAIL_ROOT=./mail python main.py

# Frontend (separate terminal)
cd frontend/
npm install
npm run dev   # Proxies /api to localhost:8000
```
