import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import AtlasFeedback from "./AtlasFeedback.jsx";
import { API_BASE } from "./apiConfig.js";
import { KeywordPanel } from "./KeywordPanel.jsx";

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
  allGames = [],
  isAdmin = false
}) {
  const [keywordTarget, setKeywordTarget] = useState(null);
  const [videos, setVideos] = useState([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const videoCacheRef = useRef(new Map());

  const drawerScrollRef = useRef(null);

  // Manual monetization override state
  const [manualOverrideStatus, setManualOverrideStatus] = useState(game?.manual_price_status || "AUTO");
  const [manualOverrideNote, setManualOverrideNote] = useState(game?.manual_price_note || "");
  const [isSavingManual, setIsSavingManual] = useState(false);
  const [manualMessage, setManualMessage] = useState(null);
  const [showMonetizationEditor, setShowMonetizationEditor] = useState(false);

  useEffect(() => {
    setManualOverrideStatus(game?.manual_price_status || "AUTO");
    setManualOverrideNote(game?.manual_price_note || "");
    setManualMessage(null);
    setShowMonetizationEditor(false);
    drawerScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [game?.package_name, game?.manual_price_status, game?.manual_price_note]);

  const handleSaveManualPricing = async () => {
    if (!game?.package_name) return;
    setIsSavingManual(true);
    setManualMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/play/games/${encodeURIComponent(game.package_name)}/manual-pricing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-atlas-token": localStorage.getItem("atlas_auth_token") || ""
        },
        body: JSON.stringify({
          status: manualOverrideStatus === "AUTO" ? "CLEAR" : manualOverrideStatus,
          note: manualOverrideNote.trim() || undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        setManualMessage({ type: "success", text: "Monetization override updated successfully." });
        AtlasFeedback.toast("Monetization override updated.", { tone: "success" });
        if (onRefreshTelemetry) {
          await onRefreshTelemetry(game.package_name);
        }
      } else {
        setManualMessage({ type: "error", text: data.error || "Failed to save override." });
      }
    } catch (e) {
      setManualMessage({ type: "error", text: e.message });
    } finally {
      setIsSavingManual(false);
    }
  };

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

    const token = localStorage.getItem("atlas_auth_token") || localStorage.getItem("atlas_token") || "";

    fetch(`${API_BASE}/api/video-assets?packageName=${encodeURIComponent(pkg)}`, {
      headers: {
        Accept: "application/json",
        ...(token ? { "x-atlas-token": token, Authorization: `Bearer ${token}` } : {})
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

  const isFree = game.pricing === "free";

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
        <div className="fixed inset-0 z-[90] flex justify-end">
          {/* Translucent backdrop with blur (does not inherit opaque solid .atlas-google-shell background) */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.aside
            ref={drawerScrollRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="atlas-google-shell relative z-10 w-full max-w-lg bg-surface-solid border-l border-border-subtle h-full overflow-y-auto p-6 flex flex-col gap-5 shadow-2xl custom-scrollbar"
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
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {(game.competitor_name || (Array.isArray(game.competitor_names) && game.competitor_names[0])) && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold border bg-electric-blue/10 border-electric-blue/30 text-electric-blue select-none"
                        title={
                          game.has_competitor_conflict && Array.isArray(game.competitor_names)
                            ? `Listed under multiple sheet columns: ${game.competitor_names.join(", ")}`
                            : "Parent Competitor"
                        }
                      >
                        {game.competitor_name || game.competitor_names[0]}
                      </span>
                    )}
                    {game.release_status === "PRE_REGISTERED" && game.pricing !== "tba" && game.price_status !== "PRICE_TBA" && (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-purple-50 dark:bg-purple-500/15 border-purple-300 dark:border-purple-500/30 text-purple-700 dark:text-purple-300 select-none">
                        Pre-Registration
                      </span>
                    )}
                    {game.pricing === "tba" || game.price_status === "PRICE_TBA" ? (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-purple-50 dark:bg-purple-500/15 border-purple-300 dark:border-purple-500/30 text-purple-700 dark:text-purple-300 select-none">
                        Pre-Registration · Price TBA
                      </span>
                    ) : game.pricing === "paid" ? (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-amber-50 dark:bg-amber-500/15 border-amber-300 dark:border-amber-500/30 text-amber-900 dark:text-amber-300 select-none">
                        {game.is_manual_price
                          ? "Paid (Manual Override)"
                          : Number(game.price || 0) > 0
                            ? `Paid Title · $${Number(game.price).toFixed(2)}`
                            : `Paid Title · ${game.price_text || 'On Offer'}`}
                      </span>
                    ) : (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-emerald-50 dark:bg-emerald-500/15 border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-400 select-none">
                        {game.is_manual_price ? "Free (Manual Override)" : "Free Play Store Title"}
                      </span>
                    )}
                    {game.monetization_hint === "LIKELY_PAID" && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-indigo-50 dark:bg-indigo-500/15 border-indigo-300 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-300 select-none cursor-help"
                        title={game.monetization_hint_evidence ? `Likely Paid: "${game.monetization_hint_evidence}"` : "Likely Paid based on developer metadata"}
                      >
                        Likely Paid
                      </span>
                    )}
                    {(game.is_suspended === true || game.release_status === "SUSPENDED") && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-urgent-red/15 border-urgent-red/30 text-urgent-red select-none"
                        title="App is unpublished or suspended on Google Play"
                      >
                        Unpublished / Suspended
                      </span>
                    )}
                    {(game.has_campaign || game.campaign_active) && !game.is_suspended && game.release_status !== "SUSPENDED" && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-sky-50 dark:bg-sky-500/15 border-sky-300 dark:border-sky-500/30 text-sky-700 dark:text-sky-300 select-none cursor-help"
                        title={
                          game.campaign_source === "transparency_center"
                            ? "Advertising campaign detected via Google Ads Transparency Center."
                            : "Advertising campaign record imported via Google Ads Transparency Center sheets."
                        }
                      >
                        Campaign
                      </span>
                    )}
                  </div>
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

            {/* Monetization Override — Only shown when relevant (Pre-Registration / Price TBA / Likely Paid / Manual Override active) */}
            {isAdmin &&
              (game.release_status === "PRE_REGISTERED" ||
                game.pricing === "tba" ||
                game.price_status === "PRICE_TBA" ||
                game.is_manual_price ||
                game.monetization_hint === "LIKELY_PAID" ||
                showMonetizationEditor) && (
                <div className="bg-surface-solid border border-border-subtle rounded-2xl p-3.5 flex flex-col gap-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-text-main flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[17px] text-electric-blue">tune</span>
                      <span>Monetization Override</span>
                    </span>
                    {game.is_manual_price && (
                      <span className="text-[10px] text-amber-400 font-semibold bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                        Manual ({game.manual_price_by || "admin"})
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={manualOverrideStatus}
                      onChange={(e) => setManualOverrideStatus(e.target.value)}
                      className="h-8 px-2.5 rounded-lg bg-input-bg border border-border-subtle text-xs font-semibold text-text-main focus:border-electric-blue focus:outline-none min-w-[140px] flex-1"
                    >
                      <option value="AUTO">Auto</option>
                      <option value="PAID">Paid</option>
                      <option value="FREE">Free</option>
                    </select>
                    <input
                      type="text"
                      value={manualOverrideNote}
                      onChange={(e) => setManualOverrideNote(e.target.value)}
                      placeholder="Note (optional)..."
                      className="h-8 px-2.5 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main focus:border-electric-blue focus:outline-none min-w-[140px] flex-1"
                    />
                    <button
                      type="button"
                      disabled={isSavingManual}
                      onClick={handleSaveManualPricing}
                      className="h-8 px-3.5 rounded-lg bg-electric-blue text-white font-semibold text-xs hover:opacity-90 transition disabled:opacity-50 shrink-0"
                    >
                      {isSavingManual ? "Saving..." : "Apply"}
                    </button>
                  </div>
                  {manualMessage && (
                    <div className={`text-[11px] font-medium ${manualMessage.type === "success" ? "text-emerald-400" : "text-urgent-red"}`}>
                      {manualMessage.text}
                    </div>
                  )}
                </div>
              )}

            {/* 6 Metric Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Package Name</div>
                <div className="flex items-center justify-between gap-1.5 mt-0.5">
                  <div
                    className="text-[11px] font-mono font-semibold text-text-main truncate"
                    title={game.package_name}
                  >
                    {game.package_name}
                  </div>
                  <button
                    type="button"
                    onClick={() => AtlasFeedback.copy(game.package_name, "Package ID")}
                    title="Copy package ID"
                    aria-label={`Copy ${game.package_name}`}
                    className="p-0.5 rounded hover:bg-surface-solid text-text-muted hover:text-electric-blue transition shrink-0"
                  >
                    <span className="material-symbols-outlined text-[13px]">content_copy</span>
                  </button>
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Real Installs</div>
                <div className="text-xs font-mono font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5">
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

            {/* Action Buttons */}
            <div className={`grid ${isAdmin ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"} gap-2.5`}>
              {isAdmin && (
                <button
                  type="button"
                  disabled={isRefreshing}
                  onClick={(e) => onRefreshTelemetry && onRefreshTelemetry(game, e)}
                  className="py-2.5 px-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-400 text-xs font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-500/25 transition flex items-center justify-center gap-1.5 disabled:opacity-50"
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
              )}

              {countryLiveCount != null ? (
                <button
                  type="button"
                  onClick={() => onOpenCountryScan && onOpenCountryScan(game.package_name)}
                  className="py-2.5 px-3 rounded-xl bg-amber-100/90 dark:bg-amber-500/15 border border-amber-300 dark:border-amber-500/30 text-amber-900 dark:text-amber-300 text-xs font-semibold hover:bg-amber-200/80 dark:hover:bg-amber-500/25 transition flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">public</span>
                  Live in {countryLiveCount}/176 Countries
                </button>
              ) : isAdmin ? (
                <button
                  type="button"
                  onClick={() => onOpenCountryScan && onOpenCountryScan(game.package_name)}
                  className="py-2.5 px-3 rounded-xl bg-amber-100/90 dark:bg-amber-500/15 border border-amber-300 dark:border-amber-500/30 text-amber-900 dark:text-amber-300 text-xs font-semibold hover:bg-amber-200/80 dark:hover:bg-amber-500/25 transition flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">public</span>
                  Scan 176 Countries
                </button>
              ) : (
                <div className="py-2.5 px-3 rounded-xl bg-input-bg border border-border-subtle text-text-muted text-xs font-medium flex items-center justify-center gap-1.5 select-none">
                  <span className="material-symbols-outlined text-[16px]">public</span>
                  No country scan data
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                data-atlas-keywords="1"
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
                <h4 className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
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
                      <span className="font-mono text-emerald-700 dark:text-emerald-400 shrink-0 text-[11px]">
                        {formatCompactNumber(s.real_installs ?? s.min_installs)} inst ·{" "}
                        {s.release_date ? String(s.release_date).slice(0, 10) : "—"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.aside>
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
