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
  if (!from) return "";
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from.split("@")[0];
};

// Strip Whoosh uppercase highlight markers for display
const stripHighlight = (text) => text ? text.replace(/\b([A-Z]{2,})\b/g, (m) => m) : "";

// ---------------------------------------------------------------------------
// SearchBar
// ---------------------------------------------------------------------------
function SearchBar({ onSearch, onClear, searching, query }) {
  const [value, setValue] = useState(query || "");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!query) setValue("");
  }, [query]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && value.trim()) onSearch(value.trim());
    if (e.key === "Escape") { setValue(""); onClear(); }
  };

  const handleClear = () => { setValue(""); onClear(); inputRef.current?.focus(); };

  return (
    <div className="search-bar">
      <span className="search-icon">⌕</span>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder="Search all mail…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {value && (
        <button className="search-clear" onClick={handleClear} title="Clear search">✕</button>
      )}
      {searching && <span className="search-spinner">⟳</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SyncBar
// ---------------------------------------------------------------------------
function SyncBar({ status, onSync, onSearch, onClearSearch, searching, searchQuery }) {
  const indexing = status?.index_status === "building";
  const done     = status?.index_folders_done ?? 0;
  const total    = status?.index_folders_total ?? 1;
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;

  const [exportState, setExportState]   = useState("idle"); // idle | building | ready | error
  const [exportPct,   setExportPct]     = useState(0);
  const [exportLabel, setExportLabel]   = useState("");
  const [exportFile,  setExportFile]    = useState("");
  const pollRef = useRef(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollExportStatus = () => {
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/export/status`);
        const data = await res.json();
        const p = data.folders_total > 0
          ? Math.round((data.folders_done / data.folders_total) * 100) : 0;
        setExportPct(p);
        setExportLabel(data.current_folder || "");
        if (data.state === "ready") {
          setExportState("ready");
          setExportFile(data.filename);
          stopPoll();
        } else if (data.state === "error") {
          setExportState("error");
          stopPoll();
        }
      } catch (e) { console.error("Export status poll failed", e); }
    }, 2000);
  };

  const handleExportBuild = async () => {
    try {
      setExportState("building");
      setExportPct(0);
      setExportLabel("");
      await fetch(`${API}/export/build`, { method: "POST" });
      pollExportStatus();
    } catch (e) {
      console.error("Export build failed", e);
      setExportState("error");
    }
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = `${API}/export/download`;
    a.download = exportFile || "mailarchive-export.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Reset to idle after triggering — next export will clean up the file
    setTimeout(() => { setExportState("idle"); setExportPct(0); }, 1000);
  };

  return (
    <div className="sync-bar">
      <div className="sync-bar-left">
        <span className="app-title">✉ MailArchive</span>
        {status && (
          <span className="sync-info">
            {status.running ? (
              <span className="sync-running">⟳ Syncing… ({status.folders_synced} folders)</span>
            ) : indexing ? (
              <span className="index-progress">
                <span className="index-progress-label">Indexing {pct}%</span>
                <span className="index-progress-track">
                  <span className="index-progress-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="index-progress-count">{done}/{total}</span>
              </span>
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
      <SearchBar
        onSearch={onSearch}
        onClear={onClearSearch}
        searching={searching}
        query={searchQuery}
      />

      {/* Export button — three states */}
      {exportState === "idle" || exportState === "error" ? (
        <button className="export-btn" onClick={handleExportBuild} title="Build export zip">
          {exportState === "error" ? "⚠ Retry Export" : "⬇ Export All"}
        </button>
      ) : exportState === "building" ? (
        <div className="export-progress-wrap" title={exportLabel ? `Exporting: ${exportLabel}` : "Building zip…"}>
          <span className="export-progress-label">Preparing {exportPct}%</span>
          <div className="export-progress-track">
            <div className="export-progress-fill" style={{ width: `${exportPct}%` }} />
          </div>
        </div>
      ) : (
        <button className="export-btn export-btn-ready" onClick={handleDownload} title="Download export zip">
          ⬇ Download Ready
        </button>
      )}

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

// ---------------------------------------------------------------------------
// FolderPane
// ---------------------------------------------------------------------------
function FolderPane({ folders, selected, onSelect, onSyncFolder, syncingFolder, searchActive }) {
  return (
    <div className="folder-pane">
      <div className="pane-header">Folders</div>
      <div className="folder-list">
        {searchActive && (
          <div className="folder-search-notice">← clear search to browse</div>
        )}
        {folders.map((f) => (
          <div
            key={f.folder}
            className={`folder-item ${selected === f.folder && !searchActive ? "active" : ""} ${searchActive ? "dimmed" : ""}`}
            onClick={() => { if (!searchActive) onSelect(f); }}
          >
            <span className="folder-icon">{f.folder === "INBOX" ? "📥" : "📁"}</span>
            <span className="folder-name">{f.name}</span>
            {f.count > 0 && (
              <span className="folder-count">{f.count.toLocaleString()}</span>
            )}
            <button
              className={`folder-sync-btn ${syncingFolder === f.folder ? "spinning" : ""}`}
              title={`Sync ${f.name} now`}
              onClick={(e) => { e.stopPropagation(); if (!searchActive) onSyncFolder(f); }}
              disabled={!!syncingFolder || searchActive}
            >⟳</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtual-scrolled email list (folder mode)
// ---------------------------------------------------------------------------
const ITEM_HEIGHT = 56;
const OVERSCAN = 10;

function EmailList({ emails, total, selected, onSelect, loading, folder }) {
  const listRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(400);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [folder]);

  useEffect(() => {
    if (!listRef.current) return;
    const ro = new ResizeObserver(([entry]) => setListHeight(entry.contentRect.height));
    ro.observe(listRef.current);
    return () => ro.disconnect();
  }, []);

  const handleScroll = (e) => setScrollTop(e.currentTarget.scrollTop);

  const totalHeight  = emails.length * ITEM_HEIGHT;
  const startIndex   = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(listHeight / ITEM_HEIGHT) + OVERSCAN * 2;
  const endIndex     = Math.min(emails.length, startIndex + visibleCount);
  const visibleEmails = emails.slice(startIndex, endIndex);
  const offsetY      = startIndex * ITEM_HEIGHT;

  return (
    <div className="email-list-pane">
      <div className="pane-header">
        {folder ? (
          <>{folder} <span className="count-badge">{total.toLocaleString()}</span></>
        ) : "Emails"}
      </div>
      <div className="email-list" ref={listRef} onScroll={handleScroll}>
        {loading && <div className="loading-state">Loading…</div>}
        {!loading && emails.length === 0 && (
          <div className="empty-state">No emails in this folder</div>
        )}
        {!loading && emails.length > 0 && (
          <div style={{ height: totalHeight, position: "relative" }}>
            <div style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
              {visibleEmails.map((e) => (
                <div
                  key={e.id}
                  className={`email-item ${selected?.id === e.id ? "active" : ""}`}
                  style={{ height: ITEM_HEIGHT }}
                  onClick={() => onSelect(e)}
                >
                  <div className="email-item-top">
                    <span className="email-from">{formatFromName(e.from)}</span>
                    <span className="email-date">{formatDate(e.date)}</span>
                  </div>
                  <div className="email-subject">{e.subject}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results list
// ---------------------------------------------------------------------------
function SearchResults({ results, total, selected, onSelect, loading, query }) {
  return (
    <div className="email-list-pane">
      <div className="pane-header search-results-header">
        {loading ? (
          <>Searching…</>
        ) : (
          <>
            Search results
            <span className="count-badge">{total.toLocaleString()}</span>
            {query && <span className="search-query-badge">"{query}"</span>}
          </>
        )}
      </div>
      <div className="email-list">
        {loading && <div className="loading-state">Searching…</div>}
        {!loading && results.length === 0 && (
          <div className="empty-state">No results for "{query}"</div>
        )}
        {!loading && results.map((r) => (
          <div
            key={`${r.folder}/${r.filename}`}
            className={`email-item search-result-item ${selected?.id === r.id && selected?.folder === r.folder ? "active" : ""}`}
            style={{ height: "auto", minHeight: ITEM_HEIGHT }}
            onClick={() => onSelect(r)}
          >
            <div className="email-item-top">
              <span className="email-from">{formatFromName(r.from)}</span>
              <span className="email-date">{formatDate(r.date)}</span>
            </div>
            <div className="email-subject">{r.subject}</div>
            <div className="result-folder-tag">📁 {r.folder}</div>
            {r.snippet && (
              <div className="result-snippet">{r.snippet}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email detail pane
// ---------------------------------------------------------------------------
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
    return <div className="email-detail-pane"><div className="detail-empty">Loading email…</div></div>;
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

  const downloadFolder = folder?.folder || em.folder;

  return (
    <div className="email-detail-pane">
      <div className="detail-header">
        <div className="detail-header-top">
          <div className="detail-subject">{em.subject}</div>
          <a
            className="download-btn"
            href={`${API}/email/${encodeURIComponent(downloadFolder)}/${encodeURIComponent(em.id + ".eml")}/download`}
            download={`${em.id}.eml`}
            title="Download .eml file"
          >⬇ Export .eml</a>
        </div>
        <div className="detail-meta">
          <div className="meta-row"><span className="meta-label">From</span><span className="meta-value">{em.from}</span></div>
          <div className="meta-row"><span className="meta-label">To</span><span className="meta-value">{em.to}</span></div>
          {em.cc && <div className="meta-row"><span className="meta-label">CC</span><span className="meta-value">{em.cc}</span></div>}
          <div className="meta-row"><span className="meta-label">Date</span><span className="meta-value">{formatDate(em.date)}</span></div>
          {em.folder && <div className="meta-row"><span className="meta-label">Folder</span><span className="meta-value">📁 {em.folder}</span></div>}
        </div>
        {em.attachments?.length > 0 && (
          <div className="attachments-row">
            <span className="meta-label">Attachments</span>
            <div className="attachment-list">
              {em.attachments.map((a, i) => (
                <a
                  key={i}
                  className="attachment-chip"
                  href={`${API}/email/${encodeURIComponent(downloadFolder)}/${encodeURIComponent(em.id + ".eml")}/attachment/${a.index}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open or download ${a.filename}`}
                >
                  📎 {a.filename} <span className="att-size">({Math.round(a.size / 1024)}KB)</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="detail-body">
        {em.body_html ? (
          <iframe ref={iframeRef} className="email-iframe" title="Email content" sandbox="allow-same-origin" />
        ) : (
          <pre className="email-plaintext">{em.body_text || "(No content)"}</pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
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
  const [syncingFolder, setSyncingFolder] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchMode = !!searchQuery;

  const selectedFolderRef = useRef(null);
  const fetchAbortRef = useRef(null);
  const searchDebounceRef = useRef(null);

  // ---- Data fetching ----

  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/folders`);
      const data = await res.json();
      setFolders(data);
      if (!selectedFolderRef.current && data.length > 0) {
        const inbox = data.find(f => f.folder === "INBOX") || data[0];
        setSelectedFolder(inbox);
        selectedFolderRef.current = inbox;
      }
    } catch (e) { console.error("Folders fetch failed", e); }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`);
      const data = await res.json();
      setStatus(data);
    } catch (e) { console.error("Status fetch failed", e); }
  }, []);

  const fetchEmails = useCallback(async (folder) => {
    if (!folder) return;
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setListLoading(true);
    setEmails([]);
    setTotalEmails(0);
    setSelectedEmail(null);
    setEmailDetail(null);

    try {
      const res = await fetch(`${API}/emails/${encodeURIComponent(folder.folder)}?limit=5000`, {
        signal: controller.signal,
      });
      const data = await res.json();
      setEmails(data.emails || []);
      setTotalEmails(data.total || 0);
    } catch (e) {
      if (e.name !== "AbortError") console.error("Email list fetch failed", e);
    } finally {
      setListLoading(false);
    }
  }, []);

  const fetchEmailDetail = useCallback(async (folder, em) => {
    setDetailLoading(true);
    setEmailDetail(null);
    try {
      const res = await fetch(`${API}/email/${encodeURIComponent(folder)}/${encodeURIComponent(em.filename)}`);
      const data = await res.json();
      // Attach folder name so detail pane can use it for download link
      setEmailDetail({ ...data, folder });
    } catch (e) { console.error("Email detail fetch failed", e); }
    finally { setDetailLoading(false); }
  }, []);

  // ---- Search ----

  const executeSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchResults([]);
    setSearchTotal(0);
    setSelectedEmail(null);
    setEmailDetail(null);
    try {
      const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=200`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSearchResults(data.results || []);
      setSearchTotal(data.total || 0);
    } catch (e) {
      console.error("Search failed", e);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearch = (q) => {
    setSearchQuery(q);
    executeSearch(q);
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchTotal(0);
    setSelectedEmail(null);
    setEmailDetail(null);
    // Reload current folder
    if (selectedFolderRef.current) fetchEmails(selectedFolderRef.current);
  };

  // ---- Selection handlers ----

  const handleFolderSelect = (folder) => {
    setSelectedFolder(folder);
    selectedFolderRef.current = folder;
    fetchEmails(folder);
  };

  const handleEmailSelect = (em) => {
    setSelectedEmail(em);
    // em.folder is set for search results, otherwise use selectedFolder
    const folder = em.folder || selectedFolder?.folder;
    fetchEmailDetail(folder, em);
  };

  const handleSync = async () => {
    try {
      await fetch(`${API}/sync`, { method: "POST" });
      fetchStatus();
    } catch (e) { console.error("Sync trigger failed", e); }
  };

  const handleSyncFolder = async (folder) => {
    setSyncingFolder(folder.folder);
    try {
      await fetch(`${API}/sync/folder/${folder.folder}`, { method: "POST" });
      const poll = setInterval(async () => {
        const res = await fetch(`${API}/status`);
        const s = await res.json();
        setStatus(s);
        if (!s.running) {
          clearInterval(poll);
          setSyncingFolder(null);
          fetchFolders();
          if (selectedFolder?.folder === folder.folder) fetchEmails(folder);
        }
      }, 2000);
    } catch (e) {
      console.error("Folder sync failed", e);
      setSyncingFolder(null);
    }
  };

  useEffect(() => { fetchFolders(); fetchStatus(); }, []);

  useEffect(() => {
    const isActive = status?.running || status?.index_status === "building";
    if (!isActive) return;
    const t = setInterval(() => { fetchStatus(); fetchFolders(); }, 3000);
    return () => clearInterval(t);
  }, [status?.running, status?.index_status]);

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
        body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: 13px; line-height: 1.5; }

        .app-shell { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; }

        /* Sync/top bar */
        .sync-bar {
          height: var(--sync-h);
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          padding: 0 16px;
          flex-shrink: 0;
          gap: 12px;
        }
        .sync-bar-left { display: flex; align-items: center; gap: 16px; min-width: 0; flex-shrink: 0; }
        .app-title { font-weight: 600; font-size: 15px; color: var(--accent); letter-spacing: -0.3px; white-space: nowrap; }
        .sync-info { color: var(--text-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sync-running { color: var(--success); }
        .sync-error { color: var(--error); }
        .sync-idle { color: var(--text-dim); }

        /* Index progress bar */
        .index-progress {
          display: flex; align-items: center; gap: 8px; color: var(--text-dim);
        }
        .index-progress-label { font-size: 12px; color: var(--success); white-space: nowrap; }
        .index-progress-track {
          width: 120px; height: 6px; background: var(--surface3);
          border-radius: 3px; overflow: hidden; flex-shrink: 0;
        }
        .index-progress-fill {
          height: 100%; background: var(--success);
          border-radius: 3px; transition: width 0.4s ease;
        }
        .index-progress-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
        .export-btn {
          background: var(--surface3); color: var(--text-dim); border: 1px solid var(--border);
          border-radius: var(--radius); padding: 6px 14px; font-size: 12px; font-weight: 500;
          cursor: pointer; white-space: nowrap; transition: color 0.15s, border-color 0.15s;
          font-family: var(--font-sans); flex-shrink: 0;
        }
        .export-btn:hover { color: var(--accent); border-color: var(--accent); }
        .export-btn-ready {
          background: #f0c040; color: #1a1a00; border-color: #f0c040;
          font-weight: 600;
        }
        .export-btn-ready:hover { background: #ffd700; border-color: #ffd700; color: #1a1a00; }
        .export-progress-wrap {
          display: flex; align-items: center; gap: 8px; flex-shrink: 0;
        }
        .export-progress-label { font-size: 12px; color: var(--success); white-space: nowrap; flex-shrink: 0; }
        .export-progress-track {
          width: 120px; height: 6px; background: var(--surface3);
          border-radius: 3px; overflow: hidden; flex-shrink: 0;
          border: 1px solid var(--border);
        }
        .export-progress-fill {
          height: 100%; background: var(--success);
          border-radius: 3px; transition: width 0.4s ease;
          min-width: 4px;
        }
        .sync-btn {
          background: var(--accent); color: #fff; border: none; border-radius: var(--radius);
          padding: 6px 14px; font-size: 12px; font-weight: 500; cursor: pointer;
          white-space: nowrap; transition: background 0.15s; font-family: var(--font-sans); flex-shrink: 0;
        }
        .sync-btn:hover:not(.disabled) { background: var(--accent-dim); }
        .sync-btn.disabled { background: var(--surface3); color: var(--text-muted); cursor: not-allowed; }

        /* Search bar */
        .search-bar {
          width: 220px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 0 10px;
          gap: 8px;
          height: 32px;
          transition: border-color 0.15s;
          min-width: 0;
        }
        .search-bar:focus-within { border-color: var(--accent); }
        .search-icon { color: var(--text-muted); font-size: 16px; flex-shrink: 0; }
        .search-input {
          flex: 1; background: none; border: none; outline: none;
          color: var(--text); font-family: var(--font-sans); font-size: 13px;
          min-width: 0;
        }
        .search-input::placeholder { color: var(--text-muted); }
        .search-clear {
          background: none; border: none; color: var(--text-muted); cursor: pointer;
          font-size: 12px; padding: 2px; flex-shrink: 0; line-height: 1;
        }
        .search-clear:hover { color: var(--text); }
        .search-spinner { color: var(--success); font-size: 14px; animation: spin 1s linear infinite; flex-shrink: 0; }

        /* Layout */
        .main-layout { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
        .top-half { display: flex; flex-direction: row; flex: 0 0 42%; border-bottom: 1px solid var(--border); overflow: hidden; }
        .bottom-half { flex: 1; overflow: hidden; display: flex; }

        /* Pane shared */
        .pane-header {
          height: 38px; display: flex; align-items: center; padding: 0 14px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--text-muted); border-bottom: 1px solid var(--border);
          background: var(--surface); flex-shrink: 0; gap: 8px;
        }
        .count-badge {
          background: var(--surface3); color: var(--text-dim); border-radius: 10px;
          padding: 1px 7px; font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none;
        }
        .search-results-header { text-transform: none; font-size: 12px; }
        .search-query-badge {
          color: var(--accent); font-style: italic; font-weight: 400;
          letter-spacing: 0; text-transform: none; font-size: 11px;
        }

        /* Folder pane */
        .folder-pane {
          width: 270px; flex-shrink: 0; border-right: 1px solid var(--border);
          display: flex; flex-direction: column; background: var(--surface); overflow: hidden;
        }
        .folder-list { overflow-y: auto; flex: 1; padding: 4px 0; }
        .folder-list::-webkit-scrollbar { width: 4px; }
        .folder-list::-webkit-scrollbar-track { background: transparent; }
        .folder-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
        .folder-search-notice {
          padding: 6px 14px; font-size: 11px; color: var(--text-muted);
          font-style: italic; border-bottom: 1px solid var(--border);
        }

        .folder-item {
          width: 100%; background: none; border: none; color: var(--text-dim);
          padding: 7px 14px; text-align: left; cursor: pointer;
          display: flex; align-items: center; gap: 8px;
          font-family: var(--font-sans); font-size: 13px;
          transition: background 0.1s, color 0.1s; border-left: 2px solid transparent;
        }
        .folder-item:hover:not(.dimmed) { background: var(--hover-bg); color: var(--text); }
        .folder-item:hover:not(.dimmed) .folder-sync-btn { opacity: 1; }
        .folder-item.active { background: var(--active-bg); color: var(--text); border-left-color: var(--accent); }
        .folder-item.dimmed { opacity: 0.4; cursor: default; }

        .folder-sync-btn {
          margin-left: auto; background: none; border: 1px solid var(--border);
          border-radius: 4px; color: var(--text-muted); font-size: 12px;
          width: 20px; height: 20px; cursor: pointer; display: flex;
          align-items: center; justify-content: center; opacity: 0;
          transition: opacity 0.15s, color 0.15s, border-color 0.15s;
          flex-shrink: 0; padding: 0; line-height: 1;
        }
        .folder-sync-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
        .folder-sync-btn:disabled { cursor: not-allowed; }
        .folder-sync-btn.spinning { opacity: 1; color: var(--success); animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .folder-icon { font-size: 13px; flex-shrink: 0; }
        .folder-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .folder-count { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }

        /* Email list pane */
        .email-list-pane { flex: 1; display: flex; flex-direction: column; background: var(--surface2); overflow: hidden; min-width: 0; }
        .email-list { flex: 1; overflow-y: auto; padding: 0; }
        .email-list::-webkit-scrollbar { width: 4px; }
        .email-list::-webkit-scrollbar-track { background: transparent; }
        .email-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
        .loading-state, .empty-state { padding: 24px; color: var(--text-muted); text-align: center; font-size: 13px; }

        .email-item {
          width: 100%; background: none; border: none; color: var(--text);
          padding: 9px 14px; text-align: left; cursor: pointer;
          display: flex; flex-direction: column; justify-content: center; gap: 3px;
          font-family: var(--font-sans); border-bottom: 1px solid var(--border);
          transition: background 0.1s; border-left: 2px solid transparent;
          box-sizing: border-box; overflow: hidden;
        }
        .email-item:hover { background: var(--hover-bg); }
        .email-item.active { background: var(--active-bg); border-left-color: var(--accent); }

        .email-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .email-from { font-weight: 500; font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .email-date { font-size: 11px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .email-subject { font-size: 12px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* Search result extras */
        .search-result-item { height: auto !important; padding: 10px 14px; gap: 4px; }
        .result-folder-tag { font-size: 11px; color: var(--accent); margin-top: 2px; }
        .result-snippet {
          font-size: 11px; color: var(--text-muted); white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; font-style: italic;
          margin-top: 2px;
        }

        /* Download button */
        .detail-header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .download-btn {
          background: var(--surface3); border: 1px solid var(--border); border-radius: var(--radius);
          color: var(--text-dim); font-size: 11px; font-family: var(--font-sans);
          padding: 4px 10px; cursor: pointer; white-space: nowrap; text-decoration: none;
          flex-shrink: 0; transition: color 0.15s, border-color 0.15s;
          display: inline-flex; align-items: center; gap: 4px;
        }
        .download-btn:hover { color: var(--accent); border-color: var(--accent); }

        /* Email detail */
        .email-detail-pane { flex: 1; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; min-width: 0; }
        .detail-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); gap: 12px; }
        .detail-empty-icon { font-size: 48px; opacity: 0.3; }
        .detail-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
        .detail-subject { font-size: 16px; font-weight: 600; color: var(--text); line-height: 1.3; }
        .detail-meta { display: flex; flex-direction: column; gap: 3px; }
        .meta-row { display: flex; gap: 10px; font-size: 12px; align-items: baseline; }
        .meta-label { color: var(--text-muted); font-weight: 500; width: 44px; flex-shrink: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
        .meta-value { color: var(--text-dim); word-break: break-all; }
        .attachments-row { display: flex; gap: 10px; align-items: flex-start; font-size: 12px; flex-wrap: wrap; }
        .attachment-list { display: flex; gap: 6px; flex-wrap: wrap; }
        .attachment-chip {
          background: var(--surface3); border: 1px solid var(--border); border-radius: 4px;
          padding: 2px 8px; font-size: 11px; color: var(--text-dim);
          text-decoration: none; display: inline-flex; align-items: center; gap: 4px;
          transition: color 0.15s, border-color 0.15s, background 0.15s; cursor: pointer;
        }
        .attachment-chip:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-glow); }
        .att-size { color: var(--text-muted); }
        .detail-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
        .email-iframe { flex: 1; width: 100%; border: none; background: #fff; }
        .email-plaintext { flex: 1; overflow: auto; padding: 20px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
      `}</style>

      <div className="app-shell">
        <SyncBar
          status={status}
          onSync={handleSync}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          searching={searching}
          searchQuery={searchQuery}
        />
        <div className="main-layout">
          <div className="top-half">
            <FolderPane
              folders={folders}
              selected={selectedFolder?.folder}
              onSelect={handleFolderSelect}
              onSyncFolder={handleSyncFolder}
              syncingFolder={syncingFolder}
              searchActive={searchMode}
            />
            {searchMode ? (
              <SearchResults
                results={searchResults}
                total={searchTotal}
                selected={selectedEmail}
                onSelect={handleEmailSelect}
                loading={searching}
                query={searchQuery}
              />
            ) : (
              <EmailList
                emails={emails}
                total={totalEmails}
                selected={selectedEmail}
                onSelect={handleEmailSelect}
                loading={listLoading}
                folder={selectedFolder?.name}
              />
            )}
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
