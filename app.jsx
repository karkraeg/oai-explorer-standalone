/* SPDX-License-Identifier: MIT */
/* global React, ReactDOM */
const { useState, useMemo, useEffect, useRef, useCallback } = React;

const APP_VERSION = "3.0.2";
const LINE_HINT_KEY = "oai_seen_line_hint";
const LAST_PREFIX_KEY = "oai_last_metadata_prefix";
const THEME_KEY = "oai_theme";

const EXAMPLE_REPOS = [
  { label: "Deutsche Digitale Bibliothek", url: "https://oai.deutsche-digitale-bibliothek.de/oai" },
  { label: "arXiv.org", url: "https://export.arxiv.org/oai2" },
  { label: "Zenodo", url: "https://zenodo.org/oai2d" },
];

// ── Recent endpoints (localStorage) ──────────────────────────────────────────
const RECENT_KEY = "oai_recent_endpoints";
function saveRecentEndpoint(url) {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    const updated = [url, ...stored.filter(u => u !== url)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch (_) {}
}
function loadRecentEndpoints() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch (_) { return []; }
}

function saveLastMetadataPrefix(url, prefix) {
  if (!url || !prefix) return;
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_PREFIX_KEY) || "{}");
    localStorage.setItem(LAST_PREFIX_KEY, JSON.stringify({ ...stored, [url]: prefix }));
  } catch (_) {}
}

function loadLastMetadataPrefix(url) {
  try { return JSON.parse(localStorage.getItem(LAST_PREFIX_KEY) || "{}")[url] || ""; }
  catch (_) { return ""; }
}

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || "light"; }
  catch (_) { return "light"; }
}

// ── API helper ────────────────────────────────────────────────────────────────
const NOCACHE = new URLSearchParams(location.search).has("nocache");

async function fetchApi(action, baseUrl, extra = {}) {
  const sp = new URLSearchParams({ action, url: baseUrl });
  Object.entries(extra).forEach(([k, v]) => { if (v) sp.set(k, v); });
  if (NOCACHE) sp.set("nocache", "1");
  const res = await fetch(`api.php?${sp}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function buildExplorerUrl({ url, metadataPrefix, set, from, until, identifier }) {
  const sp = new URLSearchParams({ url });
  if (metadataPrefix) sp.set("metadataPrefix", metadataPrefix);
  if (set)            sp.set("set", set);
  if (from)           sp.set("from", from);
  if (until)          sp.set("until", until);
  if (identifier)     sp.set("identifier", identifier);
  return `${location.origin}${location.pathname}?${sp}`;
}

function xmlDownloadName(identifier, prefix) {
  return `${identifier || "record"}--${prefix || "oai_dc"}`.replace(/[^a-z0-9._-]+/gi, "_") + ".xml";
}

function lineHashFor(sel) {
  if (!sel) return "";
  return sel.start === sel.end ? `#L${sel.start}` : `#L${sel.start}-L${sel.end}`;
}

function parseLineHash(hash) {
  const m = /^#?L(\d+)(?:-L?(\d+))?$/.exec(hash || "");
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function repoDataFromSummary(data) {
  return {
    identify: data.identify || {},
    formats: data.formats || [],
    sets: data.sets || [],
    setsCount: data.setsCount ?? (data.sets || []).length,
    setsTruncated: !!data.setsTruncated,
    setsHydrated: data.setsHydrated !== false,
    initPrefix: data.initPrefix || "oai_dc",
    initRecords: data.initRecords || [],
    initTotal: data.initTotal ?? null,
    initToken: data.initToken ?? null,
    initLoaded: !!data.initLoaded,
    initNoRecordsMatch: !!data.initNoRecordsMatch,
    stale: !!data.stale,
    refreshedAt: data.refreshedAt ?? null,
  };
}

function App() {
  const [screen, setScreen] = useState("start");
  const [url, setUrl] = useState("");
  const [repoData, setRepoData] = useState(null);
  const [loadingStep, setLoadingStep] = useState(0); // 0=pending 1=identify done 2=formats done 3=sets done
  const [prefilledFilters, setPrefilledFilters] = useState({});
  const [activeRecord, setActiveRecord] = useState(null); // { record, prefix, formats }
  const [error, setError] = useState(null);
  const [autoOpenRecord, setAutoOpenRecord] = useState(null); // { identifier, prefix } — set by initFromUrl
  const [lastExploreUrl, setLastExploreUrl] = useState(null);
  const [theme, setTheme] = useState(loadTheme);
  const currentUrlRef = useRef("");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }, [theme]);

  const writeHistoryUrl = useCallback((nextUrl, mode = "push") => {
    if (mode === "none") return;
    const absoluteUrl = new URL(nextUrl, location.href).href;
    if (absoluteUrl === location.href) return;
    history[mode === "replace" ? "replaceState" : "pushState"]({}, "", absoluteUrl);
  }, []);

  const refreshEndpointSummary = useCallback(async (baseUrl) => {
    try {
      const res = await fetchApi("refreshSummary", baseUrl);
      if (res.ok && currentUrlRef.current === baseUrl) {
        setRepoData(repoDataFromSummary(res.data));
        saveRecentEndpoint(baseUrl);
      }
    } catch (_) {}
  }, []);

  const restoreFromLocation = useCallback((historyMode = "none") => {
    const sp = new URLSearchParams(location.search);
    const u = sp.get("url");
    if (!u) {
      currentUrlRef.current = "";
      setScreen("start");
      setUrl("");
      setRepoData(null);
      setPrefilledFilters({});
      setActiveRecord(null);
      setAutoOpenRecord(null);
      setLastExploreUrl(null);
      setError(null);
      return;
    }
    const identifier    = sp.get("identifier") || "";
    const metadataPrefix = sp.get("metadataPrefix") || "";
    const set   = sp.get("set")   || "";
    const from  = sp.get("from")  || "";
    const until = sp.get("until") || "";
    setAutoOpenRecord(identifier ? { identifier, prefix: metadataPrefix } : null);
    goExplore(u, null, { metadataPrefix, set, from, until }, historyMode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore state from explorer share URL on first load and browser history moves
  useEffect(() => {
    restoreFromLocation();
    const onPopState = () => restoreFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [restoreFromLocation]);

  // Auto-open a record after repo data loads (triggered by share URL with identifier=)
  useEffect(() => {
    if (screen === "explore" && repoData && autoOpenRecord) {
      setActiveRecord({ record: { identifier: autoOpenRecord.identifier }, prefix: autoOpenRecord.prefix, formats: repoData.formats });
      setScreen("record");
      setAutoOpenRecord(null);
    }
  }, [screen, repoData, autoOpenRecord]);

  const goExplore = useCallback(async (rawUrl, broken, overrideFilters = null, historyMode = "push") => {
    if (broken) {
      setError({ kind: broken, url: rawUrl });
      setScreen("error");
      return;
    }

    // Parse full OAI-PMH URLs with verb= params
    let baseUrl = rawUrl;
    let filters = {};
    try {
      const u = new URL(rawUrl);
      if (u.searchParams.get("verb")) {
        baseUrl = rawUrl.split("?")[0].replace(/\/+$/, "");
        filters = {
          metadataPrefix: u.searchParams.get("metadataPrefix") || "",
          set:   u.searchParams.get("set")   || "",
          from:  u.searchParams.get("from")  || "",
          until: u.searchParams.get("until") || "",
        };
      }
    } catch (e) { /* not a valid URL, treat as-is */ }

    // Allow explorer share URL params to override parsed OAI-PMH params
    if (overrideFilters) {
      if (overrideFilters.metadataPrefix !== undefined) filters.metadataPrefix = overrideFilters.metadataPrefix;
      if (overrideFilters.set   !== undefined) filters.set   = overrideFilters.set;
      if (overrideFilters.from  !== undefined) filters.from  = overrideFilters.from;
      if (overrideFilters.until !== undefined) filters.until = overrideFilters.until;
    }
    if (!filters.metadataPrefix) filters.metadataPrefix = loadLastMetadataPrefix(baseUrl);

    currentUrlRef.current = baseUrl;
    setUrl(baseUrl);
    setPrefilledFilters(filters);
    setError(null);
    setRepoData(null);
    setActiveRecord(null);
    setLoadingStep(0);

    const hasRestrictedFilters = !!(filters.set || filters.from || filters.until);
    if (!hasRestrictedFilters && !NOCACHE) {
      try {
        const boot = await fetchApi("bootstrap", baseUrl, { slim: "1" });
        if (boot.ok) {
          const repo = repoDataFromSummary(boot.data);
          if (filters.metadataPrefix && filters.metadataPrefix !== repo.initPrefix) {
            repo.initPrefix = filters.metadataPrefix;
            repo.initTotal = null;
            repo.initRecords = [];
            repo.initToken = null;
            repo.initLoaded = false;
            repo.initNoRecordsMatch = false;
          }
          setRepoData(repo);
          saveRecentEndpoint(baseUrl);
          setScreen("explore");
          const exploreUrl = buildExplorerUrl({ url: baseUrl, metadataPrefix: repo.initPrefix });
          writeHistoryUrl(exploreUrl, historyMode);
          setLastExploreUrl(exploreUrl);
          if (boot.data.stale) refreshEndpointSummary(baseUrl);
          return;
        }
      } catch (_) {}
    }

    setScreen("loading");

    try {
      let identifyRes;
      if (!/^https?:\/\//i.test(baseUrl)) {
        // No scheme given — try https first, then fall back to http
        try {
          identifyRes = await fetchApi("identify", "https://" + baseUrl);
        } catch (_) { identifyRes = { ok: false }; }
        if (identifyRes.ok) {
          baseUrl = "https://" + baseUrl;
        } else {
          let httpRes;
          try {
            httpRes = await fetchApi("identify", "http://" + baseUrl);
          } catch (_) { httpRes = { ok: false }; }
          if (httpRes.ok) {
            baseUrl = "http://" + baseUrl;
            identifyRes = httpRes;
          } else {
            baseUrl = "https://" + baseUrl;
          }
        }
        setUrl(baseUrl);
      } else {
        identifyRes = await fetchApi("identify", baseUrl);
      }
      if (!filters.metadataPrefix) filters.metadataPrefix = loadLastMetadataPrefix(baseUrl);
      setLoadingStep(1);
      const formatsRes  = await fetchApi("listMetadataFormats", baseUrl);
      setLoadingStep(2);
      const setsRes     = await fetchApi("listSets", baseUrl);
      setLoadingStep(3);

      if (!identifyRes.ok) {
        setError({ kind: identifyRes.kind || "unreachable", url: baseUrl, message: identifyRes.error });
        setScreen("error");
        return;
      }

      const fmts = formatsRes.ok ? (formatsRes.data || []) : [];
      const initPrefix = fmts.find(f => f.value === "oai_dc") ? "oai_dc"
                       : (fmts[0]?.value || "oai_dc");

      // Respect any pre-parsed URL filters for the initial load
      const initParams = { prefix: filters.metadataPrefix || initPrefix };
      if (filters.set)   initParams.set   = filters.set;
      if (filters.from)  initParams.from  = filters.from;
      if (filters.until) initParams.until = filters.until;

      let initRecords = [], initTotal = null, initToken = null, initLoaded = false, initNoRecordsMatch = false;
      try {
        const idRes = await fetchApi("listIdentifiers", baseUrl, initParams);
        if (idRes.ok) {
          initRecords = idRes.data.identifiers || [];
          initTotal   = idRes.data.total ?? null;
          initToken   = idRes.data.resumptionToken ?? null;
          initLoaded  = true;
        } else if (idRes.oai_error === "noRecordsMatch") {
          initLoaded = true;
          initNoRecordsMatch = true;
        }
      } catch (_) {}
      setLoadingStep(4);

      setRepoData({
        identify: identifyRes.data,
        formats:  fmts,
        sets:     setsRes.ok ? (setsRes.data.sets || []) : [],
        setsTruncated: setsRes.ok && setsRes.data.truncated,
        initPrefix, initRecords, initTotal, initToken, initLoaded, initNoRecordsMatch,
      });
      saveRecentEndpoint(baseUrl);
      setScreen("explore");
      const exploreUrl = buildExplorerUrl({ url: baseUrl, metadataPrefix: initParams.prefix, set: initParams.set, from: initParams.from, until: initParams.until });
      writeHistoryUrl(exploreUrl, historyMode);
      setLastExploreUrl(exploreUrl);
      if (!hasRestrictedFilters) refreshEndpointSummary(baseUrl);
    } catch (e) {
      setError({ kind: "unreachable", url: baseUrl });
      setScreen("error");
    }
  }, [refreshEndpointSummary, writeHistoryUrl]);

  return (
    <div className="app">
      <TopBar
        screen={screen}
        url={url}
        onHome={() => {
          currentUrlRef.current = "";
          setScreen("start");
          setUrl("");
          setRepoData(null);
          setPrefilledFilters({});
          setActiveRecord(null);
          setAutoOpenRecord(null);
          setLastExploreUrl(null);
          setError(null);
          writeHistoryUrl(location.pathname);
        }}
        onChangeUrl={(u) => { goExplore(u); }}
        onNavigate={(s) => setScreen(s)}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />

      {screen === "start" && (
        <StartScreen onSubmit={goExplore} />
      )}
      {screen === "loading" && (
        <LoadingScreen url={url} step={loadingStep} />
      )}
      {screen === "explore" && repoData && (
        <ExploreScreen
          url={url}
          repoData={repoData}
          prefilledFilters={prefilledFilters}
          onOpenRecord={(record, prefix) => {
            setActiveRecord({ record, prefix, formats: repoData.formats });
            setScreen("record");
            writeHistoryUrl(buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: prefix }));
          }}
          onUrlChange={(u) => {
            setLastExploreUrl(u);
            writeHistoryUrl(u);
          }}
        />
      )}
      {screen === "record" && activeRecord && (
        <RecordScreen
          url={url}
          record={activeRecord.record}
          prefix={activeRecord.prefix}
          formats={activeRecord.formats || []}
          onBack={() => {
            setScreen("explore");
            if (lastExploreUrl) writeHistoryUrl(lastExploreUrl);
          }}
        />
      )}
      {screen === "faq" && (
        <FaqScreen onBack={() => setScreen(url ? "explore" : "start")} />
      )}
      {screen === "imprint" && (
        <ImprintScreen onBack={() => setScreen(url ? "explore" : "start")} />
      )}
      {screen === "changelog" && (
        <ChangelogScreen onBack={() => setScreen(url ? "explore" : "start")} />
      )}
      {screen === "error" && error && (
        <ErrorScreen
          error={error}
          onRetry={() => goExplore(error.url)}
          onHome={() => setScreen("start")}
        />
      )}

      <SiteFooter onNavigate={(s) => setScreen(s)} />
      <ScrollToTopButton />
    </div>
  );
}

function ScrollToTopButton() {
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!visible) return null;
  return (
    <button
      className="scroll-to-top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
    >↑</button>
  );
}

// ── Loading screen ────────────────────────────────────────────────────────────
function LoadingScreen({ url, step }) {
  const verbs = ["Identify", "ListMetadataFormats", "ListSets", "ListIdentifiers"];
  return (
    <main className="screen screen-start" style={{ paddingTop: 120 }} aria-live="polite">
      <div style={{ textAlign: "center", maxWidth: 480, margin: "0 auto" }}>
        <div className="loading-hero" style={{ marginBottom: 16 }}>
          <span className="loading-spinner" aria-hidden="true" />
          <div className="eyebrow" style={{ margin: 0 }}>Connecting…</div>
        </div>
        <div className="info-url" style={{ marginBottom: 28 }}>{url}</div>
        <div style={{ display: "inline-flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          {verbs.map((v, i) => {
            const done    = step > i;
            const active  = step === i;
            return (
              <div key={v} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontFamily: "var(--font-mono)",
                  background: done ? "var(--accent)" : "var(--bg-soft)",
                  border: `1px solid ${done ? "var(--accent)" : active ? "var(--accent)" : "var(--border)"}`,
                  color: done ? "white" : "var(--text-dim)",
                  transition: "all .2s ease",
                }}>
                  {done ? "✓" : (active ? "…" : "")}
                </span>
                <span className="results-meta" style={{
                  color: done ? "var(--text)" : active ? "var(--accent-text)" : "var(--text-dim)",
                  transition: "color .2s ease",
                }}>{v}</span>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

// ── Sync command ──────────────────────────────────────────────────────────────
function SyncCommand({ baseURL, prefix, setSpec, from, until }) {
  const cmd = useMemo(() => {
    const parts = ["uvx", "ometha", "default", "-p 1"];
    parts.push(`--baseurl ${baseURL}`);
    if (prefix)  parts.push(`--metadataprefix ${prefix}`);
    if (setSpec) parts.push(`--set ${setSpec}`);
    if (from)    parts.push(`--fromdate ${from}`);
    if (until)   parts.push(`--untildate ${until}`);
    return parts.join(" ");
  }, [baseURL, prefix, setSpec, from, until]);

  const [copied, setCopied] = useState(false);
  const currentRequestUrl = useMemo(() => {
    const sp = new URLSearchParams({ verb: "ListIdentifiers" });
    if (prefix) sp.set("metadataPrefix", prefix);
    if (setSpec) sp.set("set", setSpec);
    if (from) sp.set("from", from);
    if (until) sp.set("until", until);
    return `${baseURL}?${sp.toString()}`;
  }, [baseURL, prefix, setSpec, from, until]);

  const copy = () => {
    navigator.clipboard?.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <details className="cmd-block">
      <summary className="cmd-summary">Sync from CLI</summary>
      <div className="cmd-content">
        <div className="cmd-label">
          <span>Current filters</span>
          <button className="cmd-copy-mini" onClick={copy} aria-live="polite">
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <div className="cmd-row">
          <div className="cmd-line">
            <span className="cmd-prompt">$</span>
            <code className="cmd-text">{cmd}</code>
          </div>
        </div>
        <div className="cmd-hint mono">
          (requires{" "}
          <span className="cmd-hint-tooltip">
            <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noopener noreferrer">uv</a>
            <span className="tooltip-text">Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh</span>
          </span>
          {" "}+{" "}
          <a href="https://pypi.org/project/ometha/" target="_blank" rel="noopener noreferrer">ometha</a>)
        </div>
        <div className="cmd-hint mono cmd-hint--link">
          Current request URL:{" "}
          <a href={currentRequestUrl} target="_blank" rel="noopener noreferrer">
            {currentRequestUrl}
          </a>
        </div>
      </div>
    </details>
  );
}

// ── Error screen ──────────────────────────────────────────────────────────────
function ErrorScreen({ error, onRetry, onHome }) {
  const isUnreachable = error.kind === "unreachable";
  const oaiUrl = error.url ? `${error.url}?verb=Identify` : "—";
  const meta = isUnreachable
    ? {
        eyebrow: "Connection error",
        code: "ERR_NET",
        title: "Couldn't reach the repository",
        summary: error.message || "The host didn't respond within 15 seconds. The server may be offline, the URL might be misspelled, or a firewall could be blocking the request.",
        trace: [
          { k: "GET",    v: oaiUrl },
          { k: "Status", v: "ERR_CONNECTION_TIMED_OUT", status: true },
          { k: "DNS",    v: "no resolvable address" },
          { k: "Time",   v: "15.0 s (timeout)" },
        ],
        checks: [
          { ic: "✕", state: "fail", h: "Host did not resolve", s: "DNS lookup returned no record. Double-check the domain." },
          { ic: "—", state: "warn", h: "TLS handshake skipped", s: "Connection never established." },
          { ic: "—", state: "warn", h: "Identify response not received", s: "We can't verify whether the endpoint speaks OAI-PMH until the host responds." },
        ],
      }
    : {
        eyebrow: "Protocol error",
        code: "ERR_OAI_INVALID",
        title: "This URL doesn't speak OAI-PMH",
        summary: error.message || "The host responded, but the body is not a valid OAI-PMH 2.0 document. The Identify verb returned HTML where XML was expected.",
        trace: [
          { k: "GET",          v: oaiUrl },
          { k: "Status",       v: "200 OK", status: true },
          { k: "Content-Type", v: "text/html; charset=utf-8" },
          { k: "Body",         v: "<!doctype html><html>…" },
          { k: "Expected",     v: "application/xml with <OAI-PMH> root element" },
        ],
        checks: [
          { ic: "✓", state: "ok",   h: "Host reachable",       s: `${error.url} responded.` },
          { ic: "✕", state: "fail", h: "Wrong Content-Type",   s: "Expected application/xml, got text/html." },
          { ic: "✕", state: "fail", h: "Missing <OAI-PMH> root", s: "No XML namespace http://www.openarchives.org/OAI/2.0/ found." },
        ],
      };

  return (
    <main className="screen">
      <div className="error-screen">
        <header className="error-head">
          <div className="error-icon">!</div>
          <div className="error-title-wrap">
            <div className="error-eyebrow">{meta.eyebrow} · {meta.code}</div>
            <h1 className="error-title">{meta.title}</h1>
            <p className="error-summary">{meta.summary}</p>
          </div>
        </header>

        <div className="error-trace">
          {meta.trace.map((t, i) => (
            <div key={i}>
              <span className="et-key">{t.k.padEnd(14, " ")}</span>
              <span className={t.status ? "et-status" : "et-val"}>{t.v}</span>
            </div>
          ))}
        </div>

        <div className="error-checks">
          {meta.checks.map((c, i) => (
            <div key={i} className={`error-check ${c.state === "fail" ? "is-fail-row" : ""}`}>
              <div className={`error-check-icon is-${c.state}`}>{c.ic}</div>
              <div className="error-check-text">
                <strong>{c.h}</strong>
                <small>{c.s}</small>
              </div>
            </div>
          ))}
        </div>

        <div className="error-actions">
          <button className="btn btn-danger" onClick={onRetry}>Retry connection</button>
          <button className="btn" onClick={onHome}>Try a different URL</button>
        </div>
      </div>
    </main>
  );
}

// ── Logo ──────────────────────────────────────────────────────────────────────
function Logo({ size = 22 }) {
  return (
    <img
      className="brand-logo"
      src="logo.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────
function TopBar({ screen, url, onHome, onChangeUrl, onNavigate, theme, onToggleTheme }) {
  const showSwitcher = screen === "explore" || screen === "record";
  const [val, setVal] = useState(url || "");
  useEffect(() => { setVal(url || ""); }, [url]);

  const submit = () => {
    if (val.trim() && val.trim() !== url) onChangeUrl(val.trim());
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <button className="brand" onClick={onHome} title="Home">
          <Logo />
          <span className="brand-name">OAI-PMH <span className="brand-name-dim">Explorer</span></span>
        </button>

        {showSwitcher && (
          <form className="tb-search" onSubmit={(e) => { e.preventDefault(); submit(); }} role="search">
            <span className="tb-search-icon">⌕</span>
            <input
              type="url"
              className="tb-search-input mono"
              placeholder="https://oai.example.org/oai"
              value={val}
              onChange={(e) => setVal(e.target.value)}
            />
            {val !== url && val.trim() && (
              <button type="submit" className="tb-search-go">Go ↵</button>
            )}
          </form>
        )}

        <nav className="topbar-meta">
          {showSwitcher && (
            <button className="tb-new" onClick={onHome} title="Start a new search">
              <span className="tb-new-plus">+</span> New
            </button>
          )}
          <button className={`topbar-link ${screen === "faq"     ? "is-active" : ""}`} onClick={() => onNavigate("faq")}>FAQ</button>
          <button className={`topbar-link ${screen === "imprint" ? "is-active" : ""}`} onClick={() => onNavigate("imprint")}>Imprint</button>
          <button
            className="topbar-link theme-toggle"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <a className="topbar-link" href="https://github.com/karkraeg/oai-explorer-standalone" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
      </div>
    </header>
  );
}

// ── FAQ ───────────────────────────────────────────────────────────────────────
function FaqScreen({ onBack }) {
  const items = [
    { q: "What is OAI-PMH?",
      a: "The Open Archives Initiative Protocol for Metadata Harvesting is a low-barrier mechanism for repository interoperability. Data providers expose metadata as XML over HTTP; harvesters fetch it incrementally using six standard verbs." },
    { q: "Which verbs does this tool use?",
      a: "Identify (repository info), ListMetadataFormats, ListSets, ListIdentifiers, and GetRecord. The Explore screen calls Identify + ListSets + ListMetadataFormats in parallel when you connect, then ListIdentifiers when you click Load." },
    { q: "Why are some records marked deleted?",
      a: "Repositories can keep tombstones for removed records so harvesters can drop them on their side. The Identify response declares this policy as no, persistent, or transient." },
    { q: "Can I export the records?",
      a: "Yes — the sync command under the filters is a uvx ometha one-liner that mirrors your current prefix, set, and date range. Requires uv and ometha installed locally." },
    { q: "Why does ListRecords sometimes paginate?",
      a: "Repositories return a resumptionToken when the result set exceeds their page limit. Tokens can expire; if that happens, reload the list from page 1." },
    { q: "Is this tool affiliated with any specific repository?",
      a: "No — it's a generic OAI-PMH 2.0 client. Any compliant endpoint should work; the example chips on the start screen are popular German and international repositories." },
    { q: "Are requests cached?",
      a: "Yes — repository summaries are kept permanently so known endpoints open immediately. Stale summaries are refreshed in the background." },
    { q: "Can everybody see what I explored under 'RECENTLY USED'?",
      a: "No, that's only shown to you."
    },
    { q: "Can I link to a specific line in a record's XML?",
      a: "Yes — on the record screen, click a line number to select it, or shift-click a second line to select a range, then use \"Copy link to L…\". This works like GitHub's line links. One caveat: records here aren't versioned, so the link points at the document as it was fetched at that moment. If the source repository updates the metadata later, the content — and therefore which line the link highlights — can shift or no longer match what was originally shared." }
  ];

  return (
    <main className="screen screen-doc">
      <button className="back-link" onClick={onBack}>
        <span className="back-arrow">←</span> Back
      </button>
      <div className="doc-eyebrow">Help</div>
      <h1 className="doc-title">Frequently asked questions</h1>
      <p className="doc-lede">A quick primer on OAI-PMH and how this explorer fits into a typical harvesting workflow.</p>
      <div className="faq">
        {items.map((it, i) => (
          <div key={i} className="faq-item">
            <div className="faq-num">{String(i + 1).padStart(2, "0")}</div>
            <div>
              <h2 className="faq-q">{it.q}</h2>
              <p className="faq-a">{it.a}</p>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

// ── Changelog ─────────────────────────────────────────────────────────────────
function ChangelogScreen({ onBack }) {
  const entries = [
    {
      version: "3.0.2",
      date: "2026-07-13",
      changes: [
        "Fixed cached identifier starts and lazy-loaded large set lists.",
      ],
    },
    {
      version: "3.0.1",
      date: "2026-07-13",
      changes: [
        "Made the light/dark theme toggle an icon button that stays visible on mobile.",
      ],
    },
    {
      version: "3.0.0",
      date: "2026-07-12",
      changes: [
        "Added a persisted light/dark theme toggle.",
      ],
    },
    {
      version: "2.6.0",
      date: "2026-07-12",
      changes: [
        "Made the XML outline work across metadata prefixes, including namespace-aware MARC tag jumps with highlighted target lines.",
      ],
    },
    {
      version: "2.5.0",
      date: "2026-07-12",
      changes: [
        "Remembered the last selected metadataPrefix per endpoint in localStorage.",
      ],
    },
    {
      version: "2.4.0",
      date: "2026-07-12",
      changes: [
        "Added XML downloads from the Record view.",
        "Documented CLI sync, added MIT licensing, and marked source files with SPDX headers.",
      ],
    },
    {
      version: "2.3.0",
      date: "2026-07-09",
      changes: [
        "Added GitHub-style line links for record XML: click a line number (or shift-click a range) and copy a #L12-L34 link, with a one-time heads-up that unversioned records may not match the link later.",
      ],
    },
    {
      version: "2.2.1",
      date: "2026-07-07",
      changes: [
        "Enabled browser back and forward navigation between Start, Explore, filtered lists, and Record views.",
      ],
    },
    {
      version: "2.2.0",
      date: "2026-07-07",
      changes: [
        "Refined the Explore controls with a clearer date/action row and wider jump-to-record field.",
        "Collapsed the CLI sync command behind an on-demand disclosure.",
        "Moved deleted record state into a compact pill next to the identifier instead of a separate table column.",
        "Improved keyboard and screen-reader behavior for filters, set selection, status updates, errors, and record links.",
        "Tuned mobile touch targets, contrast, and reduced-motion handling.",
      ],
    },
    {
      version: "2.1.1",
      date: "2026-07-07",
      changes: [
        "Auto-try HTTPS and then HTTP for schemeless OAI endpoint URLs.",
      ],
    },
    {
      version: "2.1.0",
      date: "2026-06-26",
      changes: [
        "Added server-side paging for very large ListIdentifiers responses so repositories like arXiv cannot overload the browser.",
        "Kept remote resumptionToken pagination intact after cached page slices are exhausted.",
      ],
    },
    {
      version: "2.0.1",
      date: "2026-06-26",
      changes: [
        "Fixed cached endpoint starts so identifier loading begins automatically after the instant summary view.",
        "Added permanent repository summaries for known endpoints without storing identifier pages or stale resumption tokens.",
      ],
    },
    {
      version: "2.0.0",
      date: "2026-06-25",
      changes: [
        "Added Docker Compose stack with Nginx, PHP-FPM, Worker, and Postgres.",
        "Added background Full Harvest for OAI identifiers with slow page-by-page fetching.",
        "Added local identifier pagination after completed harvests.",
        "Added Delta Harvest from last datestamp for stale harvested scopes.",
        "Kept record XML out of long-term harvest storage.",
        "Made URLs inside record XML clickable.",
      ],
    },
    {
      version: "1.2.0",
      date: "2026-06-24",
      changes: [
        "Added record sharing with metadataPrefix and identifier in the Explorer URL.",
        "Improved Record view with direct OAI URL copy controls.",
      ],
    },
    {
      version: "1.1.0",
      date: "2026-06-23",
      changes: [
        "Added jump-to-record support from the Explore screen.",
        "Added copyable Explorer links for list and record views.",
        "Improved Record view with pretty-printed XML, XML copy controls, METS/MODS section outline, and back-to-top navigation.",
      ],
    },
    {
      version: "1.0.0",
      date: "2026-06-20",
      changes: [
        "Initial OAI-PMH Explorer with repository detection, metadata format and set filters, identifier listing, and record XML inspection.",
        "Added recent endpoints and OAI URL helpers for common repository workflows.",
      ],
    },
  ];

  return (
    <main className="screen screen-doc">
      <button className="back-link" onClick={onBack}>
        <span className="back-arrow">←</span> Back
      </button>
      <div className="doc-eyebrow">Release notes</div>
      <h1 className="doc-title">Changelog</h1>
      <p className="doc-lede">Notable changes to OAI-PMH Explorer.</p>

      <div className="changelog">
        {entries.map((entry) => (
          <section key={entry.version} className="changelog-entry">
            <div className="changelog-version mono">v{entry.version}</div>
            <div>
              <h2 className="doc-h2">{entry.date}</h2>
              <ul className="changelog-list">
                {entry.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

// ── Imprint ───────────────────────────────────────────────────────────────────
function ImprintScreen({ onBack }) {
  return (
    <main className="screen screen-doc">
      <button className="back-link" onClick={onBack}>
        <span className="back-arrow">←</span> Back
      </button>
      <div className="doc-eyebrow">Legal</div>
      <h1 className="doc-title">Imprint</h1>
      <p className="doc-lede">Information per § 5 TMG.</p>

      <section className="doc-section">
        <h2 className="doc-h2">Operator</h2>
        <p className="doc-p mono">
          Karl Krägelin<br />
          Luhmannstrasse 1<br />
          49088 Osnabrück<br />
          Germany
        </p>
      </section>
      <section className="doc-section">
        <h2 className="doc-h2">Contact</h2>
        <dl className="doc-dl">
          <div><dt>Email</dt><dd className="mono">mail@karkraegelin.org</dd></div>
        </dl>
      </section>
      <section className="doc-section">
        <h2 className="doc-h2">Liability for content</h2>
        <p className="doc-p">
          As a service provider we are responsible for our own content on these pages
          per § 7 (1) TMG. We are not obliged to monitor third-party information
          transmitted or stored, or to investigate circumstances that point to illegal
          activity, per §§ 8–10 TMG.
        </p>
      </section>
      <section className="doc-section">
        <h2 className="doc-h2">External links</h2>
        <p className="doc-p">
          Linked external sites were checked for legal compliance at the time of linking;
          we have no influence over their current or future content and accept no liability
          for it.
        </p>
      </section>
      <section className="doc-section">
        <h2 className="doc-h2">Cookies and local storage</h2>
        <p className="doc-p">
          This site sets <strong>no cookies</strong>. It uses your browser's
          <code>localStorage</code> to remember recent endpoints, metadataPrefix
          choices, and theme. This data never leaves your device and is not shared
          with any third party. You can clear it at any time via your browser's
          developer tools.
        </p>
      </section>
    </main>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────
function SiteFooter({ onNavigate }) {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand mono">
          OAI-PMH Explorer ·{" "}
          <button className="footer-version" onClick={() => onNavigate("changelog")}>
            v{APP_VERSION}
          </button>
        </div>
        <span className="footer-sep">·</span>
        <nav className="footer-links">
          <button onClick={() => onNavigate("faq")}>FAQ</button>
          <button onClick={() => onNavigate("changelog")}>Changelog</button>
          <button onClick={() => onNavigate("imprint")}>Imprint</button>
          <a href="https://github.com/karkraeg/oai-explorer-standalone" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
      </div>
    </footer>
  );
}

// ── Screen 1 — Start ──────────────────────────────────────────────────────────
function StartScreen({ onSubmit }) {
  const [val, setVal] = useState("");
  const [recent, setRecent] = useState(() => loadRecentEndpoints());
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => { if (val.trim()) onSubmit(val.trim()); };

  return (
    <main className="screen screen-start">
      <div className="hero">
        <div className="eyebrow">OAI-PMH 2.0 · Repository tool</div>
        <h1 className="hero-title">
          Browse OAI-PMH repositories.
        </h1>
        <p className="hero-sub">
          Inspect endpoints, browse sets, and read records.
        </p>

        <label className="field">

          <div className="search-row">
            <input
              ref={inputRef}
              type="url"
              className="search-input"
              placeholder="https://oai.example.org/oai"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="btn btn-primary btn-lg" onClick={submit} disabled={!val.trim()}>
              Explore
              <span className="btn-arrow">→</span>
            </button>
          </div>
          <span className="field-hint">
            Press <span className="kbd">↵</span> or click "Explore".
          </span>
        </label>

        <div className="examples">
          <span className="examples-label">Examples</span>
          <div className="chips">
            {EXAMPLE_REPOS.map((r) => (
              <button
                key={r.url}
                className="chip"
                onClick={() => onSubmit(r.url)}
                title={r.url}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {recent.length > 0 && (
          <div className="examples">
            <span className="examples-label">Recently used</span>
            <div className="chips">
              {recent.map((u) => (
                <button
                  key={u}
                  className="chip chip-recent"
                  onClick={() => onSubmit(u)}
                  title={u}
                >
                  {u.replace(/^https?:\/\//, "")}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="hero-feat">
          <div className="feat">
            <span className="feat-num">01</span>
            <div>
              <div className="feat-h">Identify · ListSets · ListMetadataFormats</div>
              <div className="feat-p">All OAI-PMH 2.0 verbs are queried and rendered in a readable layout.</div>
            </div>
          </div>
          <div className="feat">
            <span className="feat-num">02</span>
            <div>
              <div className="feat-h">Filter by set, format, and date</div>
              <div className="feat-p">Narrow identifiers down with <code>from</code>/<code>until</code> ranges and a searchable set picker.</div>
            </div>
          </div>
          <div className="feat">
            <span className="feat-num">03</span>
            <div>
              <div className="feat-h">Inspect XML records</div>
              <div className="feat-p">Full records with syntax highlighting; one-liner export commands ready to copy.</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ── Screen 2 — Explore ────────────────────────────────────────────────────────
function ExploreScreen({ url, repoData, prefilledFilters, onOpenRecord, onUrlChange }) {
  const { identify, formats, sets: initialSets, setsCount, setsTruncated,
          initPrefix, initRecords, initTotal, initToken, initLoaded, initNoRecordsMatch } = repoData;

  const defaultPrefix = prefilledFilters.metadataPrefix || loadLastMetadataPrefix(url) || initPrefix || "oai_dc";
  const defaultSet    = prefilledFilters.set ?? "";

  const [prefix,   setPrefix]   = useState(defaultPrefix);
  const [setSpec,  setSetSpec]  = useState(defaultSet);
  const [setQuery, setSetQuery] = useState("");
  const [setOpen,  setSetOpen]  = useState(false);
  const [sets,     setSets]     = useState(initialSets || []);
  const [setsLoading, setSetsLoading] = useState(false);
  const [from,     setFrom]     = useState(prefilledFilters.from  || "");
  const [until,    setUntil]    = useState(prefilledFilters.until || "");

  const [records,          setRecords]          = useState(initRecords || []);
  const [total,            setTotal]            = useState(initTotal   ?? null);
  const [resumptionToken,  setResumptionToken]  = useState(initToken   ?? null);
  const [pageHistory,      setPageHistory]      = useState([]);
  const [pageIndex,        setPageIndex]        = useState(0);
  const [loaded,           setLoaded]           = useState(initLoaded  || false);
  const [noRecordsMatch,   setNoRecordsMatch]   = useState(initNoRecordsMatch || false);
  const [loading,          setLoading]          = useState(false);
  const [loadError,        setLoadError]        = useState(null);
  const [idQuery,          setIdQuery]          = useState("");
  const [linkCopied,       setLinkCopied]       = useState(false);
  const autoLoadStarted = useRef(false);

  useEffect(() => {
    saveLastMetadataPrefix(url, prefix);
  }, [url, prefix]);

  useEffect(() => {
    if (!loaded && !loading) {
      setTotal(initTotal ?? null);
      setNoRecordsMatch(initNoRecordsMatch || false);
    }
  }, [initTotal, initNoRecordsMatch, loaded, loading]);

  const filteredSets = useMemo(() => {
    const q = setQuery.toLowerCase();
    return sets.filter((s) =>
      s.spec.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }, [sets, setQuery]);

  const loadIdentifiers = useCallback(async ({ pfx, set, fromDate, untilDate, resumptionToken = "", token = resumptionToken, history = [] }) => {
    setLoading(true);
    setLoaded(false);
    setLoadError(null);
    setNoRecordsMatch(false);
    try {
      const extra = token ? { resumptionToken: token } : { prefix: pfx };
      if (!token) {
        if (set)       extra.set   = set;
        if (fromDate)  extra.from  = fromDate;
        if (untilDate) extra.until = untilDate;
      }
      const res = await fetchApi("listIdentifiers", url, extra);
      if (res.ok) {
        setRecords(res.data.identifiers || []);
        setTotal(res.data.total ?? null);
        setResumptionToken(res.data.resumptionToken ?? null);
        setPageHistory(history);
        setPageIndex(history.length);
        setLoaded(true);
        if (!token) {
          const explorerUrl = buildExplorerUrl({ url, metadataPrefix: pfx, set, from: fromDate, until: untilDate });
          onUrlChange?.(explorerUrl);
        }
      } else if (res.oai_error === "noRecordsMatch") {
        setRecords([]);
        setTotal(null);
        setResumptionToken(null);
        setPageHistory([]);
        setPageIndex(0);
        setLoaded(true);
        setNoRecordsMatch(true);
        if (!token) {
          const explorerUrl = buildExplorerUrl({ url, metadataPrefix: pfx, set, from: fromDate, until: untilDate });
          onUrlChange?.(explorerUrl);
        }
      } else if (res.oai_error === "badResumptionToken") {
        setRecords([]);
        setResumptionToken(null);
        setLoaded(false);
        setLoadError("This result session expired. Reload the list from page 1.");
      } else {
        setLoadError(res.error || "Failed to load identifiers");
      }
    } catch (e) {
      setLoadError("Network error");
    } finally {
      setLoading(false);
    }
  }, [url]);

  const triggerLoad = () => loadIdentifiers({ pfx: prefix, set: setSpec, fromDate: from, untilDate: until, token: "", history: [] });

  const loadSets = useCallback(async () => {
    if (sets.length > 0 || setsLoading || setsCount <= 0) return;
    setSetsLoading(true);
    try {
      const res = await fetchApi("listSets", url);
      if (res.ok) setSets(res.data.sets || []);
    } catch (_) {
    } finally {
      setSetsLoading(false);
    }
  }, [sets.length, setsLoading, setsCount, url]);

  const toggleSets = () => {
    const nextOpen = !setOpen;
    setSetOpen(nextOpen);
    if (nextOpen) loadSets();
  };

  useEffect(() => {
    if (autoLoadStarted.current || loaded || loading || loadError || initNoRecordsMatch) return;
    autoLoadStarted.current = true;
    loadIdentifiers({ pfx: prefix, set: setSpec, fromDate: from, untilDate: until, token: "", history: [] });
  }, [loaded, loading, loadError, initNoRecordsMatch, loadIdentifiers, prefix, setSpec, from, until]);

  const handleJumpToRecord = () => {
    const id = idQuery.trim();
    if (!id) return;
    onOpenRecord({ identifier: id, datestamp: "", deleted: false }, prefix);
  };

  const goNextPage = async () => {
    if (!resumptionToken || loading) return;
    const nextHistory = [...pageHistory, { records, resumptionToken, pageIndex }];
    await loadIdentifiers({
      pfx: prefix,
      set: setSpec,
      fromDate: from,
      untilDate: until,
      token: resumptionToken,
      history: nextHistory,
    });
  };

  const goPrevPage = () => {
    if (pageHistory.length === 0 || loading) return;
    const previous = pageHistory[pageHistory.length - 1];
    setRecords(previous.records || []);
    setResumptionToken(previous.resumptionToken ?? null);
    setPageHistory(pageHistory.slice(0, -1));
    setPageIndex(previous.pageIndex ?? 0);
    setLoaded(true);
    setNoRecordsMatch(false);
    setLoadError(null);
  };

  const resetFiltersAndReload = async () => {
    const fallbackPrefix = formats.find((f) => f.value === "oai_dc")?.value
      || formats[0]?.value
      || "oai_dc";
    setPrefix(fallbackPrefix);
    setSetSpec("");
    setSetQuery("");
    setFrom("");
    setUntil("");
    await loadIdentifiers({ pfx: fallbackPrefix, set: "", fromDate: "", untilDate: "", token: "", history: [] });
  };

  const totalDisplay = total !== null
    ? `~${total.toLocaleString("de-DE")}`
    : null;

  return (
    <main className="screen screen-explore">
      <div className="explore-grid">

        {/* LEFT — Repository info */}
        <aside className="info-card">
          <div className="info-head">
            <span className="info-eyebrow">Repository</span>
          </div>
          <h2 className="info-title">{identify.repositoryName || url}</h2>
          <div className="info-url" title={identify.baseURL || url}>
            {identify.baseURL || url}
          </div>

          <dl className="info-list">
            {identify.adminEmail && (
              <div className="info-row">
                <dt>Admin email</dt>
                <dd><a href={`mailto:${identify.adminEmail}`}>{identify.adminEmail}</a></dd>
              </div>
            )}
            {identify.earliestDatestamp && (
              <div className="info-row">
                <dt>Earliest datestamp</dt>
                <dd className="mono">{identify.earliestDatestamp}</dd>
              </div>
            )}
            {identify.granularity && (
              <div className="info-row">
                <dt>Granularity</dt>
                <dd className="mono">{identify.granularity}</dd>
              </div>
            )}
          </dl>

          <div className="info-counts">
            <div className="count">
              <div className="count-num">{formats.length || "—"}</div>
              <div className="count-lbl">Formats</div>
            </div>
            <div className="count">
              <div className="count-num">
                {setsCount > 0 ? (setsTruncated ? `${setsCount}+` : setsCount) : "—"}
              </div>
              <div className="count-lbl">Sets</div>
            </div>
            <div className="count">
              <div className="count-num">{totalDisplay || "—"}</div>
              <div className="count-lbl">Records</div>
            </div>
          </div>
        </aside>

        {/* RIGHT — Filters + table */}
        <section className="explore-main">
          <div className="filters">
            <div className="filter-row">
              <div className="filter">
                <label className="lbl" htmlFor="metadata-prefix">Metadata prefix</label>
                <select
                  id="metadata-prefix"
                  className="select"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                >
                  {formats.length > 0
                    ? formats.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))
                    : <option value="oai_dc">oai_dc</option>
                  }
                </select>
              </div>

              <div className="filter">
                <span className="lbl" id="set-label">Set</span>
                <SetCombobox
                  labelId="set-label"
                  value={setSpec}
                  query={setQuery}
                  open={setOpen}
                  allSets={sets}
                  onQueryChange={setSetQuery}
                  onToggle={toggleSets}
                  onClose={() => setSetOpen(false)}
                  onSelect={(s) => { setSetSpec(s.spec); setSetOpen(false); setSetQuery(""); }}
                  onClear={() => { setSetSpec(""); setSetOpen(false); }}
                  options={filteredSets}
                  loading={setsLoading}
                />
              </div>
            </div>

            <div className="filter-row filter-row--dates">
              <div className="filter">
                <label className="lbl" htmlFor="date-from">From <span className="lbl-opt">(optional)</span></label>
                <input id="date-from" type="date" className="select" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="filter">
                <label className="lbl" htmlFor="date-until">Until <span className="lbl-opt">(optional)</span></label>
                <input id="date-until" type="date" className="select" value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
              <div className="filter filter-action">
                <button className="btn btn-primary" onClick={triggerLoad} disabled={loading}>
                  {loading && <span className="loading-spinner loading-spinner--inline" aria-hidden="true" />}
                  {loading ? "Loading…" : "Load identifiers"}
                </button>
              </div>
            </div>

            <div className="filter-row filter-row--jump">
              <div className="filter">
                <label className="lbl" htmlFor="record-identifier">Jump to record by identifier</label>
                <input
                  id="record-identifier"
                  type="text"
                  className="select mono"
                  placeholder="oai:example.org:1234"
                  value={idQuery}
                  onChange={(e) => setIdQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJumpToRecord()}
                />
              </div>
              <div className="filter filter-action">
                <button className="btn" onClick={handleJumpToRecord} disabled={!idQuery.trim()}>
                  Go to record →
                </button>
              </div>
            </div>
          </div>

          <SyncCommand
            baseURL={url}
            prefix={prefix}
            setSpec={setSpec}
            from={from}
            until={until}
          />

          <div className="results">
            <div className="results-head">
              <div className="results-caption" role="status" aria-live="polite">
                {loaded ? (
                  <>
                    <strong>{records.length.toLocaleString("de-DE")}</strong>
                    {totalDisplay && <> of {totalDisplay} total</>}
                    <span className="results-sep">·</span>
                    <span className="results-meta">page={pageIndex + 1}</span>
                    <span className="results-sep">·</span>
                    <span className="results-meta">prefix={prefix}</span>
                    {setSpec && (<><span className="results-sep">·</span><span className="results-meta">set={setSpec}</span></>)}
                  </>
                ) : loading ? (
                  "Loading identifiers…"
                ) : (
                  "No data loaded"
                )}
              </div>
              {loaded && (
                <button
                  className="cmd-copy-mini"
                  aria-live="polite"
                  onClick={() => {
                    navigator.clipboard?.writeText(buildExplorerUrl({ url, metadataPrefix: prefix, set: setSpec, from, until }));
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 1500);
                  }}
                >
                  {linkCopied ? "✓ Copied" : "Copy link"}
                </button>
              )}
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: "70%" }}>Identifier</th>
                    <th style={{ width: "30%" }}>Datestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {loaded && records.map((r) => (
                    <tr
                      key={r.identifier}
                    >
                      <td className="mono cell-id">
                        <span className="cell-id-content">
                          <button className="record-link mono" onClick={() => onOpenRecord(r, prefix)}>
                            {r.identifier}
                          </button>
                          {r.deleted && <span className="badge badge-deleted">deleted</span>}
                        </span>
                      </td>
                      <td className="mono cell-date">{r.datestamp}</td>
                    </tr>
                  ))}
                  {loading && Array.from({ length: 8 }).map((_, i) => (
                    <tr key={"sk" + i}>
                      <td><span className="skeleton" style={{ width: "70%", display: "inline-block" }} /></td>
                      <td><span className="skeleton" style={{ width: "60%", display: "inline-block" }} /></td>
                    </tr>
                  ))}
                  {loaded && records.length === 0 && noRecordsMatch && (
                    <tr>
                      <td colSpan="2" className="empty" style={{ color: "var(--text-dim)" }}>
                        <div style={{ marginBottom: 10 }}>
                          The endpoint returned <span className="mono">noRecordsMatch</span> for this filter combination
                          (metadataPrefix, set, from, until).
                        </div>
                        <button className="btn" style={{ margin: "0 auto", display: "flex" }} onClick={resetFiltersAndReload}>
                          Reset filters and retry
                        </button>
                      </td>
                    </tr>
                  )}
                  {loaded && records.length === 0 && !noRecordsMatch && (
                    <tr>
                      <td colSpan="2" className="empty" style={{ color: "var(--text-dim)" }}>
                        No records match the current filter combination. Try adjusting the date range or set filter.
                      </td>
                    </tr>
                  )}
                  {!loaded && !loading && !loadError && (
                    <tr>
                      <td colSpan="2" className="empty">
                        <button
                          className="btn btn-primary"
                          style={{ margin: "0 auto", display: "flex" }}
                          onClick={triggerLoad}
                        >
                          Load identifiers →
                        </button>
                      </td>
                    </tr>
                  )}
                  {!loaded && !loading && loadError && (
                    <tr>
                      <td colSpan="2" className="empty text-error" role="alert">
                        <div style={{ marginBottom: 12 }}>{loadError}</div>
                        <button className="btn" style={{ margin: "0 auto", display: "flex" }} onClick={triggerLoad}>
                          Retry
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {loaded && resumptionToken && (
              <div className="pager">
                <span className="pager-info mono">page {pageIndex + 1}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-ghost" onClick={goPrevPage} disabled={loading || pageHistory.length === 0}>
                    ← Previous
                  </button>
                  <button className="btn-ghost" onClick={goNextPage} disabled={loading || !resumptionToken}>
                    Next →
                  </button>
                </div>
              </div>
            )}
            {loaded && !resumptionToken && pageIndex > 0 && (
              <div className="pager">
                <span className="pager-info mono">page {pageIndex + 1}</span>
                <button className="btn-ghost" onClick={goPrevPage} disabled={loading || pageHistory.length === 0}>
                  ← Previous
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

// ── Set combobox ──────────────────────────────────────────────────────────────
function SetCombobox({ value, query, open, allSets, labelId, onQueryChange, onToggle, onClose, onSelect, onClear, options, loading = false }) {
  const ref = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const selected = allSets.find((s) => s.spec === value);
  const handleKeyDown = (e) => {
    if (!open && ["ArrowDown", "ArrowUp"].includes(e.key)) {
      onToggle();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && open) {
      onClose();
      triggerRef.current?.focus();
      return;
    }
    if (!open || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = [...ref.current.querySelectorAll(".combo-item")];
    const current = items.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? Math.min(current + 1, items.length - 1)
      : Math.max(current - 1, 0);
    items[next]?.focus();
    e.preventDefault();
  };

  return (
    <div className={`combobox ${open ? "is-open" : ""}`} ref={ref} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="combo-trigger"
        onClick={onToggle}
        aria-labelledby={`${labelId} set-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="set-options"
      >
        <span id="set-value">
          {value
            ? (<><span className="combo-spec mono">{value}</span><span className="combo-name">{selected?.name || ""}</span></>)
            : (<span className="combo-name" style={{ color: "var(--text-dim)" }}>All sets</span>)
          }
        </span>
        <span className="combo-caret">▾</span>
      </button>
      {open && (
        <div className="combo-pop">
          <div className="combo-search">
            <input
              autoFocus
              type="text"
              aria-label="Search sets"
              placeholder="Search sets…"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
            <span className="combo-count">{options.length}</span>
          </div>
          <div className="combo-list" id="set-options" role="listbox" aria-labelledby={labelId}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className={`combo-item ${!value ? "is-active" : ""}`}
              onClick={() => { onClear(); triggerRef.current?.focus(); }}
            >
              <span className="combo-item-name">All sets (no filter)</span>
            </button>
            {options.length === 0 && (
              <div className="combo-empty">{loading ? "Loading sets…" : "No matches"}</div>
            )}
            {options.map((o) => (
              <button
                key={o.spec}
                type="button"
                role="option"
                aria-selected={o.spec === value}
                className={`combo-item ${o.spec === value ? "is-active" : ""}`}
                onClick={() => { onSelect(o); triggerRef.current?.focus(); }}
              >
                <span className="combo-item-name">
                  {o.name} <code className="combo-item-spec">{o.spec}</code>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Screen 3 — Record ─────────────────────────────────────────────────────────
function RecordScreen({ url, record, prefix, formats, onBack }) {
  const [xmlData,  setXmlData]  = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [fetchErr, setFetchErr] = useState(null);
  const [xmlCopied, setXmlCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [oaiUrlCopied, setOaiUrlCopied] = useState(false);
  const [lineLinkCopied, setLineLinkCopied] = useState(false);
  const [currentPrefix, setCurrentPrefix] = useState(prefix || "oai_dc");
  const [selection, setSelection] = useState(null); // { start, end } 1-indexed line numbers
  const [outlineLine, setOutlineLine] = useState(null);
  const [showLineHint, setShowLineHint] = useState(false);
  const selectionAnchorRef = useRef(null);
  const initialHashRef = useRef(location.hash);
  const hasRestoredHashRef = useRef(false);
  const recordOaiUrl = useMemo(() => {
    const sp = new URLSearchParams({
      verb: "GetRecord",
      identifier: record.identifier,
      metadataPrefix: currentPrefix || "oai_dc",
    });
    return `${url}?${sp.toString()}`;
  }, [url, record.identifier, currentPrefix]);

  const prefixOptions = useMemo(() => {
    if (formats?.length) return formats;
    return [{ value: currentPrefix || "oai_dc", label: currentPrefix || "oai_dc" }];
  }, [formats, currentPrefix]);

  useEffect(() => {
    setCurrentPrefix(prefix || "oai_dc");
  }, [record.identifier, prefix]);

  useEffect(() => {
    saveLastMetadataPrefix(url, currentPrefix);
  }, [url, currentPrefix]);

  useEffect(() => {
    history.replaceState({}, "", buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: currentPrefix }));
  }, [url, record.identifier, currentPrefix]);

  useEffect(() => {
    setLoading(true);
    setFetchErr(null);
    fetchApi("getRecord", url, { identifier: record.identifier, prefix: currentPrefix || "oai_dc" })
      .then((res) => {
        if (res.ok) setXmlData(res.data);
        else        setFetchErr(res.error || "Failed to load record");
      })
      .catch(() => setFetchErr("Network error"))
      .finally(() => setLoading(false));
  }, [url, record.identifier, currentPrefix]);

  const xml = xmlData?.xml || "";
  const dc  = xmlData?.dc  || {};
  const sections = useMemo(() => detectSections(xml), [xml]);

  const maybeShowLineHint = () => {
    try {
      if (localStorage.getItem(LINE_HINT_KEY)) return;
      localStorage.setItem(LINE_HINT_KEY, "1");
    } catch (_) {}
    setShowLineHint(true);
  };

  // Restore a shared #L12-L34 selection once the record's XML has loaded.
  useEffect(() => {
    if (!xml) return;
    if (!hasRestoredHashRef.current) {
      hasRestoredHashRef.current = true;
      const sel = parseLineHash(initialHashRef.current);
      if (sel) {
        setSelection(sel);
        selectionAnchorRef.current = sel.start;
        maybeShowLineHint();
        requestAnimationFrame(() => {
          document.getElementById(`L${sel.start}`)?.scrollIntoView({ block: "center" });
        });
        return;
      }
    }
    setSelection(null);
    setOutlineLine(null);
    selectionAnchorRef.current = null;
  }, [xml]);

  const selectLine = (lineNum, extend) => {
    let sel;
    if (extend && selectionAnchorRef.current != null) {
      const anchor = selectionAnchorRef.current;
      sel = { start: Math.min(anchor, lineNum), end: Math.max(anchor, lineNum) };
    } else {
      selectionAnchorRef.current = lineNum;
      sel = { start: lineNum, end: lineNum };
    }
    setSelection(sel);
    history.replaceState({}, "", buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: currentPrefix }) + lineHashFor(sel));
    maybeShowLineHint();
  };

  const copyXml = () => {
    navigator.clipboard?.writeText(xml);
    setXmlCopied(true);
    setTimeout(() => setXmlCopied(false), 1500);
  };

  const downloadXml = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    a.download = xmlDownloadName(record.identifier, currentPrefix);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
  };

  const copyLineLink = () => {
    if (!selection) return;
    const link = buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: currentPrefix }) + lineHashFor(selection);
    navigator.clipboard?.writeText(link);
    setLineLinkCopied(true);
    setTimeout(() => setLineLinkCopied(false), 1500);
  };

  const jumpToSection = (section) => {
    setOutlineLine(section.line);
    document.getElementById(`L${section.line}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <main className="screen screen-record">
      <button className="back-link" onClick={onBack}>
        <span className="back-arrow">←</span> Back to list
      </button>

      <nav className="breadcrumb mono" aria-label="Breadcrumb">
        <span className="bc-base">{url}</span>
        <span className="bc-sep">/</span>
        <span className="bc-cur">{record.identifier}</span>
      </nav>

      <header className="record-head">
        <div>
          <div className="record-eyebrow">GetRecord · {currentPrefix || "oai_dc"}</div>
          <h1 className="record-title">
            {dc.title?.[0] || record.identifier}
          </h1>
          <div className="record-meta mono">
            <span>datestamp: {xmlData?.datestamp || record.datestamp}</span>
            <span>deleted: {(xmlData ? xmlData.deleted : record.deleted) ? "true" : "false"}</span>
            {xmlData?.setSpecs?.length > 0 && (
              <span>setSpec: {xmlData.setSpecs[0]}</span>
            )}
          </div>
          <div className="record-url mono">
            <span className="record-url-label">OAI URL: </span>
            <a href={recordOaiUrl} target="_blank" rel="noopener noreferrer">
              {recordOaiUrl}
            </a>
            <button
              className="cmd-copy-mini"
              style={{ flexShrink: 0 }}
              onClick={() => {
                navigator.clipboard?.writeText(recordOaiUrl);
                setOaiUrlCopied(true);
                setTimeout(() => setOaiUrlCopied(false), 1500);
              }}
            >
              {oaiUrlCopied ? "✓ Copied" : "Copy OAI URL"}
            </button>
            <button
              className="cmd-copy-mini"
              style={{ flexShrink: 0 }}
              onClick={() => {
                navigator.clipboard?.writeText(buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: currentPrefix }));
                setLinkCopied(true);
                setTimeout(() => setLinkCopied(false), 1500);
              }}
            >
              {linkCopied ? "✓ Copied" : "Copy Explorer link"}
            </button>
          </div>
        </div>
        <div className="record-actions">
          <label className="record-prefix-switcher">
            <span className="record-prefix-label">metadataPrefix</span>
            <select
              className="record-prefix-select"
              value={currentPrefix || "oai_dc"}
              onChange={(e) => setCurrentPrefix(e.target.value)}
            >
              {prefixOptions.map((format) => (
                <option key={format.value} value={format.value}>{format.label}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div className="skeleton" style={{ width: 200, height: 12, display: "inline-block" }} />
          <p className="results-caption" style={{ marginTop: 12 }}>Loading record…</p>
        </div>
      )}

      {fetchErr && (
        <div className="record-error" role="alert">
          <div style={{ marginBottom: 12 }}>
            Error: {fetchErr}
          </div>
          <div className="record-url mono" style={{ marginTop: 0 }}>
            <span className="record-url-label">OAI URL</span>
            <a href={recordOaiUrl} target="_blank" rel="noopener noreferrer">
              {recordOaiUrl}
            </a>
          </div>
        </div>
      )}

      {!loading && xml && (
        <section className="code-block">
          <div className="code-head">
            <div className="code-tabs">
              <span className="code-tab is-active">XML</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="code-meta mono">{xml.length.toLocaleString()} bytes</div>
              {selection && (
                <button className="cmd-copy-mini" onClick={copyLineLink} aria-live="polite">
                  {lineLinkCopied ? "✓ Copied" : `Copy link to ${selection.start === selection.end ? `L${selection.start}` : `L${selection.start}-${selection.end}`}`}
                </button>
              )}
              <button className="cmd-copy-mini" onClick={downloadXml}>Download XML</button>
              <button className="cmd-copy-mini" onClick={copyXml} aria-live="polite">{xmlCopied ? "✓ Copied" : "Copy"}</button>
            </div>
          </div>
          <OutlineBar sections={sections} onJump={jumpToSection} />
          {showLineHint && (
            <div className="line-hint" role="status">
              <span>
                Heads up: a line link points at the document as fetched just now. Records here aren't versioned, so if the source updates the metadata later, the content — and which line this points to — can shift.
              </span>
              <button
                type="button"
                className="line-hint-dismiss"
                onClick={() => setShowLineHint(false)}
                aria-label="Dismiss"
              >×</button>
            </div>
          )}
          <XmlLines xml={xml} sections={sections} selection={selection} outlineLine={outlineLine} onSelectLine={selectLine} />
        </section>
      )}

    </main>
  );
}

// ── XML section outline ───────────────────────────────────────────────────────
function detectSections(xml) {
  if (!xml) return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return null;
  const metadata = findElement(doc.documentElement, "metadata");
  const root = firstElementChild(metadata) || doc.documentElement;
  const children = Array.from(root.children || []);
  const sections = children.length ? children : [root];
  const lines = xml.split("\n");
  const seen = new Set();
  return sections.map((el) => {
    const name = sectionLabel(el);
    if (seen.has(name)) return null;
    seen.add(name);
    const line = findElementLine(lines, el);
    return { id: `sec-${name.replace(/[^\w.-]+/g, "_")}-${line || seen.size}`, name, line: line || 1 };
  }).filter(Boolean);
}

function sectionLabel(el) {
  const name = el.nodeName || el.localName;
  for (const attr of ["tag", "code", "type", "name", "ID", "id"]) {
    const value = el.getAttribute?.(attr);
    if (value) return `${name} ${attr}=${value}`;
  }
  return name;
}

function findElementLine(lines, el) {
  const localName = el.localName || el.nodeName;
  const tagStart = `<\\s*[\\w.-]*:?${escapeRegExp(localName)}[\\s>/]`;
  const attr = ["tag", "code", "type", "name", "ID", "id"].find(name => el.getAttribute?.(name));
  if (attr) {
    const value = escapeRegExp(el.getAttribute(attr));
    const withAttr = new RegExp(`<\\s*[\\w.-]*:?${escapeRegExp(localName)}\\b[^>]*\\s${attr}=(["'])${value}\\1`);
    const line = lines.findIndex(raw => withAttr.test(raw)) + 1;
    if (line) return line;
  }
  return lines.findIndex(raw => new RegExp(tagStart).test(raw)) + 1;
}

function findElement(el, localName) {
  if (!el) return null;
  if (el.localName === localName) return el;
  for (const child of el.children || []) {
    const found = findElement(child, localName);
    if (found) return found;
  }
  return null;
}

function firstElementChild(el) {
  return Array.from(el?.children || [])[0] || null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildXmlLines(xml, sections) {
  const sectionsByLine = new Map((sections || []).map(section => [section.line, section]));
  return xml.split("\n").map((raw, i) => {
    let html = highlightXml(raw);
    const section = sectionsByLine.get(i + 1);
    if (section) {
      html = `<span id="${section.id}" class="sec-anchor"></span>${html}`;
    }
    return { num: i + 1, html: linkXmlUrls(html) };
  });
}

function XmlLines({ xml, sections, selection, outlineLine, onSelectLine }) {
  const lines = useMemo(() => buildXmlLines(xml, sections), [xml, sections]);
  return (
    <pre className="code">
      <code>
        {lines.map((l) => {
          const isSelected = !!selection && l.num >= selection.start && l.num <= selection.end;
          const isOutlineHighlighted = l.num === outlineLine;
          return (
            <span key={l.num} id={`L${l.num}`} className={`code-line${isSelected ? " is-selected" : ""}${isOutlineHighlighted ? " is-outline-highlighted" : ""}`}>
              <button
                type="button"
                className="code-linenum"
                aria-label={`Select line ${l.num}`}
                onClick={(e) => onSelectLine(l.num, e.shiftKey)}
              >{l.num}</button>
              <span className="code-line-content" dangerouslySetInnerHTML={{ __html: l.html }} />
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function OutlineBar({ sections, onJump }) {
  if (!sections?.length) return null;
  return (
    <nav className="xml-outline" aria-label="Document sections">
      <span className="xml-outline-label">Jump to</span>
      {sections.map(section => (
        <a
          key={section.id}
          className="xml-outline-link"
          href={`#${section.id}`}
          onClick={(e) => {
            e.preventDefault();
            onJump(section);
          }}
        >{section.name}</a>
      ))}
    </nav>
  );
}

// ── XML syntax highlighter ────────────────────────────────────────────────────
function highlightXml(xml) {
  let s = xml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="x-com">$1</span>');
  s = s.replace(/(&lt;\?[\s\S]*?\?&gt;)/g,  '<span class="x-decl">$1</span>');
  s = s.replace(
    /(&lt;\/?)([a-zA-Z_][\w:-]*)([^&]*?)(\/?&gt;)/g,
    (m, lt, tag, rest, gt) => {
      const attrs = rest.replace(
        /([a-zA-Z_:][\w:.-]*)=("[^"]*"|'[^']*')/g,
        '<span class="x-attr">$1</span>=<span class="x-val">$2</span>'
      );
      return `<span class="x-punct">${lt}</span><span class="x-tag">${tag}</span>${attrs}<span class="x-punct">${gt}</span>`;
    }
  );
  return s;
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function linkXmlUrls(html) {
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        const href = decodeHtmlEntities(url);
        return `<a class="xml-url" href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });
    })
    .join("");
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
