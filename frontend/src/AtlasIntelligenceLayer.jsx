import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";

const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3000"
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);
const AUTH_TOKEN_KEY = "atlas_auth_token";

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
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
  const [deletingId, setDeletingId] = useState(null);

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

  const deleteAsset = useCallback(async asset => {
    const assetId = Number(asset?.id);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return;

    const label = asset?.games?.[0]?.title || asset?.youtubeId || "this video asset";
    const confirmed = window.confirm(
      `Delete "${label}" from the Video Library?\n\n` +
      "This removes the stored video asset and its Atlas links. A future deep scan may discover it again."
    );
    if (!confirmed) return;

    setDeletingId(assetId);
    try {
      await fetchJson(`${API_BASE}/api/video-assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
      setItems(current => current.filter(item => Number(item.id) !== assetId));
    } catch (err) {
      window.alert(err.message || "Unable to delete video asset.");
    } finally {
      setDeletingId(null);
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
      className="atlas-google-shell fixed top-16 bottom-[72px] md:bottom-0 left-0 md:left-[88px] right-0 z-[45] bg-bg-base text-text-main overflow-y-auto custom-scrollbar font-body-md antialiased [text-rendering:optimizeLegibility]"
    >
      <div className="w-full max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-7 md:py-9">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-urgent-red/10 text-urgent-red flex items-center justify-center border border-urgent-red/10">
              <span className="material-symbols-outlined text-[23px]">video_library</span>
            </div>
            <div>
              <h1 className="font-headline-lg text-[26px] md:text-[31px] font-semibold tracking-[-0.025em] leading-tight">Video Library</h1>
              <p className="text-[12px] md:text-[13px] leading-5 text-text-muted mt-1">Unique video creatives discovered while Atlas scans Google Ads.</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-muted"><b className="text-text-main font-semibold tabular-nums">{items.length}</b> unique videos</span>
            <button onClick={load} className="w-9 h-9 rounded-full bg-surface-solid border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-main hover:bg-input-bg transition-colors" title="Refresh library" aria-label="Refresh video library">
              <span className="material-symbols-outlined text-[18px]">refresh</span>
            </button>
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-surface-solid border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-main hover:bg-input-bg transition-colors md:hidden" title="Close" aria-label="Close Video Library">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>

        <div className="mt-7 bg-surface-solid border border-border-subtle rounded-[24px] p-2.5 md:p-3 flex flex-col lg:flex-row lg:items-center gap-2.5 shadow-sm">
          <div className="flex-1 h-11 bg-input-bg rounded-[14px] flex items-center gap-2.5 px-3.5 border border-transparent focus-within:border-electric-blue/25 focus-within:bg-surface-solid transition-colors">
            <span className="material-symbols-outlined text-text-muted text-[18px]">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search game, package, publisher, competitor, YouTube ID…" className="flex-1 min-w-0 bg-transparent outline-none text-[12px] md:text-[13px] text-text-main placeholder:text-text-muted/80" />
          </div>

          <div className="flex items-center gap-1 rounded-[14px] bg-input-bg p-1 overflow-x-auto custom-scrollbar">
            {[['all','All'],['youtube','YouTube'],['direct','Direct video']].map(([id,label]) => (
              <button
                key={id}
                onClick={() => setSource(id)}
                className={`h-9 px-3.5 rounded-[11px] text-[11px] font-medium whitespace-nowrap transition-all ${source === id ? 'bg-surface-solid text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <select value={sort} onChange={e => setSort(e.target.value)} className="h-11 px-3.5 rounded-[14px] bg-input-bg border border-transparent hover:border-border-subtle text-[11px] text-text-main outline-none transition-colors">
            <option value="recent">Most recently seen</option>
            <option value="reused">Most reused</option>
            <option value="duration">Longest duration</option>
            <option value="oldest">First discovered</option>
          </select>
        </div>

        {loading ? (
          <div className="min-h-[360px] flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[30px] text-electric-blue">progress_activity</span>
            <p className="text-[12px] mt-3">Loading video creatives…</p>
          </div>
        ) : error ? (
          <div className="min-h-[360px] flex flex-col items-center justify-center text-center">
            <span className="material-symbols-outlined text-urgent-red text-[34px]">error</span>
            <p className="text-sm text-text-main font-medium mt-3">Video library unavailable</p>
            <p className="text-[11px] text-text-muted mt-1">{error}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-6 min-h-[340px] rounded-[24px] border border-dashed border-border-subtle bg-surface-solid flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-2xl bg-input-bg flex items-center justify-center text-text-muted">
              <span className="material-symbols-outlined text-[27px]">video_library</span>
            </div>
            <h2 className="text-sm font-semibold mt-4">{items.length ? 'No videos match these filters' : 'No video creatives captured yet'}</h2>
            <p className="text-[11px] leading-5 text-text-muted mt-1.5 max-w-lg">Video detection happens automatically during normal Google Ads scans. Existing historical ads are backfilled the next time those creatives are scanned.</p>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 xl:grid-cols-2 gap-4">
            {visible.map(asset => {
              const game = (asset.games || [])[0] || {};
              const watchUrl = asset.youtubeUrl || (!asset.mediaUrlExpired ? asset.mediaUrl : null);
              const playStoreUrl = game.packageName
                ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(game.packageName)}`
                : null;
              const duration = formatDuration(asset.durationSeconds);
              const sourceLabel = asset.source === 'youtube' ? 'YouTube' : 'Direct video';
              const isDeleting = deletingId === Number(asset.id);

              return (
                <article key={asset.assetKey || asset.id} className="group bg-surface-solid border border-border-subtle rounded-[24px] overflow-hidden shadow-sm hover:shadow-md hover:border-text-muted/20 transition-all duration-200">
                  <div className="grid sm:grid-cols-[220px_1fr] min-h-[205px]">
                    <div className="relative bg-black min-h-[210px] sm:min-h-full overflow-hidden flex items-center justify-center">
                      {(asset.thumbnailUrl || game.headerImage || game.icon) ? (
                        <img src={asset.thumbnailUrl || game.headerImage || game.icon} alt="Video creative" className="w-full h-full absolute inset-0 object-cover opacity-95 transition-transform duration-300 group-hover:scale-[1.015]" />
                      ) : null}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-black/5"></div>
                      {watchUrl ? (
                        <a href={watchUrl} target="_blank" rel="noreferrer" className="relative w-12 h-12 rounded-full bg-black/65 hover:bg-black/75 text-white flex items-center justify-center backdrop-blur-md border border-white/15 transition-transform hover:scale-105" title="Watch video" aria-label="Watch video">
                          <span className="material-symbols-outlined text-[27px] ml-0.5">play_arrow</span>
                        </a>
                      ) : (
                        <span className="relative w-12 h-12 rounded-full bg-black/45 text-white/60 flex items-center justify-center backdrop-blur-md border border-white/10">
                          <span className="material-symbols-outlined text-[26px]">movie_off</span>
                        </span>
                      )}
                      {duration && <span className="absolute bottom-2.5 right-2.5 px-2 py-1 rounded-lg bg-black/72 text-white text-[9px] font-mono backdrop-blur-sm">{duration}</span>}
                    </div>

                    <div className="p-4 md:p-5 min-w-0 flex flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <h2 className="font-headline-lg text-[15px] md:text-[16px] font-semibold tracking-[-0.012em] leading-5 truncate">{game.title || 'Video creative'}</h2>
                            <span className={`px-2 py-0.5 rounded-full border text-[8px] font-medium ${asset.source === 'youtube' ? 'text-urgent-red bg-urgent-red/10 border-urgent-red/20' : 'text-electric-blue bg-electric-blue/10 border-electric-blue/20'}`}>
                              {sourceLabel}
                            </span>
                          </div>
                          <p className="text-[10px] md:text-[11px] leading-4 text-text-muted mt-1.5 truncate">
                            {game.publisherName || 'Publisher unavailable'}{game.competitorName ? ` · ${game.competitorName}` : ''}
                          </p>
                          <p className="text-[9px] leading-4 text-text-muted/90 font-mono mt-0.5 truncate">{game.packageName || asset.youtubeId || asset.assetKey}</p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="px-2.5 py-1 rounded-full bg-input-bg text-[9px] font-medium text-text-muted tabular-nums">{asset.adCount || 0} ads</span>
                          <button
                            type="button"
                            onClick={() => { void deleteAsset(asset); }}
                            disabled={isDeleting}
                            className="w-8 h-8 rounded-full bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted hover:text-urgent-red hover:border-urgent-red/25 disabled:opacity-50 disabled:cursor-wait transition-colors"
                            title="Delete video asset"
                            aria-label={`Delete ${game.title || 'video asset'}`}
                          >
                            <span className={`material-symbols-outlined text-[16px] ${isDeleting ? 'animate-spin' : ''}`}>
                              {isDeleting ? 'progress_activity' : 'delete'}
                            </span>
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-5 gap-y-3 mt-4 pt-4 border-t border-border-subtle text-[9px]">
                        <div>
                          <div className="text-text-muted">First seen</div>
                          <div className="text-text-main font-medium mt-0.5 tabular-nums">{formatDate(asset.firstSeenAt)}</div>
                        </div>
                        <div>
                          <div className="text-text-muted">Last seen</div>
                          <div className="text-text-main font-medium mt-0.5 tabular-nums">{formatDate(asset.lastSeenAt)}</div>
                        </div>
                        {(asset.width || asset.height) && (
                          <div>
                            <div className="text-text-muted">Resolution</div>
                            <div className="text-text-main font-medium mt-0.5">{asset.width || '?'} × {asset.height || '?'}</div>
                          </div>
                        )}
                        {asset.youtubeId && (
                          <div className="min-w-0">
                            <div className="text-text-muted">YouTube ID</div>
                            <div className="text-text-main font-mono mt-0.5 truncate">{asset.youtubeId}</div>
                          </div>
                        )}
                      </div>

                      <div className="mt-auto pt-4 flex flex-wrap items-center gap-2">
                        {watchUrl && (
                          <a href={watchUrl} target="_blank" rel="noreferrer" className="h-9 px-3.5 rounded-full bg-[#1a73e8] hover:bg-[#1765cc] text-white text-[10px] font-medium flex items-center gap-1.5 transition-colors shadow-sm">
                            <span className="material-symbols-outlined text-[16px]">play_circle</span>
                            Watch
                          </a>
                        )}
                        {playStoreUrl && (
                          <a href={playStoreUrl} target="_blank" rel="noreferrer" className="h-9 px-3.5 rounded-full bg-surface-solid hover:bg-input-bg border border-border-subtle text-text-main text-[10px] font-medium flex items-center gap-1.5 transition-colors">
                            <span className="material-symbols-outlined text-[16px]">shop</span>
                            Play Store
                          </a>
                        )}
                        {asset.source === 'direct' && asset.mediaUrlExpired && <span className="text-[9px] text-amber-500">Media link expired · rescan to refresh</span>}
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
    setLoading(true);
    setError("");
    setData(null);
    setTab("phrases");

    fetchJson(`${API_BASE}/api/game-keywords?packageName=${encodeURIComponent(packageName)}`)
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => { if (!cancelled) setError(err.message || "Unable to load keywords."); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [packageName]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const rows = tab === "phrases" ? (data?.phrases || []) : (data?.words || []);

  return createPortal(
    <div className="atlas-google-shell fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-5 font-body-md antialiased [text-rendering:optimizeLegibility]">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <motion.section
        initial={{ opacity: 0, scale: 0.98, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 10 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-5xl h-[88vh] max-h-[900px] bg-surface-solid border border-border-subtle rounded-[26px] shadow-2xl overflow-hidden flex flex-col"
      >
        <header className="px-5 md:px-6 py-4 border-b border-border-subtle flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-electric-blue text-[21px]">key</span>
              <h2 className="text-base md:text-lg font-medium text-text-main">Keyword intelligence</h2>
            </div>
            <p className="text-[10px] md:text-xs text-text-muted mt-1 truncate">{title || data?.title || packageName}</p>
            <p className="text-[9px] text-text-muted font-mono mt-0.5 truncate">{packageName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors flex-shrink-0"
            aria-label="Close keyword intelligence"
          >
            <span className="material-symbols-outlined text-[21px]">close</span>
          </button>
        </header>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined text-electric-blue text-[32px] animate-spin">progress_activity</span>
            <p className="text-xs mt-3">Analyzing competitor descriptions…</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <span className="material-symbols-outlined text-urgent-red text-[36px]">error</span>
            <p className="text-sm font-medium mt-3">Keyword analysis unavailable</p>
            <p className="text-xs text-text-muted mt-1">{error}</p>
          </div>
        ) : (
          <>
            <div className="px-5 md:px-6 py-4 border-b border-border-subtle flex flex-col lg:flex-row lg:items-center gap-3 lg:justify-between flex-shrink-0 bg-surface-solid">
              <div className="grid grid-cols-3 gap-2 md:gap-3 flex-1 w-full">
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Short description</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.shortWordCount || 0}</div>
                  <div className="text-[9px] text-text-muted">words</div>
                </div>
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Long description</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.longWordCount || 0}</div>
                  <div className="text-[9px] text-text-muted">words</div>
                </div>
                <div className="bg-input-bg rounded-xl px-3 py-2.5">
                  <div className="text-[9px] text-text-muted">Atlas corpus</div>
                  <div className="text-base md:text-lg font-semibold mt-0.5 tabular-nums">{data?.stats?.corpusGames || 0}</div>
                  <div className="text-[9px] text-text-muted">games</div>
                </div>
              </div>

              <div className="bg-input-bg rounded-full p-1 inline-flex gap-1 self-start lg:self-center flex-shrink-0">
                {[["phrases", "Top phrases"], ["words", "Single words"]].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`h-9 px-4 rounded-full text-[10px] font-medium transition-colors ${tab === id ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-5 md:px-6 py-5">
              <div className="rounded-2xl border border-border-subtle bg-input-bg/60 px-4 py-3 text-[10px] md:text-[11px] text-text-muted leading-5 mb-4">
                <b className="text-text-main">Distinctiveness</b> compares this game's wording against descriptions currently stored in Atlas. Rare wording scores higher than generic phrases shared by many games.
              </div>

              {rows.length ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {rows.map((row, index) => (
                    <article key={`${row.type}-${row.term}`} className="rounded-2xl border border-border-subtle bg-surface-glass p-4 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] text-text-muted font-mono flex-shrink-0">#{index + 1}</span>
                            <h3 className="text-sm font-medium truncate">{row.term}</h3>
                          </div>
                          <div className="text-[9px] text-text-muted mt-1">Used by {row.documentShare}% of Atlas games</div>
                        </div>
                        <DistinctivenessBadge value={row.distinctiveness} />
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-3">
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Total uses</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.count}</div>
                        </div>
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Short desc.</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.shortCount}</div>
                        </div>
                        <div className="bg-input-bg rounded-xl p-2.5">
                          <div className="text-[8px] text-text-muted">Long desc.</div>
                          <div className="text-sm font-semibold mt-0.5 tabular-nums">{row.longCount}</div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-xs text-text-muted">Not enough description text to rank keywords.</div>
              )}

              {(data?.shortDescription || data?.longDescription) && (
                <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {data.shortDescription && (
                    <details className="rounded-2xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-xs font-medium cursor-pointer">Short description source</summary>
                      <p className="text-[11px] text-text-muted leading-5 mt-3">{data.shortDescription}</p>
                    </details>
                  )}
                  {data.longDescription && (
                    <details className="rounded-2xl border border-border-subtle bg-surface-glass p-4">
                      <summary className="text-xs font-medium cursor-pointer">Long description source</summary>
                      <p className="text-[11px] text-text-muted leading-5 mt-3 whitespace-pre-wrap">{data.longDescription}</p>
                    </details>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </motion.section>
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
