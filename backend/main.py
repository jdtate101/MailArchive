import os
import json
import imaplib
import email
import hashlib
import logging
import base64
from pathlib import Path
from datetime import datetime
from typing import Optional
from email.header import decode_header, make_header

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from apscheduler.schedulers.background import BackgroundScheduler
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Mail Archive API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache: folder_name -> {"emails": [...], "built_at": datetime}
_email_cache: dict = {}

def invalidate_cache(folder_name: str = None):
    """Invalidate cache for a specific folder, or all folders if None."""
    global _email_cache
    if folder_name:
        _email_cache.pop(folder_name, None)
        logger.info(f"Cache invalidated for folder: {folder_name}")
    else:
        _email_cache.clear()
        logger.info("Full email cache invalidated")

# Config from env
IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
IMAP_USER = os.getenv("IMAP_USER", "")
IMAP_PASS = os.getenv("IMAP_PASS", "")
MAIL_ROOT = Path(os.getenv("MAIL_ROOT", "/mail"))
STATE_FILE = MAIL_ROOT / ".sync_state.json"
SYNC_INTERVAL_HOURS = int(os.getenv("SYNC_INTERVAL_HOURS", "24"))

GMAIL_LABELS = [
    "INBOX",
    "Amazon", "Apple", "Cinema Tickets", "Divorce",
    "Ebay & Paypal", "Eshopping", "Fitness", "Friends & Family",
    "From Carolyn", "From Nicky", "Gaming", "General Mail",
    "House Pet & Car Stuff", "Job Stuff", "Notes", "Photography",
    "Politics", "Shirelands", "Travel & Holidays"
]

sync_status = {
    "running": False,
    "last_run": None,
    "last_result": None,
    "folders_synced": 0,
    "emails_downloaded": 0,
}


def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state: dict):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def decode_str(s) -> str:
    if s is None:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return str(s)


def label_to_folder(label: str) -> str:
    """Convert Gmail label to safe filesystem folder name."""
    return label.replace("/", "_").strip()


def encode_imap_utf7(label: str) -> str:
    """Encode a label name to IMAP modified UTF-7 as required by RFC 3501.
    Gmail encodes special characters (& etc) using this scheme."""
    if label == "INBOX":
        return "INBOX"
    result = []
    i = 0
    while i < len(label):
        c = label[i]
        if 0x20 <= ord(c) <= 0x7e and c != '&':
            result.append(c)
        else:
            # Encode non-ASCII or & in modified UTF-7
            encoded = c.encode("utf-16-be")
            b64 = base64.b64encode(encoded).decode("ascii").rstrip("=")
            result.append(f"&{b64}-")
        i += 1
    return "".join(result)


def folder_to_imap(label: str) -> str:
    """Convert label to quoted IMAP folder name with modified UTF-7 encoding."""
    if label == "INBOX":
        return "INBOX"
    encoded = encode_imap_utf7(label)
    return f'"{encoded}"'


def get_eml_filename(uid: str, msg_id: str) -> str:
    safe_id = hashlib.md5(msg_id.encode()).hexdigest()[:12] if msg_id else uid
    return f"{uid}_{safe_id}.eml"


def sync_folder(imap: imaplib.IMAP4_SSL, label: str, state: dict) -> int:
    folder_name = label_to_folder(label)
    folder_path = MAIL_ROOT / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)

    imap_folder = folder_to_imap(label)
    try:
        status, data = imap.select(imap_folder, readonly=True)
        if status != "OK":
            logger.warning(f"Could not select folder {label}: {data}")
            return 0
    except Exception as e:
        logger.warning(f"Error selecting folder {label}: {e}")
        return 0

    last_uid = state.get(label, "0")

    # Search for emails newer than last synced UID
    if last_uid == "0":
        status, data = imap.search(None, "ALL")
    else:
        status, data = imap.search(None, f"UID {int(last_uid)+1}:*")

    if status != "OK" or not data[0]:
        return 0

    uids = data[0].split()
    if not uids:
        return 0

    downloaded = 0
    max_uid = int(last_uid)

    for uid in uids:
        uid_str = uid.decode()
        try:
            status, msg_data = imap.fetch(uid_str, "(RFC822)")
            if status != "OK":
                continue

            raw_email = msg_data[0][1]
            msg = email.message_from_bytes(raw_email)
            msg_id = msg.get("Message-ID", uid_str)
            filename = get_eml_filename(uid_str, msg_id)
            eml_path = folder_path / filename

            if not eml_path.exists():
                with open(eml_path, "wb") as f:
                    f.write(raw_email)
                downloaded += 1
                logger.info(f"Downloaded {label}/{filename}")

            max_uid = max(max_uid, int(uid_str))
        except Exception as e:
            logger.error(f"Error fetching UID {uid_str} from {label}: {e}")

    state[label] = str(max_uid)
    return downloaded


def run_sync():
    global sync_status
    if sync_status["running"]:
        logger.info("Sync already running, skipping")
        return

    sync_status["running"] = True
    sync_status["last_run"] = datetime.utcnow().isoformat()
    sync_status["emails_downloaded"] = 0
    sync_status["folders_synced"] = 0

    try:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        imap.login(IMAP_USER, IMAP_PASS)
        state = load_state()
        total = 0

        for label in GMAIL_LABELS:
            count = sync_folder(imap, label, state)
            total += count
            sync_status["folders_synced"] += 1
            save_state(state)
            if count > 0:
                invalidate_cache(label_to_folder(label))

        imap.logout()
        sync_status["emails_downloaded"] = total
        sync_status["last_result"] = "success"
        logger.info(f"Sync complete: {total} emails downloaded")
    except Exception as e:
        sync_status["last_result"] = f"error: {str(e)}"
        logger.error(f"Sync failed: {e}")
    finally:
        sync_status["running"] = False


# --- API Routes ---

@app.get("/api/status")
def get_status():
    return sync_status


@app.post("/api/sync")
def trigger_sync(background_tasks: BackgroundTasks):
    if sync_status["running"]:
        raise HTTPException(status_code=409, detail="Sync already running")
    background_tasks.add_task(run_sync)
    return {"message": "Sync started"}


@app.get("/api/folders")
def list_folders():
    folders = []
    for label in GMAIL_LABELS:
        folder_name = label_to_folder(label)
        folder_path = MAIL_ROOT / folder_name
        count = len(list(folder_path.glob("*.eml"))) if folder_path.exists() else 0
        folders.append({"name": label, "folder": folder_name, "count": count})
    return folders


@app.get("/api/emails/{folder}")
def list_emails(folder: str, skip: int = 0, limit: int = 5000):
    folder_path = MAIL_ROOT / folder
    if not folder_path.exists():
        raise HTTPException(status_code=404, detail="Folder not found")

    # Serve from cache if available
    if folder in _email_cache:
        cached = _email_cache[folder]
        total = len(cached)
        return {"total": total, "emails": cached[skip:skip + limit], "cached": True}

    # Build the list by reading email headers from disk
    emails = []
    for eml_file in folder_path.glob("*.eml"):
        try:
            with open(eml_file, "rb") as f:
                # Only read first 8KB — enough to get headers without loading full body
                raw = f.read(8192)
            msg = email.message_from_bytes(raw)

            date_str = msg.get("Date", "")
            try:
                parsed_date = email.utils.parsedate_to_datetime(date_str)
                iso_date = parsed_date.isoformat()
            except Exception:
                iso_date = date_str

            emails.append({
                "id": eml_file.stem,
                "filename": eml_file.name,
                "from": decode_str(msg.get("From", "")),
                "subject": decode_str(msg.get("Subject", "(No Subject)")),
                "date": iso_date,
                "date_raw": date_str,
            })
        except Exception as e:
            logger.warning(f"Error reading {eml_file}: {e}")

    # Sort by date descending and store in cache
    emails.sort(key=lambda x: x["date"], reverse=True)
    _email_cache[folder] = emails
    logger.info(f"Cache built for folder '{folder}': {len(emails)} emails")

    total = len(emails)
    return {"total": total, "emails": emails[skip:skip + limit], "cached": False}


@app.get("/api/email/{folder}/{filename}/download")
def download_email(folder: str, filename: str):
    """Download an individual email as a .eml file."""
    eml_path = MAIL_ROOT / folder / filename
    if not eml_path.exists():
        raise HTTPException(status_code=404, detail="Email not found")
    from fastapi.responses import FileResponse
    return FileResponse(
        path=eml_path,
        media_type="message/rfc822",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/sync/folder/{folder_name}")
def sync_single_folder(folder_name: str, background_tasks: BackgroundTasks):
    """Trigger an immediate sync of a single folder by its filesystem name."""
    # Find the matching label
    label = next(
        (l for l in GMAIL_LABELS if label_to_folder(l) == folder_name),
        None
    )
    if label is None:
        raise HTTPException(status_code=404, detail=f"Folder '{folder_name}' not found")
    if sync_status["running"]:
        raise HTTPException(status_code=409, detail="A full sync is already running")

    def _sync_one():
        global sync_status
        sync_status["running"] = True
        sync_status["last_run"] = datetime.utcnow().isoformat()
        try:
            imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
            imap.login(IMAP_USER, IMAP_PASS)
            state = load_state()
            count = sync_folder(imap, label, state)
            save_state(state)
            imap.logout()
            if count > 0:
                invalidate_cache(label_to_folder(label))
            sync_status["emails_downloaded"] = count
            sync_status["last_result"] = f"success (folder: {label})"
            logger.info(f"Single folder sync complete: {label}, {count} emails")
        except Exception as e:
            sync_status["last_result"] = f"error: {str(e)}"
            logger.error(f"Single folder sync failed: {e}")
        finally:
            sync_status["running"] = False

    background_tasks.add_task(_sync_one)
    return {"message": f"Sync started for folder: {label}"}


@app.get("/api/email/{folder}/{filename}")
def get_email(folder: str, filename: str):
    eml_path = MAIL_ROOT / folder / filename
    if not eml_path.exists():
        raise HTTPException(status_code=404, detail="Email not found")

    with open(eml_path, "rb") as f:
        raw = f.read()

    msg = email.message_from_bytes(raw)

    def get_body(msg):
        body_html = None
        body_text = None
        attachments = []

        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                disp = str(part.get("Content-Disposition", ""))
                if "attachment" in disp:
                    fname = part.get_filename()
                    attachments.append({
                        "filename": decode_str(fname) if fname else "attachment",
                        "content_type": ctype,
                        "size": len(part.get_payload(decode=True) or b""),
                    })
                elif ctype == "text/html" and body_html is None:
                    body_html = part.get_payload(decode=True).decode("utf-8", errors="replace")
                elif ctype == "text/plain" and body_text is None:
                    body_text = part.get_payload(decode=True).decode("utf-8", errors="replace")
        else:
            ctype = msg.get_content_type()
            payload = msg.get_payload(decode=True)
            if payload:
                decoded = payload.decode("utf-8", errors="replace")
                if ctype == "text/html":
                    body_html = decoded
                else:
                    body_text = decoded

        return body_html, body_text, attachments

    body_html, body_text, attachments = get_body(msg)

    date_str = msg.get("Date", "")
    try:
        parsed_date = email.utils.parsedate_to_datetime(date_str)
        iso_date = parsed_date.isoformat()
    except Exception:
        iso_date = date_str

    return {
        "id": eml_path.stem,
        "from": decode_str(msg.get("From", "")),
        "to": decode_str(msg.get("To", "")),
        "cc": decode_str(msg.get("Cc", "")),
        "subject": decode_str(msg.get("Subject", "(No Subject)")),
        "date": iso_date,
        "date_raw": date_str,
        "body_html": body_html,
        "body_text": body_text,
        "attachments": attachments,
    }


# Start scheduler on boot
@app.on_event("startup")
def startup_event():
    MAIL_ROOT.mkdir(parents=True, exist_ok=True)
    scheduler = BackgroundScheduler()
    scheduler.add_job(run_sync, "interval", hours=SYNC_INTERVAL_HOURS, id="sync_job")
    scheduler.start()
    # Run initial sync if state file doesn't exist
    if not STATE_FILE.exists():
        logger.info("No state file found, triggering initial full sync")
        import threading
        threading.Thread(target=run_sync, daemon=True).start()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
