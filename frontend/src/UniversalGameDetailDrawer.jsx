import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { KeywordPanel } from "./AtlasIntelligenceLayer.jsx";

const API_BASE = "";

function formatCompactNumber(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

export default function UniversalGameDetailDrawer({
  game,
  onClose,
  onSelectGame,
  onRefreshTelemetry,
  isRefreshing = false,
  onOpenCountryScan,
  allGames = []
}) {
  const [keywordTarget, setKeywordTarget] = useState(null);
  const [videos, setVideos] = useState([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const videoCacheRef = useRef(new Map());

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        if (keywordTarget) {
          setKeywordTarget(null);
        } else if (onClose) {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keywordTarget, onClose]);

  // Load video creatives for this package
  useEffect(() => {
    const pkg = game?.package_name;
    if (!pkg) {
      setVideos([]);
      setVideosLoading(false);
      return;
    }

    if (videoCacheRef.current.has(pkg)) {
      setVideos(videoCacheRef.current.get(pkg));
      setVideosLoading(false);
      return;
    }

    let active = true;
    setVideosLoading(true);

    fetch(`${API_BASE}/api/video-assets?packageName=${encodeURIComponent(pkg)}`, {
      headers: {
        Accept: "application/json",
        ...(localStorage.getItem("atlas_token")
          ? { "x-atlas-token": localStorage.getItem("atlas_token") }
          : {})
      }
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data) ? data : [];
        videoCacheRef.current.set(pkg, list);
        setVideos(list);
        setVideosLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setVideos([]);
        setVideosLoading(false);
      });

    return () => {
      active = false;
    };
  }, [game?.package_name]);

  // Compute other games by same publisher
  const siblings = useMemo(() => {
    if (!game || !allGames || allGames.length === 0) return [];
    const pubName = (game.publisher_name || game.developer_name || "").trim().toLowerCase();
    if (!pubName) return [];
    return allGames
      .filter((g) => {
        const otherPub = (g.publisher_name || g.developer_name || "").trim().toLowerCase();
        return otherPub === pubName && g.package_name !== game.package_name;
      })
      .sort((a, b) => {
        const aInst = Number(a.real_installs ?? a.min_installs ?? 0);
        const bInst = Number(b.real_installs ?? b.min_installs ?? 0);
        return bInst - aInst;
      });
  }, [game, allGames]);

  if (!game) return null;

  const isFree =
    game.pricing === "free" ||
    game.is_paid === false ||
    game.is_paid === 0 ||
    game.is_paid === null ||
    Number(game.price || 0) === 0;

  const publisherDisplayName =
    game.publisher_name || game.developer_name || "Unknown Publisher";

  const releaseDateText = game.release_date || game.released;
  const formattedRelease = releaseDateText
    ? String(releaseDateText).slice(0, 10)
    : "Unknown";

  const firstSeenText = game.first_seen_at
    ? String(game.first_seen_at).slice(0, 10)
    : "—";

  const realInstallsVal = game.real_installs != null
    ? Number(game.real_installs).toLocaleString()
    : game.installs || (game.min_installs ? Number(game.min_installs).toLocaleString() : "0");

  const velocityVal = Number(game.installs_delta_1d || 0);

  const countryLiveCount = game.country_scan?.liveCount ?? game.country_scan?.counts?.live;

  return (
    <>
      {createPortal(
        <div
          onClick={onClose}
          className="atlas-google-shell fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex justify-end"
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-surface-solid border-l border-border-subtle h-full overflow-y-auto p-6 flex flex-col gap-5 shadow-2xl custom-scrollbar"
          >
            {/* Header: Icon, Badge, Title, Publisher, Close */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3.5 min-w-0">
                {game.icon ? (
                  <img
                    src={game.icon}
                    alt={game.title || game.package_name}
                    className="w-16 h-16 rounded-2xl object-cover border border-border-subtle shrink-0"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-2xl bg-input-bg border border-border-subtle flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-text-muted text-[32px]">
                      sports_esports
                    </span>
                  </div>
                )}
                <div className="min-w-0">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                      isFree
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    {isFree
                      ? "Free Play Store Title"
                      : `Paid Title · $${Number(game.price || 0).toFixed(2)}`}
                  </span>
                  <h3 className="text-base font-semibold text-text-main mt-1 truncate" title={game.title}>
                    {game.title || game.package_name}
                  </h3>
                  <div className="text-xs text-text-muted truncate">
                    {publisherDisplayName}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main shrink-0 transition-colors"
                aria-label="Close game details drawer"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* 6 Metric Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Package Name</div>
                <div
                  className="text-[11px] font-mono font-semibold text-text-main mt-0.5 truncate"
                  title={game.package_name}
                >
                  {game.package_name}
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Real Installs</div>
                <div className="text-xs font-mono font-semibold text-emerald-400 mt-0.5">
                  {realInstallsVal}
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Daily Velocity</div>
                <div className="text-xs font-mono font-semibold text-electric-blue mt-0.5">
                  {velocityVal > 0 ? `+${velocityVal.toLocaleString()} / day` : "—"}
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Rating &amp; Reviews</div>
                <div className="text-xs font-semibold text-text-main mt-0.5">
                  ⭐ {game.rating ? Number(game.rating).toFixed(2) : "—"}{" "}
                  ({Number(game.ratings_count || game.review_count || 0).toLocaleString()})
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Play Launch Date</div>
                <div className="text-xs font-mono font-semibold text-text-main mt-0.5">
                  {formattedRelease}
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">First Seen in Atlas</div>
                <div className="text-xs font-mono font-semibold text-text-main mt-0.5">
                  {firstSeenText}
                </div>
              </div>
            </div>

            {/* 4 Action Buttons (2x2 Grid) */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={isRefreshing}
                onClick={(e) => onRefreshTelemetry && onRefreshTelemetry(game.package_name, e)}
                className="py-2.5 px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/25 transition flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    isRefreshing ? "animate-spin" : ""
                  }`}
                >
                  refresh
                </span>
                {isRefreshing ? "Refreshing..." : "Refresh Telemetry"}
              </button>

              <button
                type="button"
                onClick={() => onOpenCountryScan && onOpenCountryScan(game.package_name)}
                className="py-2.5 px-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold hover:bg-amber-500/25 transition flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">public</span>
                {countryLiveCount != null
                  ? `Live in ${countryLiveCount}/176 Countries`
                  : "Scan 176 Countries"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() =>
                  setKeywordTarget({
                    packageName: game.package_name,
                    title: game.title || game.package_name
                  })
                }
                className="py-2.5 px-3 rounded-xl bg-input-bg border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue hover:text-electric-blue transition flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">key</span>
                Keywords Intelligence
              </button>

              <a
                href={
                  game.url ||
                  `https://play.google.com/store/apps/details?id=${encodeURIComponent(
                    game.package_name
                  )}`
                }
                target="_blank"
                rel="noreferrer"
                className="py-2.5 px-3 rounded-xl bg-electric-blue text-white text-xs font-semibold text-center hover:opacity-95 transition flex items-center justify-center gap-1.5"
              >
                Open on Play Store
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              </a>
            </div>

            {/* Video Creatives Section (when applicable) */}
            {(videosLoading || videos.length > 0) && (
              <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-electric-blue flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">video_library</span>
                    Video Creatives
                  </h4>
                  {!videosLoading && (
                    <span className="font-mono text-[10px] text-text-muted bg-input-bg px-2.5 py-0.5 rounded-full border border-border-subtle">
                      {videos.length} found
                    </span>
                  )}
                </div>

                {videosLoading ? (
                  <div className="h-24 rounded-xl border border-border-subtle bg-input-bg/50 flex items-center justify-center gap-2 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[17px] animate-spin">
                      progress_activity
                    </span>
                    Loading video creatives...
                  </div>
                ) : (
                  <div className="flex overflow-x-auto gap-3 pb-2 snap-x snap-mandatory custom-scrollbar">
                    {videos.map((asset) => {
                      const watchUrl =
                        asset.youtubeUrl || (!asset.mediaUrlExpired ? asset.mediaUrl : null);
                      const thumbnail =
                        asset.thumbnailUrl || game.header_image || game.icon;
                      return (
                        <a
                          key={asset.assetKey || asset.id}
                          href={watchUrl || "#"}
                          target={watchUrl ? "_blank" : undefined}
                          rel={watchUrl ? "noreferrer" : undefined}
                          onClick={(e) => {
                            if (!watchUrl) e.preventDefault();
                          }}
                          className="group/video relative w-[180px] h-[110px] shrink-0 rounded-xl overflow-hidden snap-start border border-border-subtle bg-black shadow-sm"
                          title={watchUrl ? "Watch video creative" : "Video link unavailable"}
                        >
                          {thumbnail ? (
                            <img
                              loading="lazy"
                              decoding="async"
                              src={thumbnail}
                              alt="Video creative"
                              className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover/video:scale-[1.03] transition-transform duration-200"
                            />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-white/60">
                              <span className="material-symbols-outlined text-[28px]">movie</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/10" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="w-9 h-9 rounded-full bg-black/60 border border-white/25 backdrop-blur-sm text-white flex items-center justify-center">
                              <span className="material-symbols-outlined text-[22px] ml-0.5">
                                play_arrow
                              </span>
                            </span>
                          </div>
                          <div className="absolute left-2.5 right-2.5 bottom-2 flex items-center justify-between gap-2 text-white">
                            <span className="text-[9px] font-medium truncate">
                              {asset.source === "youtube" ? "YouTube" : "Direct video"}
                            </span>
                            <span className="text-[8px] bg-black/60 rounded-full px-1.5 py-0.5 shrink-0">
                              {Number(asset.adCount) || 0} ads
                            </span>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Sibling Games by Same Publisher */}
            {siblings.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
                <h4 className="text-xs font-semibold text-emerald-400">
                  Other Games by {publisherDisplayName} ({siblings.length})
                </h4>
                <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                  {siblings.slice(0, 25).map((s) => (
                    <button
                      key={s.package_name}
                      type="button"
                      onClick={() => onSelectGame && onSelectGame(s)}
                      className="p-2 rounded-lg bg-input-bg hover:bg-emerald-500/10 flex items-center justify-between gap-2 text-left text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {s.icon ? (
                          <img
                            src={s.icon}
                            alt=""
                            className="w-6 h-6 rounded object-cover shrink-0"
                          />
                        ) : (
                          <div className="w-6 h-6 rounded bg-surface-solid border border-border-subtle shrink-0" />
                        )}
                        <span className="truncate text-text-main font-medium">{s.title}</span>
                      </div>
                      <span className="font-mono text-emerald-400 shrink-0 text-[11px]">
                        {formatCompactNumber(s.real_installs ?? s.min_installs)} inst ·{" "}
                        {s.release_date ? String(s.release_date).slice(0, 10) : "—"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>,
        document.body
      )}

      {/* Embedded Keyword Intelligence Modal (z-[130] via Portal) */}
      {keywordTarget && (
        <KeywordPanel
          packageName={keywordTarget.packageName}
          title={keywordTarget.title}
          onClose={() => setKeywordTarget(null)}
        />
      )}
    </>
  );
}
