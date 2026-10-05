import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";

const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3000"
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);
const AUTH_TOKEN_KEY = "atlas_auth_token";

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
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error("Invalid server response."); }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  return data;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const mins = Math.floor(value / 60);
  const secs = Math.round(value % 60).toString().padStart(2, "0");
  return mins ? `${mins}:${secs}` : `0:${secs}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function DistinctivenessBadge({ value }) {
  const meta = {
    very_high: ["Very high", "text-violet-400 bg-violet-500/10 border-violet-500/20"],
    high: ["High", "text-electric-blue bg-electric-blue/10 border-electric-blue/20"],
    medium: ["Medium", "text-amber-500 bg-amber-500/10 border-amber-500/20"],
    low: ["Low", "text-text-muted bg-input-bg border-border-subtle"]
  }[value] || ["Low", "text-text-muted bg-input-bg border-border-subtle"];

  return <span className={`px-2 py-0.5 rounded-full border text-[9px] font-medium ${meta[1]}`}>{meta[0]}</span>;
}

function VideoLibrary({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("recent");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchJson(`${API_BASE}/api/video-assets`);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || "Unable to load video library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = items.filter(asset => {
      if (source !== "all" && asset.source !== source) return false;
      if (!q) return true;
      if (String(asset.youtubeId || "").toLowerCase().includes(q)) return true;
      return (asset.games || []).some(game =>
        String(game.title || "").toLowerCase().includes(q) ||
        String(game.packageName || "").toLowerCase().includes(q) ||
        String(game.publisherName || "").toLowerCase().includes(q) ||
        String(game.competitorName || "").toLowerCase().includes(q)
      );
    });

    result.sort((a, b) => {
      if (sort === "reused") return Number(b.adCount || 0) - Number(a.adCount || 0);
      if (sort === "duration") return Number(b.durationSeconds || 0) - Number(a.durationSeconds || 0);
      if (sort === "oldest") return new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0);
      return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
    });
    return result;
  }, [items, search, source, sort]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed top-16 bottom-[72px] md:bottom-0 left-0 md:left-[88px] right-0 z-[45] bg-bg-base text-text-main overflow-y-auto custom-scrollbar"
    >
      <div className="w-full max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-red-500/10 text-red-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[24px]">video_library</span>
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-medium tracking-tight">Video Library</h1>
              <p className="text-sm text-text-muted mt-1">Unique video creatives discovered while Atlas scans Google Ads.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted"><b className="text-text-main">{items.length}</b> unique videos</span>
            <button onClick={load} className="w-9 h-9 rounded-full bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-main" title="Refresh library">
              <span className="material-symbols-outlined text-[18px]">refresh</span>
            </button>
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-main md:hidden" title="Close">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>

        <div className="mt-7 bg-surface-solid border border-border-subtle rounded-[22px] p-3 md:p-4 flex flex-col lg:flex-row gap-3">
          <div className="flex-1 h-11 bg-input-bg rounded-xl border border-border-subtle flex items-center gap-2 px-3">
            <span className="material-symbols-outlined text-text-muted text-[18px]">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search game, package, publisher, competitor, YouTube ID..." className="flex-1 min-w-0 bg-transparent outline-none text-sm text-text-main placeholder:text-text-muted" />
          </div>
          <div className="flex gap-1 overflow-x-auto custom-scrollbar">
            {[['all','All'],['youtube','YouTube'],['direct','Direct video']].map(([id,label]) => (
              <button key={id} onClick={() => setSource(id)} className={`h-11 px-4 rounded-xl border text-xs font-medium whitespace-nowrap ${source === id ? 'bg-primary-container text-on-primary-container border-transparent' : 'bg-surface-solid border-border-subtle text-text-muted hover:text-text-main'}`}>{label}</button>
            ))}
          </div>
          <select value={sort} onChange={e => setSort(e.target.value)} className="h-11 px-3 rounded-xl bg-surface-solid border border-border-subtle text-xs text-text-main outline-none">
            <option value="recent">Most recently seen</option>
            <option value="reused">Most reused</option>
            <option value="duration">Longest duration</option>
            <option value="oldest">First discovered</option>
          </select>
        </div>

        {loading ? (
          <div className="min-h-[360px] flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[32px] text-electric-blue">progress_activity</span>
            <p className="text-sm mt-3">Loading video creatives…</p>
          </div>
        ) : error ? (
          <div className="min-h-[360px] flex flex-col items-center justify-center text-center">
            <span className="material-symbols-outlined text-urgent-red text-[34px]">error</span>
            <p className="text-sm text-text-main mt-3">Video library unavailable</p>
            <p className="text-xs text-text-muted mt-1">{error}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-6 min-h-[340px] rounded-[24px] border border-dashed border-border-subtle bg-surface-solid flex flex-col items-center justify-center text-center px-6">
            <span className="material-symbols-outlined text-[38px] text-text-muted">video_library</span>
            <h2 className="text-base font-medium mt-3">{items.length ? 'No videos match these filters' : 'No video creatives captured yet'}</h2>
            <p className="text-xs text-text-muted mt-2 max-w-lg">Video detection happens automatically during normal Google Ads scans. Existing historical ads are not backfilled until they are scanned again.</p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {visible.map(asset => {
              const game = (asset.games || [])[0] || {};
              const watchUrl = asset.youtubeUrl || (!asset.mediaUrlExpired ? asset.mediaUrl : null);
              const duration = formatDuration(asset.durationSeconds);
              return (
                <article key={asset.assetKey || asset.id} className="bg-surface-solid border border-border-subtle rounded-[22px] overflow-hidden shadow-sm">
                  <div className="grid sm:grid-cols-[210px_1fr] min-h-[190px]">
                    <div className="relative bg-black/90 min-h-[180px] overflow-hidden flex items-center justify-center">
                      {(asset.thumbnailUrl || game.headerImage || game.icon) ? (
                        <img src={asset.thumbnailUrl || game.headerImage || game.icon} alt="Video creative" className="w-full h-full absolute inset-0 object-cover opacity-90" />
                      ) : null}
                      <div className="absolute inset-0 bg-black/15"></div>
                      <span className="relative w-12 h-12 rounded-full bg-black/65 text-white flex items-center justify-center backdrop-blur-sm">
                        <span className="material-symbols-outlined text-[28px]">play_arrow</span>
                      </span>
                      {duration && <span className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-black/75 text-white text-[10px] font-mono">{duration}</span>}
                    </div>

                    <div className="p-4 md:p-5 min-w-0 flex flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-sm md:text-base font-semibold truncate">{game.title || 'Video creative'}</h2>
                            <span className={`px-2 py-0.5 rounded-full border text-[9px] font-medium ${asset.source === 'youtube' ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-electric-blue bg-electric-blue/10 border-electric-blue/20'}`}>
                              {asset.source === 'youtube' ? 'YouTube' : 'Direct video'}
                            </span>
                          </div>
                          <p className="text-[10px] md:text-xs text-text-muted mt-1 truncate">{game.publisherName || 'Publisher unavailable'}{game.competitorName ? ` · ${game.competitorName}` : ''}</p>
                          <p className="text-[9px] text-text-muted font-mono mt-1 truncate">{game.packageName || asset.youtubeId || asset.assetKey}</p>
                        </div>
                        <span className="px-2.5 py-1 rounded-full bg-input-bg border border-border-subtle text-[9px] text-text-muted flex-shrink-0">{asset.adCount || 0} ads</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mt-4 text-[9px]">
                        <div className="bg-input-bg rounded-lg px-2.5 py-2"><span className="text-text-muted">First seen</span><div className="text-text-main font-medium mt-0.5">{formatDate(asset.firstSeenAt)}</div></div>
                        <div className="bg-input-bg rounded-lg px-2.5 py-2"><span className="text-text-muted">Last seen</span><div className="text-text-main font-medium mt-0.5">{formatDate(asset.lastSeenAt)}</div></div>
                        {(asset.width || asset.height) && <div className="bg-input-bg rounded-lg px-2.5 py-2"><span className="text-text-muted">Resolution</span><div className="text-text-main font-medium mt-0.5">{asset.width || '?'}×{asset.height || '?'}</div></div>}
                        {asset.youtubeId && <div className="bg-input-bg rounded-lg px-2.5 py-2"><span className="text-text-muted">YouTube ID</span><div className="text-text-main font-mono mt-0.5 truncate">{asset.youtubeId}</div></div>}
                      </div>

                      <div className="mt-auto pt-4 flex flex-wrap items-center gap-2">
                        {watchUrl && <a href={watchUrl} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-full bg-electric-blue text-white text-[10px] font-medium flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">play_circle</span>Watch</a>}
                        {asset.youtubeUrl && <a href={asset.youtubeUrl} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-full bg-input-bg border border-border-subtle text-text-main text-[10px] font-medium flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">open_in_new</span>YouTube</a>}
                        {asset.source === 'direct' && asset.mediaUrlExpired && <span className="text-[9px] text-amber-500">Stored media link expired · rescan to refresh</span>}
                        {(asset.games || []).length > 1 && <span className="text-[9px] text-text-muted ml-auto">+{asset.games.length - 1} linked games</span>}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function KeywordPanel({ packageName, title, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("phrases");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setData(null); setTab("phrases");
    fetchJson(`${API_BASE}/api/game-keywords?packageName=${encodeURIComponent(packageName)}`)
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => { if (!cancelled) setError(err.message || "Unable to load keywords."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [packageName]);

  const rows = tab === "phrases" ? (data?.phrases || []) : (data?.words || []);

  return createPortal(
    <div className="fixed inset-0 z-[130] flex justify-end">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/65" onClick={onClose} />
      <motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'tween', duration: 0.22 }} className="relative w-full sm:w-[500px] h-full bg-surface-solid border-l border-border-subtle shadow-2xl flex flex-col">
        <div className="p-5 border-b border-border-subtle flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue">key</span><h2 className="text-lg font-semibold">Keyword intelligence</h2></div>
            <p className="text-xs text-text-muted mt-1 truncate">{title || data?.title || packageName}</p>
            <p className="text-[9px] text-text-muted font-mono mt-0.5 truncate">{packageName}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-input-bg flex items-center justify-center text-text-muted"><span className="material-symbols-outlined text-[19px]">close</span></button>
        </div>

        {loading ? <div className="flex-1 flex flex-col items-center justify-center text-text-muted"><span className="material-symbols-outlined text-electric-blue text-[30px] animate-spin">progress_activity</span><p className="text-xs mt-3">Analyzing competitor descriptions…</p></div>
        : error ? <div className="flex-1 flex flex-col items-center justify-center text-center p-6"><span className="material-symbols-outlined text-urgent-red text-[34px]">error</span><p className="text-sm mt-3">Keyword analysis unavailable</p><p className="text-xs text-text-muted mt-1">{error}</p></div>
        : <>
          <div className="p-4 border-b border-border-subtle">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-input-bg rounded-xl p-3"><div className="text-[9px] text-text-muted">Short description</div><div className="text-lg font-semibold mt-1">{data?.stats?.shortWordCount || 0}</div><div className="text-[9px] text-text-muted">words</div></div>
              <div className="bg-input-bg rounded-xl p-3"><div className="text-[9px] text-text-muted">Long description</div><div className="text-lg font-semibold mt-1">{data?.stats?.longWordCount || 0}</div><div className="text-[9px] text-text-muted">words</div></div>
              <div className="bg-input-bg rounded-xl p-3"><div className="text-[9px] text-text-muted">Atlas corpus</div><div className="text-lg font-semibold mt-1">{data?.stats?.corpusGames || 0}</div><div className="text-[9px] text-text-muted">games</div></div>
            </div>
            <div className="mt-3 bg-input-bg rounded-xl p-1 inline-flex gap-1">
              {[['phrases','Top phrases'],['words','Single words']].map(([id,label]) => <button key={id} onClick={() => setTab(id)} className={`h-9 px-3 rounded-lg text-[10px] font-medium ${tab === id ? 'bg-surface-solid text-text-main shadow-sm' : 'text-text-muted'}`}>{label}</button>)}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
            <div className="rounded-xl border border-border-subtle bg-input-bg/60 p-3 text-[10px] text-text-muted mb-3"><b className="text-text-main">Distinctiveness</b> compares this game's wording against all descriptions currently stored in Atlas. A rare phrase scores higher than a generic phrase used by many games.</div>
            <div className="space-y-2">
              {rows.map((row, index) => (
                <div key={`${row.type}-${row.term}`} className="rounded-xl border border-border-subtle bg-surface-glass p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="flex items-center gap-2"><span className="text-[10px] text-text-muted font-mono">#{index + 1}</span><h3 className="text-sm font-medium truncate">{row.term}</h3></div><div className="text-[9px] text-text-muted mt-1">Used by {row.documentShare}% of Atlas games</div></div>
                    <DistinctivenessBadge value={row.distinctiveness} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <div className="bg-input-bg rounded-lg p-2"><div className="text-[8px] text-text-muted">Total uses</div><div className="text-sm font-semibold">{row.count}</div></div>
                    <div className="bg-input-bg rounded-lg p-2"><div className="text-[8px] text-text-muted">Short desc.</div><div className="text-sm font-semibold">{row.shortCount}</div></div>
                    <div className="bg-input-bg rounded-lg p-2"><div className="text-[8px] text-text-muted">Long desc.</div><div className="text-sm font-semibold">{row.longCount}</div></div>
                  </div>
                </div>
              ))}
              {!rows.length && <div className="py-12 text-center text-xs text-text-muted">Not enough description text to rank keywords.</div>}
            </div>

            {(data?.shortDescription || data?.longDescription) && <div className="mt-5 space-y-3">
              {data.shortDescription && <details className="rounded-xl border border-border-subtle p-3"><summary className="text-xs font-medium cursor-pointer">Short description source</summary><p className="text-[11px] text-text-muted leading-5 mt-3">{data.shortDescription}</p></details>}
              {data.longDescription && <details className="rounded-xl border border-border-subtle p-3"><summary className="text-xs font-medium cursor-pointer">Long description source</summary><p className="text-[11px] text-text-muted leading-5 mt-3 whitespace-pre-wrap">{data.longDescription}</p></details>}
            </div>}
          </div>
        </>}
      </motion.aside>
    </div>,
    document.body
  );
}

export default function AtlasIntelligenceLayer() {
  const [videoOpen, setVideoOpen] = useState(false);
  const [keywordTarget, setKeywordTarget] = useState(null);

  useEffect(() => {
    let disposed = false;

    const styleButton = (button, active, mobile = false) => {
      button.type = "button";
      button.dataset.atlasVideoLibrary = "1";
      button.innerHTML = mobile
        ? `<span style="width:56px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:${active ? 'var(--video-active,#334155)' : 'transparent'}"><span class="material-symbols-outlined" style="font-size:20px">video_library</span></span><span style="font-size:9px;font-weight:500">Videos</span>`
        : `<span style="width:56px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:${active ? '#334155' : 'transparent'}"><span class="material-symbols-outlined" style="font-size:21px">video_library</span></span><span style="font-size:9px;font-weight:500">Videos</span>`;
      button.style.cssText = mobile
        ? "display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px;color:inherit"
        : "width:100%;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 0;color:inherit";
      button.onclick = event => { event.stopPropagation(); setVideoOpen(true); };
    };

    const ensureNavButtons = () => {
      if (disposed) return;
      const desktop = document.querySelector('aside nav');
      if (desktop && !desktop.querySelector('[data-atlas-video-library="1"]')) {
        const country = [...desktop.querySelectorAll(':scope > button')].find(button => button.textContent.includes('Country Scans'));
        if (country) {
          const button = document.createElement('button');
          styleButton(button, videoOpen, false);
          country.insertAdjacentElement('afterend', button);
        }
      }

      const mobileBars = [...document.querySelectorAll('nav')].filter(nav => nav.className.includes('bottom-0'));
      for (const mobile of mobileBars) {
        if (mobile.querySelector('[data-atlas-video-library="1"]')) continue;
        const row = mobile.firstElementChild;
        const country = row ? [...row.children].find(child => child.textContent.includes('Country Scans')) : null;
        if (country) {
          const button = document.createElement('button');
          styleButton(button, videoOpen, true);
          country.insertAdjacentElement('afterend', button);
        }
      }

      for (const button of document.querySelectorAll('[data-atlas-video-library="1"]')) {
        styleButton(button, videoOpen, button.closest('nav')?.className.includes('bottom-0'));
      }
    };

    const ensureKeywordButtons = () => {
      const playLinks = [...document.querySelectorAll('a[href*="play.google.com/store/apps/details?id="]')];
      for (const playLink of playLinks) {
        const drawer = playLink.closest('aside');
        if (!drawer) continue;
        const actions = playLink.parentElement;
        if (!actions || actions.querySelector('[data-atlas-keywords="1"]')) continue;
        const packageName = new URL(playLink.href).searchParams.get('id');
        if (!packageName) continue;
        const title = drawer.querySelector('h1')?.textContent?.trim() || packageName;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.atlasKeywords = '1';
        button.className = 'flex items-center gap-1.5 bg-input-bg text-text-main text-xs px-3 py-2 rounded-lg border border-border-subtle transition-all w-max';
        button.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">key</span> Keywords';
        button.onclick = event => { event.stopPropagation(); setKeywordTarget({ packageName, title }); };
        actions.appendChild(button);
      }
    };

    const closeVideoWhenNativeNavClicked = event => {
      const button = event.target.closest('aside nav button, nav.fixed.bottom-0 button');
      if (button && !button.dataset.atlasVideoLibrary) setVideoOpen(false);
    };
    document.addEventListener('click', closeVideoWhenNativeNavClicked, true);

    ensureNavButtons(); ensureKeywordButtons();
    const observer = new MutationObserver(() => { ensureNavButtons(); ensureKeywordButtons(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('click', closeVideoWhenNativeNavClicked, true);
      document.querySelectorAll('[data-atlas-video-library="1"]').forEach(node => node.remove());
      document.querySelectorAll('[data-atlas-keywords="1"]').forEach(node => node.remove());
    };
  }, [videoOpen]);

  return <>
    <AnimatePresence>{videoOpen && <VideoLibrary onClose={() => setVideoOpen(false)} />}</AnimatePresence>
    <AnimatePresence>{keywordTarget && <KeywordPanel packageName={keywordTarget.packageName} title={keywordTarget.title} onClose={() => setKeywordTarget(null)} />}</AnimatePresence>
  </>;
}
