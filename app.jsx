/* global React, ReactDOM */
const { useState, useMemo, useEffect, useRef, useCallback } = React;

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

  // Restore state from explorer share URL on first load
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const u = sp.get("url");
    if (!u) return;
    const identifier    = sp.get("identifier") || "";
    const metadataPrefix = sp.get("metadataPrefix") || "";
    const set   = sp.get("set")   || "";
    const from  = sp.get("from")  || "";
    const until = sp.get("until") || "";
    if (identifier) setAutoOpenRecord({ identifier, prefix: metadataPrefix });
    goExplore(u, null, { metadataPrefix, set, from, until });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open a record after repo data loads (triggered by share URL with identifier=)
  useEffect(() => {
    if (screen === "explore" && repoData && autoOpenRecord) {
      setActiveRecord({ record: { identifier: autoOpenRecord.identifier }, prefix: autoOpenRecord.prefix, formats: repoData.formats });
      setScreen("record");
      setAutoOpenRecord(null);
    }
  }, [screen, repoData, autoOpenRecord]);

  const goExplore = useCallback(async (rawUrl, broken, overrideFilters = null) => {
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

    setUrl(baseUrl);
    setPrefilledFilters(filters);
    setError(null);
    setRepoData(null);
    setActiveRecord(null);
    setLoadingStep(0);
    setScreen("loading");

    try {
      const identifyRes = await fetchApi("identify", baseUrl);
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
      history.replaceState({}, "", exploreUrl);
      setLastExploreUrl(exploreUrl);
    } catch (e) {
      setError({ kind: "unreachable", url: baseUrl });
      setScreen("error");
    }
  }, []);

  return (
    <div className="app">
      <TopBar
        screen={screen}
        url={url}
        onHome={() => { setScreen("start"); history.replaceState({}, "", location.pathname); }}
        onChangeUrl={(u) => { goExplore(u); }}
        onNavigate={(s) => setScreen(s)}
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
            history.replaceState({}, "", buildExplorerUrl({ url, identifier: record.identifier, metadataPrefix: prefix }));
          }}
          onUrlChange={(u) => setLastExploreUrl(u)}
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
            if (lastExploreUrl) history.replaceState({}, "", lastExploreUrl);
          }}
        />
      )}
      {screen === "faq" && (
        <FaqScreen onBack={() => setScreen(url ? "explore" : "start")} />
      )}
      {screen === "imprint" && (
        <ImprintScreen onBack={() => setScreen(url ? "explore" : "start")} />
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
    <main className="screen screen-start" style={{ paddingTop: 120 }}>
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
function SyncCommand({ baseURL, prefix, setSpec, from, until, variant = "sidebar" }) {
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
    <section className={`cmd-block cmd-block--${variant}`}>
      <div className="cmd-label">
        <span>Sync from CLI</span>
        <button className="cmd-copy-mini" onClick={copy}>
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
        Current request URL: {" "}
        <a href={currentRequestUrl} target="_blank" rel="noopener noreferrer">
          {currentRequestUrl}
        </a>
      </div>
    </section>
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
      src="logo.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────
function TopBar({ screen, url, onHome, onChangeUrl, onNavigate }) {
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
      a: "Repositories return a resumptionToken when the result set exceeds their page limit. The harvester replays the request with that token until it comes back empty." },
    { q: "Is this tool affiliated with any specific repository?",
      a: "No — it's a generic OAI-PMH 2.0 client. Any compliant endpoint should work; the example chips on the start screen are popular German and international repositories." },
    { q: "Are requests cached?",
      a: "Yes — the server caches every OAI-PMH response in a local SQLite database. The TTL is two hours." },
    { q: "Can everybody see what I explored under 'RECENTLY USED'?",
      a: "No, that's only shown to you."
    }
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
          This site sets <strong>no cookies</strong>. It stores one entry in your
          browser's <code>localStorage</code> (key: <code>oai_recent_endpoints</code>)
          to remember the last five OAI-PMH endpoints you visited. This data never
          leaves your device and is not shared with any third party. You can clear it
          at any time via your browser's developer tools.
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
        <div className="footer-brand mono">OAI-PMH Explorer · v1.1.1</div>
        <span className="footer-sep">·</span>
        <nav className="footer-links">
          <button onClick={() => onNavigate("faq")}>FAQ</button>
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
          Explore OAI-PMH <em>repositories</em>.
        </h1>
        <p className="hero-sub">
          Inspect endpoints, browse sets, and read records —
          all in the browser, no command line required.
        </p>

        <label className="field">
          <span className="field-label">OAI-PMH repository URL</span>
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
              Connect
              <span className="btn-arrow">→</span>
            </button>
          </div>
          <span className="field-hint">
            Press <span className="kbd">↵</span> or click "Connect". The URL must expose a <code>?verb=Identify</code> endpoint.
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
                  className="chip"
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
  const { identify, formats, sets, setsTruncated,
          initPrefix, initRecords, initTotal, initToken, initLoaded, initNoRecordsMatch } = repoData;

  const defaultPrefix = prefilledFilters.metadataPrefix || initPrefix || "oai_dc";
  const defaultSet    = prefilledFilters.set ?? "";

  const [prefix,   setPrefix]   = useState(defaultPrefix);
  const [setSpec,  setSetSpec]  = useState(defaultSet);
  const [setQuery, setSetQuery] = useState("");
  const [setOpen,  setSetOpen]  = useState(false);
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
  const [hoverRow,         setHoverRow]         = useState(null);
  const [idQuery,          setIdQuery]          = useState("");
  const [linkCopied,       setLinkCopied]       = useState(false);

  const filteredSets = useMemo(() => {
    const q = setQuery.toLowerCase();
    return sets.filter((s) =>
      s.spec.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }, [sets, setQuery]);

  const loadIdentifiers = useCallback(async ({ pfx, set, fromDate, untilDate, resumptionToken: token = "", history = [] }) => {
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
          window.history.replaceState({}, "", explorerUrl);
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
                {sets.length > 0 ? (setsTruncated ? `${sets.length}+` : sets.length) : "—"}
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
                <label className="lbl">Metadata prefix</label>
                <select
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
                <label className="lbl">Set</label>
                <SetCombobox
                  value={setSpec}
                  query={setQuery}
                  open={setOpen}
                  allSets={sets}
                  onQueryChange={setSetQuery}
                  onToggle={() => setSetOpen(!setOpen)}
                  onClose={() => setSetOpen(false)}
                  onSelect={(s) => { setSetSpec(s.spec); setSetOpen(false); setSetQuery(""); }}
                  onClear={() => { setSetSpec(""); setSetOpen(false); }}
                  options={filteredSets}
                />
              </div>
            </div>

            <div className="filter-row">
              <div className="filter">
                <label className="lbl">From <span className="lbl-opt">(optional)</span></label>
                <input type="date" className="select" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="filter">
                <label className="lbl">Until <span className="lbl-opt">(optional)</span></label>
                <input type="date" className="select" value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
              <div className="filter filter-action">
                <button className="btn btn-primary" onClick={triggerLoad} disabled={loading}>
                  {loading && <span className="loading-spinner loading-spinner--inline" aria-hidden="true" />}
                  {loading ? "Loading…" : "Load identifiers"}
                </button>
              </div>
            </div>

            <div className="filter-row">
              <div className="filter" style={{ flex: 1 }}>
                <label className="lbl">Jump to record by identifier <span className="lbl-opt">(optional)</span></label>
                <input
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
            variant="explore"
          />

          <div className="results">
            <div className="results-head">
              <div className="results-caption">
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
                    <th style={{ width: "55%" }}>Identifier</th>
                    <th style={{ width: "30%" }}>Datestamp</th>
                    <th style={{ width: "15%" }}>Deleted</th>
                  </tr>
                </thead>
                <tbody>
                  {loaded && records.map((r, i) => (
                    <tr
                      key={r.identifier}
                      onMouseEnter={() => setHoverRow(i)}
                      onMouseLeave={() => setHoverRow(null)}
                      onClick={() => onOpenRecord(r, prefix)}
                      className={hoverRow === i ? "row-hover" : ""}
                    >
                      <td className="mono cell-id">
                        <span className="cell-id-text">{r.identifier}</span>
                      </td>
                      <td className="mono cell-date">{r.datestamp}</td>
                      <td>
                        {r.deleted
                          ? <span className="badge badge-deleted">deleted</span>
                          : <span className="badge-empty">—</span>
                        }
                      </td>
                    </tr>
                  ))}
                  {loading && Array.from({ length: 8 }).map((_, i) => (
                    <tr key={"sk" + i}>
                      <td><span className="skeleton" style={{ width: "70%", display: "inline-block" }} /></td>
                      <td><span className="skeleton" style={{ width: "60%", display: "inline-block" }} /></td>
                      <td><span className="skeleton" style={{ width: "30%", display: "inline-block" }} /></td>
                    </tr>
                  ))}
                  {loaded && records.length === 0 && noRecordsMatch && (
                    <tr>
                      <td colSpan="3" className="empty" style={{ color: "var(--text-dim)" }}>
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
                      <td colSpan="3" className="empty" style={{ color: "var(--text-dim)" }}>
                        No records match the current filter combination. Try adjusting the date range or set filter.
                      </td>
                    </tr>
                  )}
                  {!loaded && !loading && !loadError && (
                    <tr>
                      <td colSpan="3" className="empty">
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
                      <td colSpan="3" className="empty" style={{ color: "oklch(0.55 0.20 25)" }}>
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
function SetCombobox({ value, query, open, allSets, onQueryChange, onToggle, onClose, onSelect, onClear, options }) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const selected = allSets.find((s) => s.spec === value);

  return (
    <div className={`combobox ${open ? "is-open" : ""}`} ref={ref}>
      <button type="button" className="combo-trigger" onClick={onToggle}>
        {value
          ? (<><span className="combo-spec mono">{value}</span><span className="combo-name">{selected?.name || ""}</span></>)
          : (<span className="combo-name" style={{ color: "var(--text-dim)" }}>All sets</span>)
        }
        <span className="combo-caret">▾</span>
      </button>
      {open && (
        <div className="combo-pop">
          <div className="combo-search">
            <input
              autoFocus
              type="text"
              placeholder="Search sets…"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
            <span className="combo-count">{options.length}</span>
          </div>
          <div className="combo-list">
            <button
              className={`combo-item ${!value ? "is-active" : ""}`}
              onClick={onClear}
            >
              <span className="combo-item-name">All sets (no filter)</span>
            </button>
            {options.length === 0 && (
              <div className="combo-empty">No matches</div>
            )}
            {options.map((o) => (
              <button
                key={o.spec}
                className={`combo-item ${o.spec === value ? "is-active" : ""}`}
                onClick={() => onSelect(o)}
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
  const [currentPrefix, setCurrentPrefix] = useState(prefix || "oai_dc");
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

  const copyXml = () => {
    navigator.clipboard?.writeText(xml);
    setXmlCopied(true);
    setTimeout(() => setXmlCopied(false), 1500);
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
          <button className="btn-ghost" onClick={copyXml} disabled={!xml}>
            {xmlCopied ? "✓ Copied" : "Copy XML"}
          </button>
        </div>
      </header>

      {loading && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div className="skeleton" style={{ width: 200, height: 12, display: "inline-block" }} />
          <p className="results-caption" style={{ marginTop: 12 }}>Loading record…</p>
        </div>
      )}

      {fetchErr && (
        <div style={{ padding: "24px 0", color: "oklch(0.55 0.20 25)", fontSize: 13 }}>
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
              <button className="cmd-copy-mini" onClick={copyXml}>{xmlCopied ? "✓ Copied" : "Copy"}</button>
            </div>
          </div>
          <OutlineBar sections={sections} />
          <pre className="code"><code dangerouslySetInnerHTML={{ __html: injectAnchors(highlightXml(xml), sections) }} /></pre>
        </section>
      )}

    </main>
  );
}

// ── XML section outline ───────────────────────────────────────────────────────
const METS_SECTIONS = ['metsHdr','dmdSec','amdSec','fileSec','structMap','structLink','behaviorSec'];
const MODS_SECTIONS = ['titleInfo','name','originInfo','physicalDescription','abstract','subject','relatedItem','location','accessCondition','recordInfo'];

function detectSections(xml) {
  if (!xml) return null;
  const isMets = xml.includes('www.loc.gov/METS/');
  const isMods = xml.includes('www.loc.gov/mods');
  if (!isMets && !isMods) return null;
  const candidates = isMets ? METS_SECTIONS : MODS_SECTIONS;
  const found = candidates.filter(name => new RegExp(`<[\\w]*:?${name}[\\s>/]`).test(xml));
  return found.length ? found : null;
}

function injectAnchors(html, sections) {
  if (!sections) return html;
  let result = html;
  for (const name of sections) {
    const re = new RegExp(`(<span class="x-tag">[\\w]*:?${name}</span>)`);
    result = result.replace(re, `<span id="sec-${name}" class="sec-anchor"></span>$1`);
  }
  return result;
}

function OutlineBar({ sections }) {
  if (!sections?.length) return null;
  return (
    <nav className="xml-outline" aria-label="Document sections">
      <span className="xml-outline-label">Jump to</span>
      {sections.map(name => (
        <a
          key={name}
          className="xml-outline-link"
          href={`#sec-${name}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(`sec-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        >{name}</a>
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

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
