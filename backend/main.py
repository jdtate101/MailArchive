import os
import json
import imaplib
import email
import hashlib
import logging
import base64
import threading
from pathlib import Path
from datetime import datetime
from typing import Optional
from email.header import decode_header, make_header

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from apscheduler.schedulers.background import BackgroundScheduler
import uvicorn

from whoosh import index as whoosh_index
from whoosh.fields import Schema, TEXT, ID, STORED, DATETIME
from whoosh.qparser import MultifieldParser, QueryParserError
from whoosh.writing import AsyncWriter
from whoosh import highlight

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Mail Archive API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
IMAP_USER = os.getenv("IMAP_USER", "")
IMAP_PASS = os.getenv("IMAP_PASS", "")
MAIL_ROOT = Path(os.getenv("MAIL_ROOT", "/mail"))
STATE_FILE = MAIL_ROOT / ".sync_state.json"
INDEX_DIR  = MAIL_ROOT / ".index"
SYNC_INTERVAL_HOURS = int(os.getenv("SYNC_INTERVAL_HOURS", "24"))

GMAIL_LABELS = [
    "INBOX",
    "Amazon", "Apple", "Cinema Tickets", "Divorce",
    "Ebay & Paypal", "Eshopping", "Fitness", "Friends & Family",
    "From Carolyn", "From Nicky", "Gaming", "General Mail",
    "House Pet & Car Stuff", "Job Stuff", "Notes", "Photography",
    "Politics", "Shirelands", "Travel & Holidays"
]

# ---------------------------------------------------------------------------
# Persistent header cache (in-memory + JSON on PVC)
# ---------------------------------------------------------------------------
_email_cache: dict = {}

def _cache_path(folder_name: str) -> Path:
    return MAIL_ROOT / folder_name / ".cache.json"


def _load_cache_from_disk(folder_name: str) -> list | None:
    """Load cached email list from disk if it exists. Returns None if not found."""
    path = _cache_path(folder_name)
    if path.exists():
        try:
            with open(path) as f:
                data = json.load(f)
            logger.info(f"Loaded cache from disk for '{folder_name}': {len(data)} emails")
            return data
        except Exception as e:
            logger.warning(f"Failed to read cache file for '{folder_name}': {e}")
    return None


def _save_cache_to_disk(folder_name: str, emails: list):
    """Persist the email list cache to disk."""
    path = _cache_path(folder_name)
    try:
        with open(path, "w") as f:
            json.dump(emails, f)
    except Exception as e:
        logger.warning(f"Failed to write cache file for '{folder_name}': {e}")


def _delete_cache_from_disk(folder_name: str):
    """Remove the on-disk cache file for a folder."""
    path = _cache_path(folder_name)
    if path.exists():
        try:
            path.unlink()
        except Exception as e:
            logger.warning(f"Failed to delete cache file for '{folder_name}': {e}")


def invalidate_cache(folder_name: str = None):
    global _email_cache
    if folder_name:
        _email_cache.pop(folder_name, None)
        _delete_cache_from_disk(folder_name)
        logger.info(f"Cache invalidated for folder: {folder_name}")
    else:
        _email_cache.clear()
        for label in GMAIL_LABELS:
            _delete_cache_from_disk(label_to_folder(label))
        logger.info("Full email cache invalidated")

# ---------------------------------------------------------------------------
# Whoosh search index
# ---------------------------------------------------------------------------
SEARCH_SCHEMA = Schema(
    doc_id   = ID(stored=True, unique=True),   # folder/filename
    folder   = ID(stored=True),
    filename = ID(stored=True),
    date     = STORED(),
    date_raw = STORED(),
    from_    = TEXT(stored=True, field_boost=2.0),
    to       = TEXT(stored=True),
    subject  = TEXT(stored=True, field_boost=1.5),
    body     = TEXT(stored=False),             # indexed but not stored (saves space)
)

_ix = None  # global index handle
_index_lock = threading.Lock()

def get_index():
    global _ix
    if _ix is not None:
        return _ix
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    if whoosh_index.exists_in(str(INDEX_DIR)):
        _ix = whoosh_index.open_dir(str(INDEX_DIR))
    else:
        _ix = whoosh_index.create_in(str(INDEX_DIR), SEARCH_SCHEMA)
        logger.info("Created new Whoosh index")
    return _ix


def extract_body_text(msg) -> str:
    """Extract plain text body from an email message for indexing."""
    parts = []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp  = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                continue
            if ctype == "text/plain":
                try:
                    parts.append(part.get_payload(decode=True).decode("utf-8", errors="replace"))
                except Exception:
                    pass
            elif ctype == "text/html" and not parts:
                # fallback: strip tags roughly for indexing only
                try:
                    raw = part.get_payload(decode=True).decode("utf-8", errors="replace")
                    import re
                    parts.append(re.sub(r"<[^>]+>", " ", raw))
                except Exception:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                parts.append(payload.decode("utf-8", errors="replace"))
        except Exception:
            pass
    return " ".join(parts)[:500_000]  # cap at 500KB of text per email


def index_email(writer, folder_name: str, eml_path: Path):
    """Index a single .eml file. Writer must be provided by caller."""
    try:
        with open(eml_path, "rb") as f:
            raw = f.read()
        msg = email.message_from_bytes(raw)

        date_str = msg.get("Date", "")
        try:
            parsed_date = email.utils.parsedate_to_datetime(date_str)
            iso_date = parsed_date.isoformat()
        except Exception:
            iso_date = date_str

        body_text = extract_body_text(msg)
        doc_id    = f"{folder_name}/{eml_path.name}"

        writer.update_document(
            doc_id   = doc_id,
            folder   = folder_name,
            filename = eml_path.name,
            date     = iso_date,
            date_raw = date_str,
            from_    = decode_str(msg.get("From", "")),
            to       = decode_str(msg.get("To", "")),
            subject  = decode_str(msg.get("Subject", "")),
            body     = body_text,
        )
    except Exception as e:
        logger.warning(f"Failed to index {eml_path}: {e}")


def build_index_background():
    """Walk all folders and index any .eml files not yet in the index.
    Runs in a background thread on startup."""
    logger.info("Starting background index build...")
    ix = get_index()
    indexed = set()

    # Collect already-indexed doc_ids
    with ix.searcher() as searcher:
        for fields in searcher.all_stored_fields():
            indexed.add(fields.get("doc_id", ""))

    # Count how many folders actually need indexing
    folders_to_index = []
    for label in GMAIL_LABELS:
        folder_name = label_to_folder(label)
        folder_path = MAIL_ROOT / folder_name
        if not folder_path.exists():
            continue
        to_index = [f for f in folder_path.glob("*.eml")
                    if f"{folder_name}/{f.name}" not in indexed]
        if to_index:
            folders_to_index.append((label, folder_name, to_index))

    total = len(folders_to_index)
    sync_status["index_folders_total"] = total if total > 0 else len(GMAIL_LABELS)
    sync_status["index_folders_done"] = 0

    if not folders_to_index:
        logger.info("Index already up to date — nothing to index")
        return

    new_count = 0
    for i, (label, folder_name, to_index) in enumerate(folders_to_index):
        with _index_lock:
            writer = AsyncWriter(ix)
            for eml_path in to_index:
                index_email(writer, folder_name, eml_path)
                new_count += 1
            writer.commit()

        sync_status["index_folders_done"] = i + 1
        logger.info(f"Indexed {len(to_index)} emails in {folder_name} ({i+1}/{total})")

    logger.info(f"Index build complete — {new_count} new documents added")


def index_new_emails(folder_name: str, eml_paths: list):
    """Index a batch of newly downloaded emails. Called during sync."""
    if not eml_paths:
        return
    ix = get_index()
    with _index_lock:
        writer = AsyncWriter(ix)
        for eml_path in eml_paths:
            index_email(writer, folder_name, eml_path)
        writer.commit()
    logger.info(f"Indexed {len(eml_paths)} new emails in {folder_name}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
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
    return label.replace("/", "_").strip()


def encode_imap_utf7(label: str) -> str:
    if label == "INBOX":
        return "INBOX"
    result = []
    for c in label:
        if 0x20 <= ord(c) <= 0x7e and c != '&':
            result.append(c)
        else:
            encoded = c.encode("utf-16-be")
            b64 = base64.b64encode(encoded).decode("ascii").rstrip("=")
            result.append(f"&{b64}-")
    return "".join(result)


def folder_to_imap(label: str) -> str:
    if label == "INBOX":
        return "INBOX"
    return f'"{encode_imap_utf7(label)}"'


def get_eml_filename(uid: str, msg_id: str) -> str:
    safe_id = hashlib.md5(msg_id.encode()).hexdigest()[:12] if msg_id else uid
    return f"{uid}_{safe_id}.eml"


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
sync_status = {
    "running": False,
    "last_run": None,
    "last_result": None,
    "folders_synced": 0,
    "emails_downloaded": 0,
    "index_status": "idle",
    "index_folders_done": 0,
    "index_folders_total": len(GMAIL_LABELS),
}


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
    if last_uid == "0":
        status, data = imap.search(None, "ALL")
    else:
        status, data = imap.search(None, f"UID {int(last_uid)+1}:*")

    if status != "OK" or not data[0]:
        return 0

    uids = data[0].split()
    if not uids:
        return 0

    downloaded  = 0
    max_uid     = int(last_uid)
    new_paths   = []

    for uid in uids:
        uid_str = uid.decode()
        try:
            status, msg_data = imap.fetch(uid_str, "(RFC822)")
            if status != "OK":
                continue
            raw_email = msg_data[0][1]
            msg       = email.message_from_bytes(raw_email)
            msg_id    = msg.get("Message-ID", uid_str)
            filename  = get_eml_filename(uid_str, msg_id)
            eml_path  = folder_path / filename

            if not eml_path.exists():
                with open(eml_path, "wb") as f:
                    f.write(raw_email)
                new_paths.append(eml_path)
                downloaded += 1
                logger.info(f"Downloaded {label}/{filename}")

            max_uid = max(max_uid, int(uid_str))
        except Exception as e:
            logger.error(f"Error fetching UID {uid_str} from {label}: {e}")

    state[label] = str(max_uid)

    # Index newly downloaded emails
    if new_paths:
        index_new_emails(folder_name, new_paths)

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


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/api/status")
def get_status():
    return sync_status


@app.post("/api/sync")
def trigger_sync(background_tasks: BackgroundTasks):
    if sync_status["running"]:
        raise HTTPException(status_code=409, detail="Sync already running")
    background_tasks.add_task(run_sync)
    return {"message": "Sync started"}


@app.post("/api/sync/folder/{folder_name}")
def sync_single_folder(folder_name: str, background_tasks: BackgroundTasks):
    label = next((l for l in GMAIL_LABELS if label_to_folder(l) == folder_name), None)
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

    # 1. Check in-memory cache
    if folder in _email_cache:
        cached = _email_cache[folder]
        return {"total": len(cached), "emails": cached[skip:skip + limit], "cached": True}

    # 2. Check on-disk cache
    cached = _load_cache_from_disk(folder)
    if cached is not None:
        _email_cache[folder] = cached
        return {"total": len(cached), "emails": cached[skip:skip + limit], "cached": True}

    # 3. Build from .eml headers, save to memory and disk
    emails = []
    for eml_file in folder_path.glob("*.eml"):
        try:
            with open(eml_file, "rb") as f:
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

    emails.sort(key=lambda x: x["date"], reverse=True)
    _email_cache[folder] = emails
    _save_cache_to_disk(folder, emails)
    logger.info(f"Cache built and saved for folder '{folder}': {len(emails)} emails")
    return {"total": len(emails), "emails": emails[skip:skip + limit], "cached": False}


@app.get("/api/search")
def search_emails(q: str = Query(..., min_length=1), limit: int = 100):
    """Full-text search across all folders using the Whoosh index."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    ix = get_index()
    results = []

    try:
        with ix.searcher() as searcher:
            parser = MultifieldParser(
                ["subject", "from_", "to", "body"],
                schema=ix.schema,
                fieldboosts={"subject": 2.0, "from_": 1.5, "to": 1.0, "body": 1.0},
            )
            try:
                query = parser.parse(q)
            except QueryParserError:
                # Fall back to treating the query as a literal phrase
                query = parser.parse(f'"{q}"')

            fragmenter = highlight.ContextFragmenter(maxchars=200, surround=40)
            formatter  = highlight.UppercaseFormatter()

            hits = searcher.search(query, limit=limit)
            hits.fragmenter = fragmenter
            hits.formatter  = formatter

            for hit in hits:
                snippet = ""
                try:
                    # Re-open the file to highlight body text
                    eml_path = MAIL_ROOT / hit["folder"] / hit["filename"]
                    if eml_path.exists():
                        with open(eml_path, "rb") as f:
                            raw = f.read()
                        msg       = email.message_from_bytes(raw)
                        body_text = extract_body_text(msg)
                        snippet   = hit.highlights("body", text=body_text) or ""
                except Exception:
                    pass

                results.append({
                    "folder":   hit["folder"],
                    "filename": hit["filename"],
                    "id":       Path(hit["filename"]).stem,
                    "from":     hit.get("from_", ""),
                    "to":       hit.get("to", ""),
                    "subject":  hit.get("subject", ""),
                    "date":     hit.get("date", ""),
                    "snippet":  snippet,
                    "score":    hit.score,
                })
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

    return {"total": len(results), "query": q, "results": sorted(results, key=lambda x: x["date"], reverse=True)}


@app.get("/api/search/status")
def search_index_status():
    """Return info about the current state of the search index."""
    ix = get_index()
    with ix.searcher() as searcher:
        doc_count = searcher.doc_count()
    return {
        "indexed_documents": doc_count,
        "index_dir": str(INDEX_DIR),
        "index_exists": whoosh_index.exists_in(str(INDEX_DIR)),
    }


# ---------------------------------------------------------------------------
# Export state
# ---------------------------------------------------------------------------
export_status = {
    "state":           "idle",   # idle | building | ready | error
    "folders_done":    0,
    "folders_total":   len(GMAIL_LABELS),
    "current_folder":  "",
    "file_count":      0,
    "size_mb":         0,
    "error":           "",
    "filename":        "",
    "zip_path":        "",
}


def _cleanup_old_export():
    """Delete any previously built export zip from the PVC."""
    if export_status["zip_path"] and Path(export_status["zip_path"]).exists():
        try:
            Path(export_status["zip_path"]).unlink()
            logger.info(f"Cleaned up previous export zip: {export_status['zip_path']}")
        except Exception as e:
            logger.warning(f"Could not remove previous export zip: {e}")
    # Also sweep for any stale files in case of missed cleanup
    for stale in MAIL_ROOT.glob(".export-*.zip"):
        try:
            stale.unlink()
        except Exception:
            pass


def _build_zip_thread():
    """Runs in a background thread. Builds the zip and updates export_status."""
    import zipfile

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    tmp_path  = MAIL_ROOT / f".export-{timestamp}.zip"
    filename  = f"mailarchive-export-{timestamp}.zip"

    export_status["zip_path"]       = str(tmp_path)
    export_status["filename"]       = filename
    export_status["folders_done"]   = 0
    export_status["file_count"]     = 0
    export_status["size_mb"]        = 0
    export_status["current_folder"] = ""
    export_status["error"]          = ""

    # Count folders that actually exist
    existing = [l for l in GMAIL_LABELS if (MAIL_ROOT / label_to_folder(l)).exists()]
    export_status["folders_total"] = len(existing)

    file_count = 0
    try:
        with zipfile.ZipFile(str(tmp_path), mode="w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for i, label in enumerate(existing):
                folder_name = label_to_folder(label)
                folder_path = MAIL_ROOT / folder_name
                export_status["current_folder"] = label
                eml_files = sorted(folder_path.glob("*.eml"))
                logger.info(f"Exporting {len(eml_files)} emails from {folder_name}")
                for eml_file in eml_files:
                    arc_name = f"{folder_name}/{eml_file.name}"
                    try:
                        zf.write(str(eml_file), arcname=arc_name)
                        file_count += 1
                    except Exception as e:
                        logger.warning(f"Skipping {arc_name}: {e}")
                export_status["folders_done"] = i + 1

        size_mb = tmp_path.stat().st_size // 1024 // 1024
        export_status["file_count"]  = file_count
        export_status["size_mb"]     = size_mb
        export_status["state"]       = "ready"
        export_status["current_folder"] = ""
        logger.info(f"Export zip ready: {file_count} files, {size_mb}MB")

    except Exception as e:
        logger.error(f"Export zip build failed: {e}", exc_info=True)
        export_status["state"] = "error"
        export_status["error"] = str(e)
        if tmp_path.exists():
            tmp_path.unlink()


@app.post("/api/export/build")
def start_export_build():
    """Kick off a background zip build. Cleans up any previous export first."""
    if export_status["state"] == "building":
        raise HTTPException(status_code=409, detail="Export already in progress")
    _cleanup_old_export()
    export_status["state"] = "building"
    threading.Thread(target=_build_zip_thread, daemon=True).start()
    return {"message": "Export build started"}


@app.get("/api/export/status")
def get_export_status():
    """Return current export build progress."""
    return {
        "state":          export_status["state"],
        "folders_done":   export_status["folders_done"],
        "folders_total":  export_status["folders_total"],
        "current_folder": export_status["current_folder"],
        "file_count":     export_status["file_count"],
        "size_mb":        export_status["size_mb"],
        "filename":       export_status["filename"],
        "error":          export_status["error"],
    }


@app.get("/api/export/download")
def download_export():
    """Stream the completed zip. Only works when state is ready."""
    from fastapi.responses import FileResponse
    if export_status["state"] != "ready":
        raise HTTPException(status_code=409, detail="Export not ready")
    zip_path = Path(export_status["zip_path"])
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="Export file not found")
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=export_status["filename"],
    )


@app.get("/api/email/{folder}/{filename}/download")
def download_email(folder: str, filename: str):
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


@app.get("/api/email/{folder}/{filename}/attachment/{att_index}")
def download_attachment(folder: str, filename: str, att_index: int):
    """Extract and stream a single attachment from an .eml file by its index."""
    eml_path = MAIL_ROOT / folder / filename
    if not eml_path.exists():
        raise HTTPException(status_code=404, detail="Email not found")

    with open(eml_path, "rb") as f:
        raw = f.read()

    msg = email.message_from_bytes(raw)

    if not msg.is_multipart():
        raise HTTPException(status_code=404, detail="Email has no attachments")

    current = 0
    for part in msg.walk():
        disp = str(part.get("Content-Disposition", ""))
        if "attachment" not in disp:
            continue
        if current == att_index:
            payload = part.get_payload(decode=True)
            if payload is None:
                raise HTTPException(status_code=500, detail="Could not decode attachment")

            fname = decode_str(part.get_filename()) or f"attachment_{att_index}"
            ctype = part.get_content_type() or "application/octet-stream"

            from fastapi.responses import Response
            # Use inline disposition for types the browser can display (PDF, images)
            # so the browser offers open vs save. Force download for everything else.
            openable = ctype.startswith("image/") or ctype == "application/pdf" or ctype.startswith("text/")
            disposition = f'inline; filename="{fname}"' if openable else f'attachment; filename="{fname}"'

            return Response(
                content=payload,
                media_type=ctype,
                headers={"Content-Disposition": disposition},
            )
        current += 1

    raise HTTPException(status_code=404, detail=f"Attachment index {att_index} not found")


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
        att_index = 0
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                disp  = str(part.get("Content-Disposition", ""))
                if "attachment" in disp:
                    fname = part.get_filename()
                    attachments.append({
                        "index": att_index,
                        "filename": decode_str(fname) if fname else "attachment",
                        "content_type": ctype,
                        "size": len(part.get_payload(decode=True) or b""),
                    })
                    att_index += 1
                elif ctype == "text/html" and body_html is None:
                    body_html = part.get_payload(decode=True).decode("utf-8", errors="replace")
                elif ctype == "text/plain" and body_text is None:
                    body_text = part.get_payload(decode=True).decode("utf-8", errors="replace")
        else:
            ctype   = msg.get_content_type()
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
        "id":          eml_path.stem,
        "from":        decode_str(msg.get("From", "")),
        "to":          decode_str(msg.get("To", "")),
        "cc":          decode_str(msg.get("Cc", "")),
        "subject":     decode_str(msg.get("Subject", "(No Subject)")),
        "date":        iso_date,
        "date_raw":    date_str,
        "body_html":   body_html,
        "body_text":   body_text,
        "attachments": attachments,
    }


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
@app.on_event("startup")
def startup_event():
    MAIL_ROOT.mkdir(parents=True, exist_ok=True)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)

    # Initialise index
    get_index()

    # Background index build for any emails already on disk but not yet indexed
    sync_status["index_status"] = "building"
    def _build():
        build_index_background()
        sync_status["index_status"] = "ready"
    threading.Thread(target=_build, daemon=True).start()

    # Scheduler for 24hr sync
    scheduler = BackgroundScheduler()
    scheduler.add_job(run_sync, "interval", hours=SYNC_INTERVAL_HOURS, id="sync_job")
    scheduler.start()

    # Initial full sync if no state file
    if not STATE_FILE.exists():
        logger.info("No state file found, triggering initial full sync")
        threading.Thread(target=run_sync, daemon=True).start()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
