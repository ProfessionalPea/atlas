import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./lib/utils";

const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";
const AUTH_TOKEN_KEY = "atlas_auth_token";
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3000"
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);

async function featureFetch(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers = {
    ...options.headers,
    "ngrok-skip-browser-warning": "69420",
    ...(token ? { "x-atlas-token": token } : {})
  };

  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      if (contentType.includes("application/json")) {
        const body = await response.json();
        message = body?.error || message;
      } else {
        const text = await response.text();
        if (text) message = text.slice(0, 240);
      }
    } catch {}
    throw new Error(message);
  }

  if (contentType.includes("application/json")) return response.json();
  return response;
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return "Unknown length";
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, "0");
  return mins ? `${mins}:${secs}` : `0:${secs}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function formatInstalls(value) {
  if (!value) return "—";
  return String(value);
}

function sourceMeta(type) {
  if (type === "youtube") {
    return {
      label: "YouTube",
      icon: "smart_display",
      className: "text-red-400 bg-red-500/10 border-red-500/20"
    };
  }
  return {
    label: "Direct video",
    icon: "movie",
    className: "text-violet-400 bg-violet-500/10 border-violet-500/20"
  };
}

function useAtlasNavSlots() {
  const [slots, setSlots] = useState([]);

  useEffect(() => {
    const created = new Set();
    let scheduled = false;

    const scan = () => {
      scheduled = false;
      const targets = [...document.querySelectorAll("button")].filter(button => {
        const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
        return text === "Targets" && (button.closest("aside") || button.closest("nav"));
      });

      const found = [];
      for (const target of targets) {
        const kind = target.closest("aside") ? "desktop" : "mobile";
        const parent = target.parentElement;
        if (!parent) continue;

        let slot = parent.querySelector(`[data-atlas-video-nav-slot="${kind}"]`);
        if (!slot) {
          slot = document.createElement("div");
          slot.dataset.atlasVideoNavSlot = kind;
          slot.style.display = "contents";
          parent.insertBefore(slot, target);
          created.add(slot);
        }
        found.push({ element: slot, kind });
      }

      setSlots(previous => {
        if (
          previous.length === found.length &&
          previous.every((item, index) => item.element === found[index]?.element)
        ) return previous;
        return found;
      });
    };

    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(scan);
    };

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();

    return () => {
      observer.disconnect();
      created.forEach(slot => slot.remove());
    };
  }, []);

  return slots;
}

function VideoNavButton({ kind, active, onClick }) {
  if (kind === "mobile") {
    return (
      <button data-atlas-video-nav type="button" onClick={onClick} className="flex flex-col items-center gap-1 min-w-[64px]">
        <span className={cn(
          "w-14 h-8 rounded-full flex items-center justify-center transition-colors",
          active ? "bg-primary-container text-on-primary-container" : "text-text-muted"
        )}>
          <span className="material-symbols-outlined text-[20px]">video_library</span>
        </span>
        <span className={cn("text-[9px] font-medium", active ? "text-text-main" : "text-text-muted")}>Videos</span>
      </button>
    );
  }

  return (
    <button data-atlas-video-nav type="button" onClick={onClick} className="w-full flex flex-col items-center gap-1 py-2.5 group">
      <span className={cn(
        "w-14 h-8 rounded-full flex items-center justify-center transition-colors",
        active
          ? "bg-primary-container text-on-primary-container"
          : "text-text-muted group-hover:bg-input-bg group-hover:text-text-main"
      )}>
        <span className="material-symbols-outlined text-[21px]">video_library</span>
      </span>
      <span className={cn("text-[9px] font-medium", active ? "text-text-main" : "text-text-muted")}>Video Library</span>
    </button>
  );
}

function VideoGameMetadata({ game }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-11 h-11 rounded-xl overflow-hidden bg-input-bg border border-border-subtle flex-shrink-0 flex items-center justify-center">
        {game.icon ? (
          <img src={game.icon} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="material-symbols-outlined text-text-muted text-[20px]">sports_esports</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-xs md:text-sm font-semibold text-text-main truncate">{game.title || game.packageName}</h3>
          {game.isPaid && (
            <span className="px-1.5 py-0.5 rounded-full border border-violet-500/20 bg-violet-500/10 text-violet-400 text-[8px] font-medium flex-shrink-0">Paid</span>
          )}
        </div>
        <p className="text-[9px] md:text-[10px] text-text-muted mt-0.5 truncate">
          {game.publishers?.[0] || "Unknown publisher"}
        </p>
        {(game.competitors || []).length > 0 && (
          <p className="text-[9px] text-electric-blue mt-0.5 truncate">
            {(game.competitors || []).map(item => item.name).join(" · ")}
          </p>
        )}
        <p className="font-mono text-[8px] md:text-[9px] text-text-muted/70 mt-0.5 truncate">{game.packageName}</p>
      </div>
      <div className="text-right flex-shrink-0 hidden sm:block">
        <div className="text-[9px] text-text-muted">{formatInstalls(game.installs)}</div>
        {Number(game.rating) > 0 && <div className="text-[9px] text-text-muted mt-0.5">{Number(game.rating).toFixed(1)} ★</div>}
      </div>
    </div>
  );
}

function VideoLibrary({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("reuse");
  const [downloadingId, setDownloadingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await featureFetch(`${API_BASE}/api/video-library`);
      setItems(Array.isArray(data) ? data : []);
    } catch (loadError) {
      setError(loadError.message || "Unable to load video library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = items.filter(item => {
      if (source !== "all" && item.type !== source) return false;
      if (!query) return true;
      const haystack = [
        item.youtubeId,
        item.sourceHost,
        ...(item.creativeIds || []),
        ...(item.games || []).flatMap(game => [
          game.title,
          game.packageName,
          ...(game.publishers || []),
          ...(game.competitors || []).map(comp => comp.name)
        ])
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });

    return filtered.sort((a, b) => {
      if (sort === "newest") return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
      if (sort === "oldest") return new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0);
      if (sort === "duration") return Number(b.durationSeconds || 0) - Number(a.durationSeconds || 0);
      return Number(b.adCount || 0) - Number(a.adCount || 0) || new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
    });
  }, [items, search, source, sort]);

  const downloadDirect = useCallback(async item => {
    setDownloadingId(item.id);
    try {
      const response = await featureFetch(`${API_BASE}/api/video-assets/${item.id}/download`);
      if (!(response instanceof Response)) throw new Error("Unexpected download response.");
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `atlas-video-${item.id}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (downloadError) {
      window.alert(downloadError.message || "Unable to download this video. The signed media URL may have expired.");
    } finally {
      setDownloadingId(null);
    }
  }, []);

  return (
    <section className="fixed z-[35] top-16 bottom-0 left-0 right-0 md:left-[88px] bg-bg-base overflow-y-auto custom-scrollbar pb-24 md:pb-10">
      <div className="w-full max-w-[1500px] mx-auto px-3 sm:px-5 lg:px-7 py-8 md:py-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-electric-blue/10 text-electric-blue flex items-center justify-center">
                <span className="material-symbols-outlined text-[23px]">video_library</span>
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">Video Library</h1>
                <p className="text-xs md:text-sm text-text-muted mt-1">Video creatives captured while Atlas scans Google Ads Transparency Center.</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted"><span className="text-text-main font-medium">{items.length}</span> unique videos</span>
            <button onClick={load} className="w-9 h-9 rounded-full border border-border-subtle bg-surface-solid text-text-muted hover:text-text-main flex items-center justify-center" title="Refresh video library">
              <span className="material-symbols-outlined text-[18px]">refresh</span>
            </button>
            <button onClick={onClose} className="md:hidden w-9 h-9 rounded-full border border-border-subtle bg-surface-solid text-text-muted flex items-center justify-center" title="Close">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>

        <div className="bg-surface-solid border border-border-subtle rounded-[22px] p-3 md:p-4 shadow-sm mb-5 flex flex-col lg:flex-row gap-3">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">search</span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search game, package, publisher, competitor, creative ID..."
              className="w-full h-11 rounded-xl bg-input-bg border border-border-subtle text-text-main pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/25 text-xs md:text-sm"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto custom-scrollbar">
            {[['all','All'],['youtube','YouTube'],['direct','Direct video']].map(([id,label]) => (
              <button
                key={id}
                onClick={() => setSource(id)}
                className={cn(
                  "h-11 px-4 rounded-xl border text-[10px] md:text-xs font-medium whitespace-nowrap",
                  source === id ? "bg-primary-container text-on-primary-container border-transparent" : "bg-input-bg text-text-muted border-border-subtle hover:text-text-main"
                )}
              >{label}</button>
            ))}
          </div>
          <select value={sort} onChange={event => setSort(event.target.value)} className="h-11 px-3 rounded-xl bg-input-bg border border-border-subtle text-text-main text-[10px] md:text-xs outline-none">
            <option value="reuse">Most reused</option>
            <option value="newest">Newest detected</option>
            <option value="oldest">Oldest detected</option>
            <option value="duration">Longest video</option>
          </select>
        </div>

        {loading ? (
          <div className="min-h-[360px] flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined text-electric-blue text-[30px] animate-spin">progress_activity</span>
            <p className="text-xs mt-3">Loading captured video creatives…</p>
          </div>
        ) : error ? (
          <div className="min-h-[300px] flex flex-col items-center justify-center text-center">
            <span className="material-symbols-outlined text-urgent-red text-[32px]">error</span>
            <p className="text-sm text-text-main mt-3">Video Library unavailable</p>
            <p className="text-xs text-text-muted mt-1">{error}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="min-h-[360px] bg-surface-solid border border-dashed border-border-subtle rounded-[24px] flex flex-col items-center justify-center text-center px-6">
            <div className="w-14 h-14 rounded-full bg-input-bg text-text-muted flex items-center justify-center">
              <span className="material-symbols-outlined text-[28px]">videocam_off</span>
            </div>
            <h2 className="text-base font-medium text-text-main mt-4">No matching video creatives yet</h2>
            <p className="text-xs text-text-muted mt-2 max-w-lg">Future competitor scans automatically inspect each ad for YouTube IDs, VAST media files and video sources. Existing ads need to be scanned again before they can appear here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-5">
            {visible.map(item => {
              const meta = sourceMeta(item.type);
              const primaryGame = item.games?.[0];
              const watchUrl = item.youtubeUrl || item.mediaUrl;
              const primaryCreative = item.creatives?.[0];

              return (
                <article key={item.id} className="bg-surface-solid border border-border-subtle rounded-[24px] overflow-hidden shadow-sm">
                  <div className="aspect-video bg-black/90 relative overflow-hidden flex items-center justify-center">
                    {item.thumbnailUrl ? (
                      <img src={item.thumbnailUrl} alt="Video creative thumbnail" className="w-full h-full object-cover" />
                    ) : (
                      <div className="text-center text-white/60">
                        <span className="material-symbols-outlined text-[44px]">movie</span>
                        <div className="text-[10px] mt-1">Direct video asset</div>
                      </div>
                    )}
                    {watchUrl && (
                      <a href={watchUrl} target="_blank" rel="noreferrer" className="absolute inset-0 flex items-center justify-center group/video">
                        <span className="w-14 h-14 rounded-full bg-black/65 backdrop-blur-sm text-white border border-white/20 flex items-center justify-center group-hover/video:scale-105 transition-transform shadow-lg">
                          <span className="material-symbols-outlined text-[29px] ml-0.5">play_arrow</span>
                        </span>
                      </a>
                    )}
                    <span className={cn("absolute top-3 left-3 px-2.5 py-1.5 rounded-full border text-[9px] font-medium flex items-center gap-1.5 backdrop-blur-md", meta.className)}>
                      <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
                      {meta.label}
                    </span>
                    <span className="absolute bottom-3 right-3 px-2 py-1 rounded-md bg-black/70 text-white text-[9px] font-mono">
                      {formatDuration(item.durationSeconds)}
                    </span>
                  </div>

                  <div className="p-4 md:p-5">
                    {primaryGame ? <VideoGameMetadata game={primaryGame} /> : (
                      <div className="text-xs text-text-muted">No mapped game metadata</div>
                    )}
                    {(item.games || []).length > 1 && (
                      <div className="text-[9px] text-text-muted mt-2">+{item.games.length - 1} other mapped {(item.games.length - 1) === 1 ? 'game' : 'games'}</div>
                    )}

                    <div className="grid grid-cols-3 gap-2 mt-4">
                      <div className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2">
                        <div className="text-[8px] text-text-muted">Used in</div>
                        <div className="text-sm font-semibold text-text-main mt-0.5">{item.adCount || 0} ads</div>
                      </div>
                      <div className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2">
                        <div className="text-[8px] text-text-muted">Resolution</div>
                        <div className="text-xs font-semibold text-text-main mt-1">{item.width && item.height ? `${item.width}×${item.height}` : '—'}</div>
                      </div>
                      <div className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2">
                        <div className="text-[8px] text-text-muted">Last seen</div>
                        <div className="text-xs font-semibold text-text-main mt-1">{formatDate(item.lastSeenAt)}</div>
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-border-subtle flex flex-wrap items-center gap-2">
                      {watchUrl && (
                        <a href={watchUrl} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-full bg-electric-blue text-white text-[10px] font-medium flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[16px]">play_circle</span>
                          Watch video
                        </a>
                      )}
                      {item.youtubeUrl && (
                        <a href={item.youtubeUrl} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-full bg-input-bg border border-border-subtle text-text-main text-[10px] font-medium flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                          YouTube
                        </a>
                      )}
                      {item.type === "direct" && item.mediaUrl && (
                        <button onClick={() => downloadDirect(item)} disabled={downloadingId === item.id} className="h-9 px-3 rounded-full bg-input-bg border border-border-subtle text-text-main text-[10px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                          <span className={cn("material-symbols-outlined text-[16px]", downloadingId === item.id && "animate-spin")}>{downloadingId === item.id ? "progress_activity" : "download"}</span>
                          Download
                        </button>
                      )}
                      {primaryCreative?.transparencyUrl && (
                        <a href={primaryCreative.transparencyUrl} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-full bg-input-bg border border-border-subtle text-text-main text-[10px] font-medium flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[16px]">ads_click</span>
                          View ad
                        </a>
                      )}
                      <span className="ml-auto text-[9px] text-text-muted font-mono truncate max-w-[180px]" title={item.youtubeId || item.sourceHost || ''}>{item.youtubeId || item.sourceHost || ''}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function useGameDrawerSlot() {
  const [drawer, setDrawer] = useState(null);

  useEffect(() => {
    let scheduled = false;
    let currentSlot = null;

    const scan = () => {
      scheduled = false;
      const links = [...document.querySelectorAll('aside a[href*="play.google.com/store/apps/details?id="]')];
      const link = links[0];
      if (!link) {
        if (currentSlot) currentSlot.remove();
        currentSlot = null;
        setDrawer(null);
        return;
      }

      const aside = link.closest("aside");
      if (!aside) return;
      const scrollRoot = [...aside.querySelectorAll("div")].find(element => {
        const classes = String(element.className || "");
        return classes.includes("flex-1") && classes.includes("overflow-y-auto") && classes.includes("custom-scrollbar");
      });
      if (!scrollRoot) return;

      let packageName = "";
      try { packageName = new URL(link.href).searchParams.get("id") || ""; } catch {}
      if (!packageName) return;
      const title = aside.querySelector("h1")?.textContent?.trim() || packageName;

      let slot = scrollRoot.querySelector('[data-atlas-keyword-slot="1"]');
      if (!slot) {
        slot = document.createElement("div");
        slot.dataset.atlasKeywordSlot = "1";
        slot.style.display = "contents";
        scrollRoot.insertBefore(slot, scrollRoot.firstChild);
      }
      currentSlot = slot;

      setDrawer(previous => {
        if (previous?.slot === slot && previous?.packageName === packageName) return previous;
        return { slot, scrollRoot, packageName, title };
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
      if (currentSlot) currentSlot.remove();
    };
  }, []);

  return drawer;
}

function distinctivenessLabel(score) {
  const value = Number(score) || 0;
  if (value >= 75) return "Very high";
  if (value >= 50) return "High";
  if (value >= 25) return "Medium";
  return "Low";
}

function KeywordIntelligence({ drawer }) {
  const [active, setActive] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState("phrases");
  const [search, setSearch] = useState("");
  const cacheRef = useRef(new Map());

  useEffect(() => {
    setActive(false);
    setData(cacheRef.current.get(drawer.packageName) || null);
    setError("");
    setView("phrases");
    setSearch("");
  }, [drawer.packageName]);

  useEffect(() => {
    const root = drawer.scrollRoot;
    const slot = drawer.slot;
    if (!root || !slot) return undefined;

    const setVisibility = () => {
      for (const child of [...root.children]) {
        if (child === slot) continue;
        if (active) {
          if (child.dataset.atlasOriginalDisplay === undefined) child.dataset.atlasOriginalDisplay = child.style.display || "";
          child.style.display = "none";
        } else if (child.dataset.atlasOriginalDisplay !== undefined) {
          child.style.display = child.dataset.atlasOriginalDisplay;
          delete child.dataset.atlasOriginalDisplay;
        }
      }
    };

    setVisibility();
    const observer = new MutationObserver(setVisibility);
    observer.observe(root, { childList: true });

    return () => {
      observer.disconnect();
      for (const child of [...root.children]) {
        if (child === slot) continue;
        if (child.dataset.atlasOriginalDisplay !== undefined) {
          child.style.display = child.dataset.atlasOriginalDisplay;
          delete child.dataset.atlasOriginalDisplay;
        }
      }
    };
  }, [drawer, active]);

  useEffect(() => {
    if (!active || data || loading) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await featureFetch(`${API_BASE}/api/keywords?packageName=${encodeURIComponent(drawer.packageName)}`);
        if (cancelled) return;
        cacheRef.current.set(drawer.packageName, result);
        setData(result);
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || "Unable to analyze keywords.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [active, data, drawer.packageName, loading]);

  const rows = useMemo(() => {
    const source = view === "words" ? data?.words : view === "all" ? data?.all : data?.phrases;
    const query = search.trim().toLowerCase();
    return (source || []).filter(row => !query || row.term.toLowerCase().includes(query));
  }, [data, view, search]);

  return (
    <div className={cn(active && "min-h-full")}>
      <div className={cn(
        "bg-surface-solid border border-border-subtle rounded-2xl p-1 flex items-center gap-1 shadow-sm",
        active ? "sticky top-0 z-30 mb-4" : "mb-0"
      )}>
        <button
          type="button"
          onClick={() => setActive(false)}
          className={cn(
            "h-9 flex-1 rounded-xl text-[10px] md:text-xs font-medium flex items-center justify-center gap-1.5 transition-colors",
            !active ? "bg-primary-container text-on-primary-container" : "text-text-muted hover:text-text-main hover:bg-input-bg"
          )}
        >
          <span className="material-symbols-outlined text-[16px]">dashboard</span>
          Overview
        </button>
        <button
          type="button"
          onClick={() => setActive(true)}
          className={cn(
            "h-9 flex-1 rounded-xl text-[10px] md:text-xs font-medium flex items-center justify-center gap-1.5 transition-colors",
            active ? "bg-primary-container text-on-primary-container" : "text-text-muted hover:text-text-main hover:bg-input-bg"
          )}
        >
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
              <p className="text-xs mt-3">Analyzing descriptions…</p>
            </div>
          ) : error ? (
            <div className="min-h-[240px] rounded-2xl border border-urgent-red/25 bg-urgent-red/5 flex flex-col items-center justify-center text-center px-5">
              <span className="material-symbols-outlined text-urgent-red text-[28px]">error</span>
              <p className="text-xs text-text-main mt-3">Keyword analysis unavailable</p>
              <p className="text-[10px] text-text-muted mt-1">{error}</p>
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
                <span className="font-semibold text-text-main">Distinctiveness</span> measures how strongly this game emphasizes a term compared with other games in Atlas. A frequently repeated phrase that few competitors use ranks above generic store wording.
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1 bg-input-bg rounded-xl p-1">
                  {[["phrases","Phrases"],["words","Single words"],["all","All"]].map(([id,label]) => (
                    <button key={id} onClick={() => setView(id)} className={cn("h-9 flex-1 rounded-lg text-[9px] md:text-[10px] font-medium", view === id ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted")}>{label}</button>
                  ))}
                </div>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">search</span>
                  <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter keywords…" className="w-full h-10 rounded-xl bg-input-bg border border-border-subtle text-text-main pl-9 pr-3 outline-none text-[10px]" />
                </div>
              </div>

              {rows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-subtle py-12 text-center text-xs text-text-muted">No keywords match this view.</div>
              ) : (
                <div className="space-y-2">
                  {rows.map((row, index) => {
                    const label = distinctivenessLabel(row.distinctiveness);
                    return (
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
                            <div className="text-[9px] font-medium text-electric-blue">{label}</div>
                            <div className="text-[8px] text-text-muted mt-0.5">{row.distinctiveness.toFixed(1)} / 100</div>
                          </div>
                        </div>
                        <div className="ml-7 mt-2 h-1.5 rounded-full bg-input-bg overflow-hidden">
                          <div className="h-full rounded-full bg-electric-blue" style={{ width: `${Math.max(2, row.distinctiveness)}%` }} />
                        </div>
                        <div className="ml-7 mt-1 text-[8px] text-text-muted">Used by {row.corpusPrevalence}% of the Atlas corpus</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {(data.shortDescription || data.longDescription) && (
                <details className="rounded-xl border border-border-subtle bg-surface-glass overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 text-[10px] font-medium text-text-main flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-electric-blue">description</span>
                    Source descriptions
                  </summary>
                  <div className="px-4 pb-4 space-y-3">
                    {data.shortDescription && (
                      <div>
                        <div className="text-[9px] font-medium text-text-muted mb-1">Short description</div>
                        <p className="text-[10px] text-text-main leading-relaxed">{data.shortDescription}</p>
                      </div>
                    )}
                    {data.longDescription && (
                      <div>
                        <div className="text-[9px] font-medium text-text-muted mb-1">Long description</div>
                        <p className="text-[10px] text-text-main leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto custom-scrollbar">{data.longDescription}</p>
                      </div>
                    )}
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

export default function AtlasIntelligenceUI() {
  const navSlots = useAtlasNavSlots();
  const drawer = useGameDrawerSlot();
  const [videoOpen, setVideoOpen] = useState(false);

  useEffect(() => {
    const closeForNativeNav = event => {
      const button = event.target.closest?.("button");
      if (!button || button.hasAttribute("data-atlas-video-nav")) return;
      const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
      if (["Dashboard", "Directory", "Country Scans", "Targets", "Settings"].includes(text)) {
        setVideoOpen(false);
      }
    };
    document.addEventListener("click", closeForNativeNav, true);
    return () => document.removeEventListener("click", closeForNativeNav, true);
  }, []);

  return (
    <>
      {navSlots.map(({ element, kind }) => createPortal(
        <VideoNavButton key={`${kind}-video-nav`} kind={kind} active={videoOpen} onClick={() => setVideoOpen(true)} />,
        element
      ))}

      {videoOpen && <VideoLibrary onClose={() => setVideoOpen(false)} />}

      {drawer && createPortal(
        <KeywordIntelligence key={drawer.packageName} drawer={drawer} />,
        drawer.slot
      )}
    </>
  );
}
