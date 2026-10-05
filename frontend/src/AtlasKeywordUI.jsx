import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./lib/utils";

const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";
const AUTH_TOKEN_KEY = "atlas_auth_token";
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3000"
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);

async function fetchJson(url) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    headers: {
      "ngrok-skip-browser-warning": "69420",
      ...(token ? { "x-atlas-token": token } : {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error("Invalid server response."); }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  return data;
}

function labelForDistinctiveness(score) {
  const value = Number(score) || 0;
  if (value >= 75) return "Very high";
  if (value >= 50) return "High";
  if (value >= 25) return "Medium";
  return "Low";
}

function useDrawerMount() {
  const [mount, setMount] = useState(null);

  useEffect(() => {
    let currentFixedSlot = null;
    let originalSlot = null;
    let scheduled = false;

    const scan = () => {
      scheduled = false;
      const playLink = document.querySelector('aside a[href*="play.google.com/store/apps/details?id="]');
      if (!playLink) {
        if (currentFixedSlot) currentFixedSlot.remove();
        if (originalSlot) originalSlot.style.display = "contents";
        currentFixedSlot = null;
        originalSlot = null;
        setMount(null);
        return;
      }

      const aside = playLink.closest("aside");
      if (!aside) return;
      const scrollRoot = [...aside.querySelectorAll("div")].find(element => {
        const classes = String(element.className || "");
        return classes.includes("flex-1") && classes.includes("overflow-y-auto") && classes.includes("custom-scrollbar");
      });
      if (!scrollRoot) return;

      let packageName = "";
      try { packageName = new URL(playLink.href).searchParams.get("id") || ""; } catch {}
      if (!packageName) return;

      // AtlasIntelligenceUI owns the Video Library and originally included the
      // first keyword mount. Hide that mount and replace it with this stabilized
      // drawer integration so loading state changes cannot cancel their own API
      // request. The slot itself is imperative DOM, so hiding it is safe.
      originalSlot = scrollRoot.querySelector('[data-atlas-keyword-slot="1"]');
      if (originalSlot) originalSlot.style.display = "none";

      let slot = scrollRoot.querySelector('[data-atlas-keyword-fixed-slot="1"]');
      if (!slot) {
        slot = document.createElement("div");
        slot.dataset.atlasKeywordFixedSlot = "1";
        slot.style.display = "contents";
        scrollRoot.insertBefore(slot, scrollRoot.firstChild);
      }
      currentFixedSlot = slot;

      setMount(previous => {
        if (previous?.slot === slot && previous?.packageName === packageName) return previous;
        return {
          slot,
          scrollRoot,
          packageName,
          title: aside.querySelector("h1")?.textContent?.trim() || packageName
        };
      });
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(scan);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();

    return () => {
      observer.disconnect();
      if (currentFixedSlot) currentFixedSlot.remove();
      if (originalSlot) originalSlot.style.display = "contents";
    };
  }, []);

  return mount;
}

function KeywordPanel({ mount }) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [view, setView] = useState("phrases");
  const [search, setSearch] = useState("");
  const cacheRef = useRef(new Map());
  const requestedPackageRef = useRef(null);

  useEffect(() => {
    setActive(false);
    setLoading(false);
    setError("");
    setData(cacheRef.current.get(mount.packageName) || null);
    setView("phrases");
    setSearch("");
    requestedPackageRef.current = null;
  }, [mount.packageName]);

  useEffect(() => {
    const { scrollRoot, slot } = mount;
    if (!scrollRoot || !slot) return undefined;

    const sync = () => {
      for (const child of [...scrollRoot.children]) {
        if (child === slot) continue;
        if (active) {
          if (child.dataset.atlasKeywordOriginalDisplay === undefined) {
            child.dataset.atlasKeywordOriginalDisplay = child.style.display || "";
          }
          child.style.display = "none";
        } else if (child.dataset.atlasKeywordOriginalDisplay !== undefined) {
          child.style.display = child.dataset.atlasKeywordOriginalDisplay;
          delete child.dataset.atlasKeywordOriginalDisplay;
        }
      }
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(scrollRoot, { childList: true });

    return () => {
      observer.disconnect();
      for (const child of [...scrollRoot.children]) {
        if (child === slot) continue;
        if (child.dataset.atlasKeywordOriginalDisplay !== undefined) {
          child.style.display = child.dataset.atlasKeywordOriginalDisplay;
          delete child.dataset.atlasKeywordOriginalDisplay;
        }
      }
    };
  }, [active, mount]);

  useEffect(() => {
    if (!active || data || requestedPackageRef.current === mount.packageName) return undefined;
    let cancelled = false;
    requestedPackageRef.current = mount.packageName;
    setLoading(true);
    setError("");

    fetchJson(`${API_BASE}/api/keywords?packageName=${encodeURIComponent(mount.packageName)}`)
      .then(result => {
        if (cancelled) return;
        cacheRef.current.set(mount.packageName, result);
        setData(result);
      })
      .catch(fetchError => {
        if (cancelled) return;
        requestedPackageRef.current = null;
        setError(fetchError.message || "Unable to analyze keywords.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [active, data, mount.packageName]);

  const rows = useMemo(() => {
    const source = view === "words" ? data?.words : view === "all" ? data?.all : data?.phrases;
    const query = search.trim().toLowerCase();
    return (source || []).filter(row => !query || row.term.toLowerCase().includes(query));
  }, [data, search, view]);

  return (
    <div className={cn(active && "min-h-full")}>
      <div className={cn(
        "bg-surface-solid border border-border-subtle rounded-2xl p-1 flex items-center gap-1 shadow-sm",
        active ? "sticky top-0 z-30 mb-4" : "mb-0"
      )}>
        <button type="button" onClick={() => setActive(false)} className={cn(
          "h-9 flex-1 rounded-xl text-[10px] md:text-xs font-medium flex items-center justify-center gap-1.5 transition-colors",
          !active ? "bg-primary-container text-on-primary-container" : "text-text-muted hover:text-text-main hover:bg-input-bg"
        )}>
          <span className="material-symbols-outlined text-[16px]">dashboard</span>
          Overview
        </button>
        <button type="button" onClick={() => setActive(true)} className={cn(
          "h-9 flex-1 rounded-xl text-[10px] md:text-xs font-medium flex items-center justify-center gap-1.5 transition-colors",
          active ? "bg-primary-container text-on-primary-container" : "text-text-muted hover:text-text-main hover:bg-input-bg"
        )}>
          <span className="material-symbols-outlined text-[16px]">manage_search</span>
          Keywords
        </button>
      </div>

      {active && (
        <div className="space-y-4 pb-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-electric-blue text-[19px]">manage_search</span>
              <h2 className="text-base font-semibold text-text-main">Keyword intelligence</h2>
            </div>
            <p className="text-[10px] md:text-xs text-text-muted mt-1">Frequency and distinctiveness compared with the rest of the Atlas game corpus.</p>
          </div>

          {loading ? (
            <div className="min-h-[300px] rounded-2xl border border-border-subtle bg-surface-glass flex flex-col items-center justify-center text-text-muted">
              <span className="material-symbols-outlined text-electric-blue text-[28px] animate-spin">progress_activity</span>
              <p className="text-xs mt-3">Analyzing short and long descriptions…</p>
            </div>
          ) : error ? (
            <div className="min-h-[240px] rounded-2xl border border-urgent-red/25 bg-urgent-red/5 flex flex-col items-center justify-center text-center px-5">
              <span className="material-symbols-outlined text-urgent-red text-[28px]">error</span>
              <p className="text-xs text-text-main mt-3">Keyword analysis unavailable</p>
              <p className="text-[10px] text-text-muted mt-1">{error}</p>
              <button type="button" onClick={() => { requestedPackageRef.current = null; setError(""); }} className="mt-3 h-8 px-3 rounded-full bg-input-bg border border-border-subtle text-[9px] text-text-main">Try again</button>
            </div>
          ) : data ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-input-bg border border-border-subtle p-3">
                  <div className="text-[8px] text-text-muted">Short description</div>
                  <div className="text-lg font-semibold text-text-main mt-1">{data.shortWordCount || 0}</div>
                  <div className="text-[8px] text-text-muted">words</div>
                </div>
                <div className="rounded-xl bg-input-bg border border-border-subtle p-3">
                  <div className="text-[8px] text-text-muted">Long description</div>
                  <div className="text-lg font-semibold text-text-main mt-1">{data.longWordCount || 0}</div>
                  <div className="text-[8px] text-text-muted">words</div>
                </div>
                <div className="rounded-xl bg-input-bg border border-border-subtle p-3">
                  <div className="text-[8px] text-text-muted">Compared with</div>
                  <div className="text-lg font-semibold text-electric-blue mt-1">{data.corpusGames || 0}</div>
                  <div className="text-[8px] text-text-muted">Atlas games</div>
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface-glass p-3 text-[9px] md:text-[10px] text-text-muted leading-relaxed">
                <span className="font-semibold text-text-main">Distinctiveness</span> combines frequency with how uncommon the same term is across the Atlas game corpus. Repeated competitor-specific phrases therefore outrank generic store language.
              </div>

              <div className="flex items-center gap-1 bg-input-bg rounded-xl p-1">
                {[["phrases","Phrases"],["words","Single words"],["all","All"]].map(([id,label]) => (
                  <button key={id} type="button" onClick={() => setView(id)} className={cn(
                    "h-9 flex-1 rounded-lg text-[9px] md:text-[10px] font-medium",
                    view === id ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted"
                  )}>{label}</button>
                ))}
              </div>

              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">search</span>
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter keywords…" className="w-full h-10 rounded-xl bg-input-bg border border-border-subtle text-text-main pl-9 pr-3 outline-none text-[10px]" />
              </div>

              {rows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-subtle py-12 text-center text-xs text-text-muted">No keywords match this view.</div>
              ) : (
                <div className="space-y-2">
                  {rows.map((row, index) => (
                    <div key={row.term} className="rounded-xl border border-border-subtle bg-surface-glass p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-text-muted font-mono w-5">#{index + 1}</span>
                            <h3 className="text-xs font-semibold text-text-main">{row.term}</h3>
                          </div>
                          <div className="ml-7 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-text-muted">
                            <span>Short: <b className="text-text-main">{row.shortCount}</b></span>
                            <span>Long: <b className="text-text-main">{row.longCount}</b></span>
                            <span>Total: <b className="text-text-main">{row.totalCount}</b></span>
                            <span>Other games: <b className="text-text-main">{row.corpusGamesUsing}</b></span>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-[9px] font-medium text-electric-blue">{labelForDistinctiveness(row.distinctiveness)}</div>
                          <div className="text-[8px] text-text-muted mt-0.5">{Number(row.distinctiveness || 0).toFixed(1)} / 100</div>
                        </div>
                      </div>
                      <div className="ml-7 mt-2 h-1.5 rounded-full bg-input-bg overflow-hidden">
                        <div className="h-full rounded-full bg-electric-blue" style={{ width: `${Math.max(2, Number(row.distinctiveness) || 0)}%` }} />
                      </div>
                      <div className="ml-7 mt-1 text-[8px] text-text-muted">Used by {row.corpusPrevalence}% of the Atlas corpus</div>
                    </div>
                  ))}
                </div>
              )}

              {(data.shortDescription || data.longDescription) && (
                <details className="rounded-xl border border-border-subtle bg-surface-glass overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 text-[10px] font-medium text-text-main flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-electric-blue">description</span>
                    Source descriptions
                  </summary>
                  <div className="px-4 pb-4 space-y-3">
                    {data.shortDescription && <div><div className="text-[9px] font-medium text-text-muted mb-1">Short description</div><p className="text-[10px] text-text-main leading-relaxed">{data.shortDescription}</p></div>}
                    {data.longDescription && <div><div className="text-[9px] font-medium text-text-muted mb-1">Long description</div><p className="text-[10px] text-text-main leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto custom-scrollbar">{data.longDescription}</p></div>}
                  </div>
                </details>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function AtlasKeywordUI() {
  const mount = useDrawerMount();
  return mount ? createPortal(<KeywordPanel key={mount.packageName} mount={mount} />, mount.slot) : null;
}
