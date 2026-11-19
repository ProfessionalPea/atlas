import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import AtlasFeedback from "./AtlasFeedback.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import { Badge } from "./components/ui/UiPrimitives.jsx";
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
      const res = await fetch(
        `${API_BASE}/api/play/games/${encodeURIComponent(game.package_name)}/manual-pricing`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-atlas-token": localStorage.getItem("atlas_auth_token") || ""
          },
          body: JSON.stringify({
            status: manualOverrideStatus === "AUTO" ? "CLEAR" : manualOverrideStatus,
            note: manualOverrideNote.trim() || undefined
          })
        }
      );
      const data = await res.json();
      if (res.ok) {
        setManualMessage({ type: "success", text: "Monetization override updated." });
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

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        if (keywordTarget) setKeywordTarget(null);
        else if (onClose) onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keywordTarget, onClose]);

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

  const publisherDisplayName =
    game.publisher_name || game.developer_name || "Unknown Publisher";
  const releaseDateText = game.release_date || game.released;
  const formattedRelease = releaseDateText ? String(releaseDateText).slice(0, 10) : "Unknown";
  const firstSeenText = game.first_seen_at ? String(game.first_seen_at).slice(0, 10) : "—";
  const realInstallsVal =
    game.real_installs != null
      ? Number(game.real_installs).toLocaleString()
      : game.installs || (game.min_installs ? Number(game.min_installs).toLocaleString() : "0");
  const velocityVal = Number(game.installs_delta_1d || 0);
  const countryLiveCount = game.country_scan?.liveCount ?? game.country_scan?.counts?.live;

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[90] flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55 backdrop-blur-[2px]"
          />

          <motion.aside
            ref={drawerScrollRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 w-full max-w-lg bg-surface-solid border-l border-border-subtle h-full overflow-y-auto p-5 sm:p-6 shadow-xl custom-scrollbar"
          >
            <div key={game.package_name} className="atlas-tab-swap flex flex-col gap-5">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3.5 min-w-0">
                  {game.icon ? (
                    <img
                      src={game.icon}
                      alt={game.title || game.package_name}
                      className="w-14 h-14 rounded-xl object-cover border border-border-subtle shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-xl bg-input-bg border border-border-subtle flex items-center justify-center shrink-0 text-text-muted">
                      <AtlasIcon name="sports_esports" size={26} />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(game.competitor_name || (Array.isArray(game.competitor_names) && game.competitor_names[0])) && (
                        <Badge
                          tone="accent"
                          title={
                            game.has_competitor_conflict && Array.isArray(game.competitor_names)
                              ? `Listed under multiple sheet columns: ${game.competitor_names.join(", ")}`
                              : "Parent Competitor"
                          }
                        >
                          {game.competitor_name || game.competitor_names[0]}
                        </Badge>
                      )}
                      {game.release_status === "PRE_REGISTERED" &&
                        game.pricing !== "tba" &&
                        game.price_status !== "PRICE_TBA" && (
                          <Badge tone="neutral">Pre-Registration</Badge>
                        )}
                      {game.pricing === "tba" || game.price_status === "PRICE_TBA" ? (
                        <Badge tone="neutral">Pre-Reg · Price TBA</Badge>
                      ) : game.pricing === "paid" ? (
                        <Badge tone="warning">
                          {game.is_manual_price
                            ? "Paid (Manual)"
                            : Number(game.price || 0) > 0
                            ? `Paid · $${Number(game.price).toFixed(2)}`
                            : `Paid · ${game.price_text || "Offer"}`}
                        </Badge>
                      ) : (
                        <Badge tone="success">
                          {game.is_manual_price ? "Free (Manual)" : "Free"}
                        </Badge>
                      )}
                      {game.monetization_hint === "LIKELY_PAID" && (
                        <Badge
                          tone="warning"
                          title={
                            game.monetization_hint_evidence
                              ? `Likely Paid: "${game.monetization_hint_evidence}"`
                              : "Likely Paid based on developer metadata"
                          }
                        >
                          Likely Paid
                        </Badge>
                      )}
                      {(game.is_suspended === true || game.release_status === "SUSPENDED") && (
                        <Badge tone="danger" title="App is unpublished or suspended on Google Play">
                          Suspended
                        </Badge>
                      )}
                      {(game.has_campaign || game.campaign_active) &&
                        !game.is_suspended &&
                        game.release_status !== "SUSPENDED" && (
                          <Badge
                            tone="accent"
                            title={
                              game.campaign_source === "transparency_center"
                                ? "Advertising campaign detected via Google Ads Transparency Center."
                                : "Advertising campaign record imported via Google Ads Transparency Center sheets."
                            }
                          >
                            Ads Active
                          </Badge>
                        )}
                    </div>
                    <h3
                      className="text-base font-semibold text-text-main mt-1.5 truncate"
                      title={game.title}
                    >
                      {game.title || game.package_name}
                    </h3>
                    <div className="text-[13px] text-text-muted truncate">{publisherDisplayName}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-8 h-8 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main flex items-center justify-center shrink-0 transition-colors"
                  aria-label="Close game details drawer"
                >
                  <AtlasIcon name="close" size={18} />
                </button>
              </div>

              {/* Monetization Override */}
              {isAdmin &&
                (game.release_status === "PRE_REGISTERED" ||
                  game.pricing === "tba" ||
                  game.price_status === "PRICE_TBA" ||
                  game.is_manual_price ||
                  game.monetization_hint === "LIKELY_PAID" ||
                  showMonetizationEditor) && (
                  <div className="bg-input-bg/50 border border-border-subtle rounded-xl p-3.5 flex flex-col gap-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-text-main flex items-center gap-1.5">
                        <AtlasIcon name="tune" size={15} className="text-text-muted" />
                        Monetization Override
                      </span>
                      {game.is_manual_price && (
                        <Badge tone="warning">
                          Manual ({game.manual_price_by || "admin"})
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={manualOverrideStatus}
                        onChange={(e) => setManualOverrideStatus(e.target.value)}
                        className="h-9 px-2.5 rounded-lg bg-surface-solid border border-border-subtle text-xs font-medium text-text-main focus:border-accent focus:outline-none min-w-[130px] flex-1"
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
                        className="h-9 px-2.5 rounded-lg bg-surface-solid border border-border-subtle text-xs text-text-main focus:border-accent focus:outline-none min-w-[130px] flex-1"
                      />
                      <button
                        type="button"
                        disabled={isSavingManual}
                        onClick={handleSaveManualPricing}
                        className="h-9 px-3.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg font-medium text-xs transition-colors disabled:opacity-50 shrink-0"
                      >
                        {isSavingManual ? "Saving..." : "Apply"}
                      </button>
                    </div>
                    {manualMessage && (
                      <div
                        className={`text-xs font-medium ${
                          manualMessage.type === "success" ? "text-sem-success" : "text-sem-danger"
                        }`}
                      >
                        {manualMessage.text}
                      </div>
                    )}
                  </div>
                )}

              {/* 6 Key Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">Package ID</div>
                  <div className="flex items-center justify-between gap-1.5 mt-1">
                    <div
                      className="text-xs font-mono font-medium text-text-main truncate"
                      title={game.package_name}
                    >
                      {game.package_name}
                    </div>
                    <button
                      type="button"
                      onClick={() => AtlasFeedback.copy(game.package_name, "Package ID")}
                      title="Copy package ID"
                      aria-label={`Copy ${game.package_name}`}
                      className="p-1 rounded-md hover:bg-surface-solid text-text-muted hover:text-text-main transition-colors shrink-0"
                    >
                      <AtlasIcon name="content_copy" size={13} />
                    </button>
                  </div>
                </div>

                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">Real Installs</div>
                  <div className="text-[13px] font-mono font-semibold text-sem-success mt-1 tabular-nums">
                    {realInstallsVal}
                  </div>
                </div>

                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">Daily Velocity</div>
                  <div className="text-[13px] font-mono font-semibold text-text-main mt-1 tabular-nums">
                    {velocityVal > 0 ? `+${velocityVal.toLocaleString()}/d` : "—"}
                  </div>
                </div>

                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">Rating &amp; Reviews</div>
                  <div className="text-[13px] font-medium text-text-main mt-1 flex items-center gap-1 tabular-nums">
                    <AtlasIcon name="star" size={13} className="text-sem-warning" />
                    <span>{game.rating ? Number(game.rating).toFixed(2) : "—"}</span>
                    <span className="text-xs text-text-muted">
                      ({Number(game.ratings_count || game.review_count || 0).toLocaleString()})
                    </span>
                  </div>
                </div>

                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">Play Launch Date</div>
                  <div className="text-[13px] font-mono font-medium text-text-main mt-1 tabular-nums">
                    {formattedRelease}
                  </div>
                </div>

                <div className="bg-input-bg/50 border border-border-subtle rounded-lg p-3">
                  <div className="text-xs text-text-muted">First Seen</div>
                  <div className="text-[13px] font-mono font-medium text-text-main mt-1 tabular-nums">
                    {firstSeenText}
                  </div>
                </div>
              </div>

              {/* Action Buttons (max 1 primary button) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {isAdmin && (
                  <button
                    type="button"
                    disabled={isRefreshing}
                    onClick={(e) => onRefreshTelemetry && onRefreshTelemetry(game, e)}
                    className="h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <AtlasIcon
                      name="refresh"
                      size={15}
                      className={`text-text-muted ${isRefreshing ? "animate-spin" : ""}`}
                    />
                    {isRefreshing ? "Refreshing..." : "Refresh Telemetry"}
                  </button>
                )}

                {countryLiveCount != null ? (
                  <button
                    type="button"
                    onClick={() => onOpenCountryScan && onOpenCountryScan(game.package_name)}
                    className="h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    <AtlasIcon name="public" size={15} className="text-text-muted" />
                    Live in {countryLiveCount}/176 Countries
                  </button>
                ) : isAdmin ? (
                  <button
                    type="button"
                    onClick={() => onOpenCountryScan && onOpenCountryScan(game.package_name)}
                    className="h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    <AtlasIcon name="public" size={15} className="text-text-muted" />
                    Scan 176 Countries
                  </button>
                ) : (
                  <div className="h-9 px-3 rounded-lg bg-input-bg border border-border-subtle text-text-muted text-xs font-medium flex items-center justify-center gap-1.5 select-none">
                    <AtlasIcon name="public" size={15} />
                    No country scan data
                  </div>
                )}

                <button
                  type="button"
                  data-atlas-keywords="1"
                  onClick={() =>
                    setKeywordTarget({
                      packageName: game.package_name,
                      title: game.title || game.package_name
                    })
                  }
                  className="h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                >
                  <AtlasIcon name="key" size={15} className="text-text-muted" />
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
                  className="h-9 px-3 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-medium text-center transition-colors flex items-center justify-center gap-1.5"
                >
                  Open on Play Store
                  <AtlasIcon name="open_in_new" size={14} />
                </a>
              </div>

              {/* Video Creatives */}
              {(videosLoading || videos.length > 0) && (
                <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-[13px] font-semibold text-text-main flex items-center gap-1.5">
                      <AtlasIcon name="video_library" size={15} className="text-text-muted" />
                      Video Creatives
                    </h4>
                    {!videosLoading && (
                      <span className="font-mono text-xs text-text-muted tabular-nums">
                        {videos.length} found
                      </span>
                    )}
                  </div>

                  {videosLoading ? (
                    <div className="h-24 rounded-xl border border-border-subtle bg-input-bg/50 flex items-center justify-center gap-2 text-xs text-text-muted">
                      <AtlasIcon name="progress_activity" size={16} className="animate-spin" />
                      Loading video creatives...
                    </div>
                  ) : (
                    <div className="flex overflow-x-auto gap-3 pb-2 snap-x snap-mandatory custom-scrollbar">
                      {videos.map((asset) => {
                        const watchUrl =
                          asset.youtubeUrl || (!asset.mediaUrlExpired ? asset.mediaUrl : null);
                        const thumbnail = asset.thumbnailUrl || game.header_image || game.icon;
                        return (
                          <a
                            key={asset.assetKey || asset.id}
                            href={watchUrl || "#"}
                            target={watchUrl ? "_blank" : undefined}
                            rel={watchUrl ? "noreferrer" : undefined}
                            onClick={(e) => {
                              if (!watchUrl) e.preventDefault();
                            }}
                            className="group/video relative w-[184px] h-[112px] shrink-0 rounded-xl overflow-hidden snap-start border border-border-subtle bg-black"
                            title={watchUrl ? "Watch video creative" : "Video link unavailable"}
                          >
                            {thumbnail ? (
                              <img
                                loading="lazy"
                                decoding="async"
                                src={thumbnail}
                                alt="Video creative"
                                className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover/video:opacity-100 transition-opacity"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-white/60">
                                <AtlasIcon name="movie" size={24} />
                              </div>
                            )}
                            <div className="absolute inset-0 bg-black/35" />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="w-9 h-9 rounded-full bg-black/70 border border-white/25 text-white flex items-center justify-center">
                                <AtlasIcon name="play_arrow" size={16} className="ml-0.5" />
                              </span>
                            </div>
                            <div className="absolute left-2.5 right-2.5 bottom-2 flex items-center justify-between gap-2 text-white">
                              <span className="text-xs font-medium truncate">
                                {asset.source === "youtube" ? "YouTube" : "Direct"}
                              </span>
                              <span className="text-xs bg-black/65 rounded-md px-1.5 py-0.5 shrink-0 tabular-nums">
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

              {/* Sibling Games */}
              {siblings.length > 0 && (
                <div className="flex flex-col gap-2.5 border-t border-border-subtle pt-4">
                  <h4 className="text-[13px] font-semibold text-text-main">
                    Other Titles by {publisherDisplayName} ({siblings.length})
                  </h4>
                  <div className="border border-border-subtle rounded-xl divide-y divide-border-subtle max-h-60 overflow-y-auto custom-scrollbar">
                    {siblings.slice(0, 25).map((s) => (
                      <button
                        key={s.package_name}
                        type="button"
                        onClick={() => onSelectGame && onSelectGame(s)}
                        className="w-full px-3 py-2.5 hover:bg-input-bg/60 flex items-center justify-between gap-2 text-left text-xs transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {s.icon ? (
                            <img
                              src={s.icon}
                              alt=""
                              className="w-6 h-6 rounded-md object-cover shrink-0 border border-border-subtle"
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-md bg-input-bg border border-border-subtle shrink-0" />
                          )}
                          <span className="truncate text-[13px] text-text-main font-medium">
                            {s.title}
                          </span>
                        </div>
                        <span className="font-mono text-text-muted shrink-0 text-xs tabular-nums">
                          {formatCompactNumber(s.real_installs ?? s.min_installs)} ·{" "}
                          {s.release_date ? String(s.release_date).slice(0, 10) : "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.aside>
        </div>,
        document.body
      )}

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
