import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "./apiConfig.js";

const AUTH_TOKEN_KEY = "atlas_auth_token";

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "69420",
      ...(token ? { "x-atlas-token": token } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try { msg = JSON.parse(text)?.error || msg; } catch {}
    throw new Error(msg);
  }
  return response.json();
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return null;
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

export default memo(function CreativesView({ isAdmin = false, onGameClick = null }) {
  const [creatives, setCreatives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [visibleCount, setVisibleCount] = useState(36);

  const loadCreatives = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchJson(`${API_BASE}/api/video-assets`);
      setCreatives(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load creatives:", err);
      setError(err.message || "Failed to load creatives");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCreatives();
  }, [loadCreatives]);

  const filteredCreatives = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return creatives;
    return creatives.filter((c) => {
      if (c.customTitle && c.customTitle.toLowerCase().includes(q)) return true;
      if (c.youtubeId && c.youtubeId.toLowerCase().includes(q)) return true;
      if (c.assetKey && c.assetKey.toLowerCase().includes(q)) return true;
      if (Array.isArray(c.manualPackageNames) && c.manualPackageNames.some(p => p.toLowerCase().includes(q))) return true;
      if (Array.isArray(c.tags) && c.tags.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [creatives, search]);

  const displayedCreatives = useMemo(() => {
    return filteredCreatives.slice(0, visibleCount);
  }, [filteredCreatives, visibleCount]);

  const handleDeleteCreative = async (assetId) => {
    if (!window.confirm("Are you sure you want to permanently delete this creative asset?")) return;
    try {
      await fetchJson(`${API_BASE}/api/video-assets/${assetId}`, { method: "DELETE" });
      setCreatives(prev => prev.filter(c => c.id !== assetId));
    } catch (err) {
      alert("Failed to delete creative: " + err.message);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full px-2 sm:px-4 py-4">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-electric-blue/10 border border-electric-blue/25 text-electric-blue text-[11px] font-semibold mb-2">
            <span className="material-symbols-outlined text-[15px]">movie</span>
            Creative Intelligence &amp; Ad Library
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">
            Creatives ({creatives.length.toLocaleString()})
          </h1>
          <p className="text-xs text-text-muted mt-1">
            Video ad creatives discovered from transparency centers and ad networks across tracked competitors.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <span className="material-symbols-outlined text-[17px] text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
              search
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisibleCount(36);
              }}
              placeholder="Search creatives, packages, tags..."
              className="h-10 pl-9 pr-3 rounded-xl bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:border-electric-blue outline-none transition w-64 sm:w-72"
            />
          </div>
          <button
            type="button"
            onClick={loadCreatives}
            className="h-10 px-3.5 rounded-xl bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-semibold flex items-center gap-1.5 transition"
            title="Refresh Creatives"
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {/* ERROR MESSAGE */}
      {error && (
        <div className="p-4 rounded-2xl bg-urgent-red/10 border border-urgent-red/25 text-urgent-red text-xs">
          {error}
        </div>
      )}

      {/* CREATIVES GRID */}
      {loading ? (
        <div className="py-24 text-center">
          <div className="w-10 h-10 border-2 border-electric-blue border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs text-text-muted">Loading creatives library...</p>
        </div>
      ) : filteredCreatives.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border-subtle rounded-3xl bg-surface-solid">
          <span className="material-symbols-outlined text-[40px] text-text-muted mb-2">videocam_off</span>
          <p className="text-sm font-semibold text-text-main">No video creatives found</p>
          <p className="text-xs text-text-muted mt-1">Try adjusting your search query.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {displayedCreatives.map((creative) => {
            const thumb = creative.thumbnailUrl || (creative.youtubeId ? `https://i1.ytimg.com/vi/${creative.youtubeId}/hqdefault.jpg` : null);
            const duration = formatDuration(creative.durationSeconds);
            const title = creative.customTitle || (creative.youtubeId ? `Video ${creative.youtubeId}` : `Asset #${creative.id}`);
            const watchUrl = creative.youtubeUrl || (!creative.mediaUrlExpired ? creative.mediaUrl : null);

            return (
              <div
                key={creative.id}
                className="group relative flex flex-col bg-surface-solid border border-border-subtle rounded-2xl overflow-hidden hover:border-electric-blue/40 transition shadow-sm"
              >
                {/* Thumbnail Container */}
                <div
                  className="relative aspect-video bg-black/80 cursor-pointer overflow-hidden"
                  onClick={() => setSelectedVideo(creative)}
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={title}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-90 group-hover:opacity-100"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-text-muted">
                      <span className="material-symbols-outlined text-[36px]">movie</span>
                    </div>
                  )}

                  {/* Play Overlay */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
                    <div className="w-11 h-11 rounded-full bg-electric-blue/90 text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                      <span className="material-symbols-outlined text-[24px] pl-0.5">play_arrow</span>
                    </div>
                  </div>

                  {/* Duration Badge */}
                  {duration && (
                    <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-black/80 text-white font-mono text-[10px] font-semibold">
                      {duration}
                    </span>
                  )}

                  {/* Ad Count Badge */}
                  {creative.adCount > 0 && (
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-amber-500/90 text-slate-950 font-bold text-[10px] shadow-sm">
                      {creative.adCount} ads
                    </span>
                  )}
                </div>

                {/* Info Container */}
                <div className="p-3.5 flex flex-col flex-1 justify-between gap-2.5">
                  <div>
                    <h3
                      className="text-xs font-semibold text-text-main truncate group-hover:text-electric-blue cursor-pointer transition-colors"
                      title={title}
                      onClick={() => setSelectedVideo(creative)}
                    >
                      {title}
                    </h3>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-text-muted">
                      <span>{creative.source === "youtube" ? "YouTube" : "Direct Video"}</span>
                      {creative.firstSeenAt && (
                        <>
                          <span>•</span>
                          <span>{new Date(creative.firstSeenAt).toLocaleDateString()}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Linked packages */}
                  {Array.isArray(creative.manualPackageNames) && creative.manualPackageNames.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {creative.manualPackageNames.slice(0, 2).map((pkg) => (
                        <span
                          key={pkg}
                          className="px-1.5 py-0.5 rounded bg-input-bg border border-border-subtle text-[9px] font-mono text-text-muted truncate max-w-[140px]"
                          title={pkg}
                        >
                          {pkg}
                        </span>
                      ))}
                      {creative.manualPackageNames.length > 2 && (
                        <span className="text-[9px] text-text-muted">+{creative.manualPackageNames.length - 2}</span>
                      )}
                    </div>
                  )}

                  {/* Footer actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-subtle text-xs">
                    {watchUrl ? (
                      <a
                        href={watchUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-electric-blue hover:underline inline-flex items-center gap-1 text-[11px] font-medium"
                      >
                        Watch External <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                      </a>
                    ) : <div />}

                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => handleDeleteCreative(creative.id)}
                        className="text-text-muted hover:text-urgent-red p-1 rounded-lg transition"
                        title="Delete Creative"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* LOAD MORE BUTTON */}
      {!loading && filteredCreatives.length > visibleCount && (
        <div className="flex justify-center mt-6">
          <button
            type="button"
            onClick={() => setVisibleCount((prev) => prev + 36)}
            className="px-6 py-2.5 rounded-2xl bg-surface-solid border border-border-subtle text-xs font-semibold text-text-main hover:bg-input-bg transition"
          >
            Load More ({filteredCreatives.length - visibleCount} remaining)
          </button>
        </div>
      )}

      {/* VIDEO PREVIEW MODAL */}
      {selectedVideo && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedVideo(null)}
        >
          <div
            className="bg-surface-solid border border-border-subtle rounded-3xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-main truncate max-w-md">
                {selectedVideo.customTitle || selectedVideo.youtubeId || `Asset #${selectedVideo.id}`}
              </h3>
              <button
                type="button"
                onClick={() => setSelectedVideo(null)}
                className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div className="aspect-video bg-black flex items-center justify-center">
              {selectedVideo.youtubeId ? (
                <iframe
                  title="Creative Preview"
                  src={`https://www.youtube.com/embed/${selectedVideo.youtubeId}?autoplay=1`}
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : selectedVideo.mediaUrl && !selectedVideo.mediaUrlExpired ? (
                <video
                  src={selectedVideo.mediaUrl}
                  controls
                  autoPlay
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="text-center p-6 text-text-muted">
                  <span className="material-symbols-outlined text-[48px] mb-2">videocam_off</span>
                  <p className="text-sm">Video stream expired or not embeddable.</p>
                  {selectedVideo.youtubeUrl && (
                    <a
                      href={selectedVideo.youtubeUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-block px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold"
                    >
                      Open on YouTube
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 bg-surface-solid flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-text-muted">Ad Instances: <strong>{selectedVideo.adCount || 0}</strong></span>
                {selectedVideo.youtubeUrl && (
                  <a
                    href={selectedVideo.youtubeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-electric-blue hover:underline inline-flex items-center gap-1 font-semibold"
                  >
                    Watch on YouTube <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
