import { useState, useEffect, useCallback, useRef } from "react";

const API = import.meta.env.VITE_API_URL || "/api";

const formatDate = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
};

const formatFromName = (from) => {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from.split("@")[0];
};

function SyncBar({ status, onSync }) {
  return (
    <div className="sync-bar">
      <div className="sync-bar-left">
        <span className="app-title">✉ MailArchive</span>
        {status && (
          <span className="sync-info">
            {status.running ? (
              <span className="sync-running">⟳ Syncing… ({status.folders_synced} folders)</span>
            ) : (
              <span className="sync-idle">
                Last sync: {status.last_run ? formatDate(status.last_run) : "Never"}
                {status.last_result === "success" && ` · ${status.emails_downloaded} downloaded`}
                {status.last_result?.startsWith("error") && (
                  <span className="sync-error"> · ⚠ {status.last_result}</span>
                )}
              </span>
            )}
          </span>
        )}
      </div>
      <button
        className={`sync-btn ${status?.running ? "disabled" : ""}`}
        onClick={onSync}
        disabled={status?.running}
      >
        {status?.running ? "Syncing…" : "Sync Now"}
      </button>
    </div>
  );
}

function FolderPane({ folders, selected, onSelect }) {
  return (
    <div className="folder-pane">
      <div className="pane-header">Folders</div>
      <div className="folder-list">
        {folders.map((f) => (
          <button
            key={f.folder}
            className={`folder-item ${selected === f.folder ? "active" : ""}`}
            onClick={() => onSelect(f)}
          >
            <span className="folder-icon">
              {f.folder === "INBOX" ? "📥" : "📁"}
            </span>
            <span className="folder-name">{f.name}</span>
            {f.count > 0 && (
              <span className="folder-count">{f.count.toLocaleString()}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmailList({ emails, total, selected, onSelect, loading, folder }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [folder]);

  return (
    <div className="email-list-pane">
      <div className="pane-header">
        {folder ? (
          <>{folder} <span className="count-badge">{total.toLocaleString()}</span></>
        ) : "Emails"}
      </div>
      <div className="email-list" ref={listRef}>
        {loading && <div className="loading-state">Loading…</div>}
        {!loading && emails.length === 0 && (
          <div className="empty-state">No emails in this folder</div>
        )}
        {emails.map((e) => (
          <button
            key={e.id}
            className={`email-item ${selected?.id === e.id ? "active" : ""}`}
            onClick={() => onSelect(e)}
          >
            <div className="email-item-top">
              <span className="email-from">{formatFromName(e.from)}</span>
              <span className="email-date">{formatDate(e.date)}</span>
            </div>
            <div className="email-subject">{e.subject}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmailDetail({ email: em, folder, loading }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!iframeRef.current || !em?.body_html) return;
    const doc = iframeRef.current.contentDocument;
    doc.open();
    doc.write(`
      <html><head><style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
               font-size: 14px; line-height: 1.6; color: #1a1a2e; padding: 16px;
               margin: 0; word-wrap: break-word; }
        img { max-width: 100%; height: auto; }
        a { color: #4f46e5; }
        pre { white-space: pre-wrap; word-break: break-all; }
      </style></head><body>${em.body_html}</body></html>
    `);
    doc.close();
  }, [em?.body_html]);

  if (loading) {
    return (
      <div className="email-detail-pane">
        <div className="detail-empty">Loading email…</div>
      </div>
    );
  }

  if (!em) {
    return (
      <div className="email-detail-pane">
        <div className="detail-empty">
          <div className="detail-empty-icon">✉</div>
          <div>Select an email to read it</div>
        </div>
      </div>
    );
  }

  return (
    <div className="email-detail-pane">
      <div className="detail-header">
        <div className="detail-subject">{em.subject}</div>
        <div className="detail-meta">
          <div className="meta-row"><span className="meta-label">From</span><span className="meta-value">{em.from}</span></div>
          <div className="meta-row"><span className="meta-label">To</span><span className="meta-value">{em.to}</span></div>
          {em.cc && <div className="meta-row"><span className="meta-label">CC</span><span className="meta-value">{em.cc}</span></div>}
          <div className="meta-row"><span className="meta-label">Date</span><span className="meta-value">{formatDate(em.date)}</span></div>
        </div>
        {em.attachments?.length > 0 && (
          <div className="attachments-row">
            <span className="meta-label">Attachments</span>
            <div className="attachment-list">
              {em.attachments.map((a, i) => (
                <span key={i} className="attachment-chip">
                  📎 {a.filename} <span className="att-size">({Math.round(a.size / 1024)}KB)</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="detail-body">
        {em.body_html ? (
          <iframe
            ref={iframeRef}
            className="email-iframe"
            title="Email content"
            sandbox="allow-same-origin"
          />
        ) : (
          <pre className="email-plaintext">{em.body_text || "(No content)"}</pre>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [emails, setEmails] = useState([]);
  const [totalEmails, setTotalEmails] = useState(0);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [emailDetail, setEmailDetail] = useState(null);
  const [status, setStatus] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/folders`);
      const data = await res.json();
      setFolders(data);
      if (!selectedFolder && data.length > 0) {
        const inbox = data.find(f => f.folder === "INBOX") || data[0];
        setSelectedFolder(inbox);
      }
    } catch (e) { console.error("Folders fetch failed", e); }
  }, [selectedFolder]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`);
      const data = await res.json();
      setStatus(data);
    } catch (e) { console.error("Status fetch failed", e); }
  }, []);

  const fetchEmails = useCallback(async (folder) => {
    if (!folder) return;
    setListLoading(true);
    setEmails([]);
    setSelectedEmail(null);
    setEmailDetail(null);
    try {
      const res = await fetch(`${API}/emails/${folder.folder}?limit=200`);
      const data = await res.json();
      setEmails(data.emails || []);
      setTotalEmails(data.total || 0);
    } catch (e) { console.error("Email list fetch failed", e); }
    finally { setListLoading(false); }
  }, []);

  const fetchEmailDetail = useCallback(async (folder, em) => {
    setDetailLoading(true);
    setEmailDetail(null);
    try {
      const res = await fetch(`${API}/email/${folder.folder}/${em.filename}`);
      const data = await res.json();
      setEmailDetail(data);
    } catch (e) { console.error("Email detail fetch failed", e); }
    finally { setDetailLoading(false); }
  }, []);

  const handleSync = async () => {
    try {
      await fetch(`${API}/sync`, { method: "POST" });
      fetchStatus();
    } catch (e) { console.error("Sync trigger failed", e); }
  };

  const handleFolderSelect = (folder) => {
    setSelectedFolder(folder);
    fetchEmails(folder);
  };

  const handleEmailSelect = (em) => {
    setSelectedEmail(em);
    fetchEmailDetail(selectedFolder, em);
  };

  useEffect(() => { fetchFolders(); fetchStatus(); }, []);
  useEffect(() => { if (selectedFolder) fetchEmails(selectedFolder); }, [selectedFolder?.folder]);

  // Poll status while syncing
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => { fetchStatus(); fetchFolders(); }, 3000);
    return () => clearInterval(t);
  }, [status?.running]);

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0f0f1a;
          --surface: #16162a;
          --surface2: #1e1e35;
          --surface3: #252540;
          --border: #2a2a48;
          --accent: #6366f1;
          --accent-dim: #4338ca;
          --accent-glow: rgba(99,102,241,0.15);
          --text: #e2e2f0;
          --text-dim: #8888aa;
          --text-muted: #555570;
          --success: #22d3a5;
          --error: #f87171;
          --active-bg: #1e1e45;
          --active-border: #6366f1;
          --hover-bg: #1a1a32;
          --font-sans: 'DM Sans', 'Outfit', system-ui, sans-serif;
          --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
          --radius: 6px;
          --sync-h: 48px;
        }

        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        html, body, #root { height: 100%; width: 100%; overflow: hidden; }

        body {
          background: var(--bg);
          color: var(--text);
          font-family: var(--font-sans);
          font-size: 13px;
          line-height: 1.5;
        }

        .app-shell {
          display: flex;
          flex-direction: column;
          height: 100vh;
          width: 100vw;
          overflow: hidden;
        }

        /* Sync bar */
        .sync-bar {
          height: var(--sync-h);
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          flex-shrink: 0;
          gap: 12px;
        }
        .sync-bar-left { display: flex; align-items: center; gap: 16px; min-width: 0; }
        .app-title {
          font-weight: 600;
          font-size: 15px;
          color: var(--accent);
          letter-spacing: -0.3px;
          white-space: nowrap;
        }
        .sync-info { color: var(--text-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sync-running { color: var(--success); }
        .sync-error { color: var(--error); }
        .sync-idle { color: var(--text-dim); }
        .sync-btn {
          background: var(--accent);
          color: #fff;
          border: none;
          border-radius: var(--radius);
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s;
          font-family: var(--font-sans);
        }
        .sync-btn:hover:not(.disabled) { background: var(--accent-dim); }
        .sync-btn.disabled { background: var(--surface3); color: var(--text-muted); cursor: not-allowed; }

        /* Main layout */
        .main-layout {
          display: flex;
          flex-direction: column;
          flex: 1;
          overflow: hidden;
        }
        .top-half {
          display: flex;
          flex-direction: row;
          flex: 0 0 42%;
          border-bottom: 1px solid var(--border);
          overflow: hidden;
        }
        .bottom-half {
          flex: 1;
          overflow: hidden;
          display: flex;
        }

        /* Pane shared */
        .pane-header {
          height: 38px;
          display: flex;
          align-items: center;
          padding: 0 14px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted);
          border-bottom: 1px solid var(--border);
          background: var(--surface);
          flex-shrink: 0;
          gap: 8px;
        }
        .count-badge {
          background: var(--surface3);
          color: var(--text-dim);
          border-radius: 10px;
          padding: 1px 7px;
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0;
          text-transform: none;
        }

        /* Folder pane */
        .folder-pane {
          width: 220px;
          flex-shrink: 0;
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          background: var(--surface);
          overflow: hidden;
        }
        .folder-list {
          overflow-y: auto;
          flex: 1;
          padding: 4px 0;
        }
        .folder-list::-webkit-scrollbar { width: 4px; }
        .folder-list::-webkit-scrollbar-track { background: transparent; }
        .folder-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        .folder-item {
          width: 100%;
          background: none;
          border: none;
          color: var(--text-dim);
          padding: 7px 14px;
          text-align: left;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--font-sans);
          font-size: 13px;
          transition: background 0.1s, color 0.1s;
          border-left: 2px solid transparent;
        }
        .folder-item:hover { background: var(--hover-bg); color: var(--text); }
        .folder-item.active {
          background: var(--active-bg);
          color: var(--text);
          border-left-color: var(--accent);
        }
        .folder-icon { font-size: 13px; flex-shrink: 0; }
        .folder-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .folder-count {
          font-size: 11px;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          flex-shrink: 0;
        }

        /* Email list pane */
        .email-list-pane {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: var(--surface2);
          overflow: hidden;
          min-width: 0;
        }
        .email-list {
          flex: 1;
          overflow-y: auto;
          padding: 4px 0;
        }
        .email-list::-webkit-scrollbar { width: 4px; }
        .email-list::-webkit-scrollbar-track { background: transparent; }
        .email-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        .loading-state, .empty-state {
          padding: 24px;
          color: var(--text-muted);
          text-align: center;
          font-size: 13px;
        }

        .email-item {
          width: 100%;
          background: none;
          border: none;
          color: var(--text);
          padding: 9px 14px;
          text-align: left;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-family: var(--font-sans);
          border-bottom: 1px solid var(--border);
          transition: background 0.1s;
          border-left: 2px solid transparent;
        }
        .email-item:hover { background: var(--hover-bg); }
        .email-item.active {
          background: var(--active-bg);
          border-left-color: var(--accent);
        }
        .email-item-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .email-from {
          font-weight: 500;
          font-size: 13px;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .email-date {
          font-size: 11px;
          color: var(--text-muted);
          white-space: nowrap;
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }
        .email-subject {
          font-size: 12px;
          color: var(--text-dim);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Email detail pane */
        .email-detail-pane {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: var(--bg);
          overflow: hidden;
          min-width: 0;
        }
        .detail-empty {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          gap: 12px;
        }
        .detail-empty-icon { font-size: 48px; opacity: 0.3; }
        .detail-header {
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          padding: 14px 20px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex-shrink: 0;
        }
        .detail-subject {
          font-size: 16px;
          font-weight: 600;
          color: var(--text);
          line-height: 1.3;
        }
        .detail-meta { display: flex; flex-direction: column; gap: 3px; }
        .meta-row {
          display: flex;
          gap: 10px;
          font-size: 12px;
          align-items: baseline;
        }
        .meta-label {
          color: var(--text-muted);
          font-weight: 500;
          width: 40px;
          flex-shrink: 0;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .meta-value { color: var(--text-dim); word-break: break-all; }
        .attachments-row {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          font-size: 12px;
          flex-wrap: wrap;
        }
        .attachment-list { display: flex; gap: 6px; flex-wrap: wrap; }
        .attachment-chip {
          background: var(--surface3);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 11px;
          color: var(--text-dim);
        }
        .att-size { color: var(--text-muted); }

        .detail-body {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .email-iframe {
          flex: 1;
          width: 100%;
          border: none;
          background: #fff;
        }
        .email-plaintext {
          flex: 1;
          overflow: auto;
          padding: 20px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-dim);
          white-space: pre-wrap;
          word-break: break-word;
        }
      `}</style>

      <div className="app-shell">
        <SyncBar status={status} onSync={handleSync} />
        <div className="main-layout">
          <div className="top-half">
            <FolderPane
              folders={folders}
              selected={selectedFolder?.folder}
              onSelect={handleFolderSelect}
            />
            <EmailList
              emails={emails}
              total={totalEmails}
              selected={selectedEmail}
              onSelect={handleEmailSelect}
              loading={listLoading}
              folder={selectedFolder?.name}
            />
          </div>
          <div className="bottom-half">
            <EmailDetail
              email={emailDetail}
              folder={selectedFolder}
              loading={detailLoading}
            />
          </div>
        </div>
      </div>
    </>
  );
}
