import { lazy, memo, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "./lib/utils";
import PlayStoreIntelligenceView from "./PlayStoreIntelligenceView.jsx";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import AppearanceMenu from "./components/ui/AppearanceMenu.jsx";
import { Badge, KpiStrip, PageHeader } from "./components/ui/UiPrimitives.jsx";
import { getCachedCatalogue, getMemoryCatalogue, setCachedCatalogue } from "./lib/atlasCache.js";
import { AtlasFeedback } from "./AtlasFeedback.jsx";

const AmazonIntelligenceView = lazy(() => import("./AmazonIntelligenceView.jsx"));
const MarketSummaryView = lazy(() => import("./MarketSummaryView.jsx"));

// Atlas Build Marker: forces new content hash for cache busting
export const ATLAS_BUILD_REV = "2026.11.19-summary-v1";

// Authentic platform brand marks
function GooglePlayIcon({ className = "w-5 h-5" }) {
  return (
    <img
      src="/assets/playstore.png"
      alt="Google Play"
      className={cn("object-contain select-none", className)}
      loading="eager"
    />
  );
}

function AmazonAppstoreIcon({ className = "w-5 h-5" }) {
  return (
    <img
      src="/assets/amazon.png"
      alt="Amazon Appstore"
      className={cn("object-contain select-none", className)}
      loading="eager"
    />
  );
}

// NGROK URL / API base live in apiConfig.js (shared by all modules)
import { API_BASE } from "./apiConfig.js";

const AUTH_TOKEN_KEY = "atlas_auth_token";
const AUTH_USER_KEY = "atlas_auth_user";
const COUNTRY_SCAN_JOB_KEY = "atlas_country_scan_job";
const COUNTRY_SCAN_ANNOUNCED_KEY = "atlas_country_scan_announced";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COUNTRY_STATE_META = {
  live: { label: "Live", icon: "check_circle", className: "atlas-badge-success" },
  pre_register: { label: "Pre-register", icon: "event_available", className: "atlas-badge-accent" },
  early_access: { label: "Early access", icon: "science", className: "atlas-badge-warning" },
  unavailable: { label: "Unavailable", icon: "block", className: "atlas-badge-neutral" },
  unknown: { label: "Unknown", icon: "help", className: "atlas-badge-danger" }
};

function getCountryStateMeta(state) {
  return COUNTRY_STATE_META[state] || COUNTRY_STATE_META.unknown;
}

function getCountryFlag(code) {
  const normalized = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return String.fromCodePoint(...normalized.split("").map(char => 127397 + char.charCodeAt(0)));
}

function PaidBadge({ item, compact = false, showPrice = true }) {
  const isPaid = item?.is_paid === true || item?.isPaid === true;
  if (!isPaid) return null;

  const rawPriceText = item?.price_text || item?.priceText || "";
  const priceText = typeof rawPriceText === "string" && rawPriceText.trim() && rawPriceText.trim().toLowerCase() !== "free"
    ? rawPriceText.trim()
    : "";
  const label = showPrice && priceText ? `Paid · ${priceText}` : "Paid";

  return (
    <span
      className={cn(
        "atlas-badge-warning inline-flex items-center rounded-md border font-medium whitespace-nowrap",
        compact ? "gap-1 px-1.5 py-0.5 text-xs" : "gap-1.5 px-2 py-0.5 text-xs"
      )}
      title={priceText ? `Paid app · ${priceText}` : "Paid app"}
    >
      <AtlasIcon name="payments" size={compact ? 12 : 13} />
      {label}
    </span>
  );
}

function getAgeText(dateValue) {
  if (!dateValue || dateValue === "Unknown" || dateValue === 0) return null;
  const dateObj = typeof dateValue === 'number' ? new Date(dateValue) : new Date(dateValue);
  if (isNaN(dateObj.getTime())) return null;
  const diffDays = Math.floor((Date.now() - dateObj.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) return `${Math.max(1, diffDays)}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${(diffDays / 365).toFixed(1)}y`;
}

function parseInstalls(installStr) {
  if (!installStr) return 0;
  return parseInt(installStr.replace(/[^0-9]/g, '')) || 0;
}

const responseEtagCache = new Map();

// Every API request supplies the session auth token
async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const method = String(options.method || "GET").toUpperCase();
  const isGet = method === "GET" && !options.body;
  const cachedEtagEntry = isGet ? responseEtagCache.get(url) : null;

  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    "ngrok-skip-browser-warning": "true",
    ...(token ? { "x-atlas-token": token } : {}),
    ...(cachedEtagEntry?.etag ? { "If-None-Match": cachedEtagEntry.etag } : {}),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 304 && cachedEtagEntry) {
    return cachedEtagEntry.data;
  }

  if (response.status === 401) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    window.dispatchEvent(new CustomEvent("atlas:unauthorized"));
    throw new Error("Unauthorized: Please log in.");
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error("Invalid server response."); }
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  if (isGet) {
    const respEtag = response.headers.get("ETag");
    if (respEtag) {
      responseEtagCache.set(url, { etag: respEtag, data });
    }
  } else {
    responseEtagCache.clear();
  }
  return data;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function formatInstalls(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M+';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'K+';
  return num === 0 ? '0+' : num + '+';
}

function getGameIdentity(game) {
  const packageName = String(game?.package_name || "").trim();
  if (packageName) return `pkg:${packageName}`;

  if (game?.id !== undefined && game?.id !== null && game?.id !== "") {
    return `id:${game.id}`;
  }

  return `fallback:${game?.title || "untitled"}::${game?.publisher_name || "unknown"}::${game?.released || "unknown"}`;
}

function getInstallCount(game) {
  const numericMinInstalls = Number(game?.min_installs);
  if (Number.isFinite(numericMinInstalls) && numericMinInstalls > 0) return numericMinInstalls;
  return parseInstalls(game?.installs);
}

function dedupeGames(games = []) {
  const uniqueGames = new Map();

  for (const game of games) {
    const key = getGameIdentity(game);
    const existing = uniqueGames.get(key);

    if (!existing) {
      uniqueGames.set(key, game);
      continue;
    }

    const existingInstalls = getInstallCount(existing);
    const incomingInstalls = getInstallCount(game);

    uniqueGames.set(key, {
      ...existing,
      ...game,
      ad_count: Math.max(Number(existing.ad_count) || 0, Number(game.ad_count) || 0),
      historical_ad_count: Math.max(
        Number(existing.historical_ad_count ?? existing.ad_count) || 0,
        Number(game.historical_ad_count ?? game.ad_count) || 0
      ),
      min_installs: Math.max(existingInstalls, incomingInstalls),
      installs: incomingInstalls >= existingInstalls ? game.installs : existing.installs,
    });
  }

  return Array.from(uniqueGames.values());
}

// Google Play moved the release date in its ds:5 payload, so `released` (from
// google-play-scraper) is often "Unknown" while `release_date` (parsed from ds:5 by
// PlayStoreTelemetry) is correct. Always prefer release_date.
function getGameReleaseValue(game) {
  if (!game) return null;
  if (game.release_date) return game.release_date;
  if (game.released && game.released !== "Unknown") return game.released;
  return null;
}

function getGameReleaseTime(game) {
  const value = getGameReleaseValue(game);
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hasRecentGame(games) {
  if (!games || games.length === 0) return false;
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  return games.some(g => {
    let isRecentRelease = false; let isRecentUpdate = false;
    const releaseTime = getGameReleaseTime(g);
    if (releaseTime && releaseTime > sevenDaysAgo) isRecentRelease = true;
    if (g.updated && g.updated !== 0) {
      const updateTime = typeof g.updated === 'number' ? g.updated : new Date(g.updated).getTime();
      if (!isNaN(updateTime) && updateTime > sevenDaysAgo) isRecentUpdate = true;
    }
    return isRecentRelease || isRecentUpdate;
  });
}

function getCompetitorForGame(game, competitorTree) {
  if (!game) return null;
  if (game.competitor_name) return game.competitor_name;
  for (const comp of competitorTree || []) {
    for (const acc of comp.accounts || []) {
      if ((acc.games || []).some(g => g.id === game.id || g.package_name === game.package_name)) return comp.name;
    }
  }
  return null;
}

const TrendingTargets = memo(function TrendingTargets({
  sortedTrending,
  trendingSort,
  onSort,
  onGameClick,
  viewMode,
  latestScanTargetName,
}) {
  const [visibleCount, setVisibleCount] = useState(60);

  useEffect(() => {
    setVisibleCount(60);
  }, [trendingSort, viewMode]);

  const visibleSlice = useMemo(
    () => sortedTrending.slice(0, visibleCount),
    [sortedTrending, visibleCount]
  );

  const handleScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) {
      setVisibleCount((prev) => (prev < sortedTrending.length ? prev + 80 : prev));
    }
  }, [sortedTrending.length]);

  return (
    <section className="xl:col-span-7 bg-surface-solid border border-border-subtle rounded-xl flex flex-col h-[500px] md:h-[580px] overflow-hidden">
      <div className="px-4 py-3.5 border-b border-border-subtle flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AtlasIcon name="trending_up" size={17} className="text-text-muted" />
            <h2 className="text-[15px] font-semibold text-text-main tracking-tight">Trending Targets</h2>
            {viewMode === "latest" && <Badge tone="success">Latest scan</Badge>}
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            Ranked by activity across tracked advertisers
          </p>
        </div>

        <div className="flex bg-input-bg border border-border-subtle rounded-lg p-1 gap-0.5">
          {[{ id: "ads", label: "Ad push" }, { id: "installs", label: "Installs" }, { id: "newest", label: "Newest" }].map((btn) => (
            <button
              key={btn.id}
              onClick={() => onSort(btn.id)}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                trendingSort === btn.id
                  ? "bg-surface-solid text-text-main shadow-sm"
                  : "text-text-muted hover:text-text-main"
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      <div onScroll={handleScroll} className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border-subtle">
        {sortedTrending.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted p-6">
            <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center mb-3">
              <AtlasIcon name="radar" size={18} />
            </div>
            <span className="text-[13px] font-medium">
              {viewMode === "latest"
                ? (latestScanTargetName ? `No ads found for "${latestScanTargetName}".` : "No active scan.")
                : "No data yet."}
            </span>
          </div>
        ) : (
          <>
            {visibleSlice.map((game) => {
              const gameKey = getGameIdentity(game);
              return (
                <div key={gameKey} className="atlas-cv-row">
                  <button
                    type="button"
                    onClick={() => onGameClick(game)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-input-bg/50 focus-visible:bg-input-bg/50 focus-visible:outline-none transition-colors group"
                  >
                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-input-bg border border-border-subtle flex items-center justify-center flex-shrink-0 text-text-muted">
                      {game.icon ? (
                        <img loading="lazy" decoding="async" src={game.icon} alt={game.title} className="w-full h-full object-cover" />
                      ) : (
                        <AtlasIcon name="sports_esports" size={18} />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="text-[13px] font-medium text-text-main truncate">{game.title}</h3>
                        <PaidBadge item={game} compact showPrice={false} />
                        {game.is_suspended && <Badge tone="danger">Suspended</Badge>}
                      </div>
                      <p className="text-xs text-text-muted truncate mt-0.5">{game.publisher_name}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1 ml-auto flex-shrink-0">
                      {game.ad_count >= 1 && (
                        <Badge tone="accent">
                          <span className="tabular-nums">
                            {viewMode === "latest" ? `${game.ad_count} ads` : `${game.ad_count} detections`}
                          </span>
                        </Badge>
                      )}
                      <div className="flex items-center gap-2 text-xs text-text-muted tabular-nums">
                        {game.installs && game.installs !== "0+" && (
                          <span className="font-medium">{game.installs}</span>
                        )}
                        {getAgeText(getGameReleaseValue(game)) && (
                          <span>{getAgeText(getGameReleaseValue(game))}</span>
                        )}
                      </div>
                    </div>

                    <AtlasIcon name="chevron_right" size={16} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
                  </button>
                </div>
              );
            })}
            {visibleSlice.length < sortedTrending.length && (
              <div className="p-3 text-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((prev) => Math.min(sortedTrending.length, prev + 80))}
                  className="h-8 px-3.5 rounded-lg bg-surface-solid hover:bg-input-bg border border-border-subtle text-xs font-medium text-text-muted hover:text-text-main transition-colors"
                >
                  Showing {visibleSlice.length.toLocaleString()} of {sortedTrending.length.toLocaleString()} · Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});

const LiveDirectory = memo(function LiveDirectory({
  visibleCompetitorTree,
  viewMode,
  expandedNodes,
  isAdmin,
  onToggleNode,
  onGameClick,
  onNukeCompetitorData,
  onNukePublisherData,
  onDeleteGame,
  isScanning,
}) {
  const [visiblePubGames, setVisiblePubGames] = useState({});

  return (
    <section className="xl:col-span-5 bg-surface-solid border border-border-subtle rounded-xl flex flex-col h-[430px] md:h-[580px] overflow-hidden">
      <div className="px-4 py-3.5 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <AtlasIcon name="folder_open" size={17} className="text-text-muted" />
          <h2 className="text-[15px] font-semibold text-text-main tracking-tight">Live Directory</h2>
          {viewMode === "latest" && <Badge tone="success">Latest</Badge>}
        </div>
        <p className="text-xs text-text-muted mt-0.5">
          Hierarchy by competitor and publisher
        </p>
      </div>

      <div className="flex-1 p-2.5 overflow-y-auto custom-scrollbar">
        {visibleCompetitorTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted p-6">
            <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center mb-3">
              <AtlasIcon name="account_tree" size={18} />
            </div>
            <span className="text-[13px] font-medium">No directory data.</span>
          </div>
        ) : visibleCompetitorTree.map((comp, compIdx) => {
          const isCompExpanded =
            viewMode === "latest"
              ? expandedNodes[`comp_${comp.id}`] !== false
              : compIdx < 5
              ? expandedNodes[`comp_${comp.id}`] !== false
              : Boolean(expandedNodes[`comp_${comp.id}`]);
          const accCount = (comp.accounts || []).length;

          return (
            <div key={comp.id} className="mb-1 text-xs">
              <div
                className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-input-bg/60 transition-colors cursor-pointer group"
                onClick={() => onToggleNode(`comp_${comp.id}`, isCompExpanded)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AtlasIcon
                    name="expand_more"
                    size={16}
                    className="text-text-muted transition-transform"
                    style={{ transform: isCompExpanded ? "rotate(0deg)" : "rotate(-90deg)" }}
                  />
                  <div className="w-7 h-7 rounded-md bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted flex-shrink-0">
                    <AtlasIcon name="domain" size={14} />
                  </div>
                  <span className="text-[13px] font-medium text-text-main truncate">{comp.name}</span>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs px-2 py-0.5 rounded-md bg-input-bg text-text-muted font-medium tabular-nums">
                    {accCount} {accCount === 1 ? "pub" : "pubs"}
                  </span>
                  {isAdmin && (
                    <button
                      onClick={(e) => onNukeCompetitorData(e, comp.id, comp.name)}
                      className="w-7 h-7 rounded-md text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                      title="Delete all group data"
                    >
                      <AtlasIcon name="delete" size={14} />
                    </button>
                  )}
                </div>
              </div>

              {isCompExpanded && (
                <div className="ml-5 pl-3 border-l border-border-subtle space-y-0.5 py-1">
                  {comp.accounts && comp.accounts.map((acc) => {
                    const isPubExpanded =
                      viewMode === "latest"
                        ? expandedNodes[`pub_${acc.id}`] !== false
                        : Boolean(expandedNodes[`pub_${acc.id}`]);
                    const pubGames = acc.games || [];
                    const pubLimit = visiblePubGames[acc.id] || 50;
                    const shownPubGames = pubGames.slice(0, pubLimit);

                    return (
                      <div key={acc.id}>
                        <div
                          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-input-bg/60 transition-colors cursor-pointer group/pub"
                          onClick={() => onToggleNode(`pub_${acc.id}`, isPubExpanded)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <AtlasIcon
                              name="expand_more"
                              size={15}
                              className="text-text-muted transition-transform"
                              style={{ transform: isPubExpanded ? "rotate(0deg)" : "rotate(-90deg)" }}
                            />
                            <AtlasIcon name="folder" size={15} className="text-text-muted" />
                            <span className="text-text-main text-[13px] font-medium truncate">{acc.publisher_name}</span>
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-xs px-1.5 py-0.5 rounded-md bg-input-bg text-text-muted font-mono tabular-nums">
                              {pubGames.length}
                            </span>
                            {isAdmin && (
                              <button
                                onClick={(e) => onNukePublisherData(e, acc.id, acc.publisher_name)}
                                className="w-7 h-7 rounded-md text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center opacity-0 group-hover/pub:opacity-100 focus:opacity-100 transition-all"
                                title="Delete publisher data"
                              >
                                <AtlasIcon name="delete" size={14} />
                              </button>
                            )}
                          </div>
                        </div>

                        {isPubExpanded && (
                          <div className="ml-5 pl-3 border-l border-border-subtle space-y-0.5 py-1">
                            {shownPubGames.map((game) => (
                              <div
                                key={getGameIdentity(game)}
                                onClick={() => onGameClick(game)}
                                className="group/game flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-input-bg/60 cursor-pointer transition-colors"
                              >
                                <AtlasIcon name="sports_esports" size={14} className="text-text-muted" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="text-[13px] font-medium text-text-main truncate">{game.title}</div>
                                    <PaidBadge item={game} compact showPrice={false} />
                                    {game.is_suspended && <Badge tone="danger">Suspended</Badge>}
                                  </div>
                                  <div className="text-xs font-mono text-text-muted truncate">{game.package_name}</div>
                                </div>
                                {isAdmin && (
                                  <button
                                    onClick={(e) => onDeleteGame(e, game)}
                                    disabled={isScanning}
                                    className="w-7 h-7 rounded-md text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center opacity-0 group-hover/game:opacity-100 focus:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
                                    title={isScanning ? "Wait for the active scan to finish" : "Delete game from Atlas"}
                                    aria-label={`Delete ${game.title || game.package_name || "game"}`}
                                  >
                                    <AtlasIcon name="delete" size={13} />
                                  </button>
                                )}
                              </div>
                            ))}
                            {pubGames.length > shownPubGames.length && (
                              <button
                                type="button"
                                onClick={() => setVisiblePubGames((prev) => ({ ...prev, [acc.id]: pubGames.length }))}
                                className="w-full text-left px-2 py-1.5 rounded-md text-xs font-medium text-link hover:bg-input-bg transition-colors"
                              >
                                Show all {pubGames.length} games
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
});

function App() {
  console.log("[Atlas Intelligence] Active build:", ATLAS_BUILD_REV);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY)) || null; } catch { return null; }
  });
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const isAdmin = currentUser?.role === "admin";

  const [initialDashCache] = useState(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const user = localStorage.getItem(AUTH_USER_KEY);
    return token && user ? getMemoryCatalogue("atlas_dashboard_meta")?.data || null : null;
  });

  // Regular users land directly on Play Store Intelligence; Admins land on Dashboard
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const u = JSON.parse(localStorage.getItem(AUTH_USER_KEY));
      return u?.role === "admin" ? "dashboard" : "playStore";
    } catch {
      return "playStore";
    }
  }); 
  const [trendingSort, setTrendingSort] = useState("ads");
  const [stats, setStats] = useState(() => initialDashCache?.stats || { competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState(() => initialDashCache?.competitorTree || []);
  const [trending, setTrending] = useState(() => initialDashCache?.trending || []);

  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const deferredGlobalSearchQuery = useDeferredValue(globalSearchQuery);
  const [globalSearchHighlightIdx, setGlobalSearchHighlightIdx] = useState(-1);
  const [playStoreSearchQuery, setPlayStoreSearchQuery] = useState("");
  const [suspendedGames, setSuspendedGames] = useState(() => initialDashCache?.suspendedGames || []);

  const [expandedNodes, setExpandedNodes] = useState({});

  const [viewMode, setViewMode] = useState("all"); 
  const [latestScanPackages, setLatestScanPackages] = useState(() => {
    try { return JSON.parse(localStorage.getItem("atlas_latest_packages")) || []; } catch { return []; }
  });
  const [latestScanAdCounts, setLatestScanAdCounts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("atlas_latest_ad_counts")) || {}; } catch { return {}; }
  });
  const [latestScanAdCountsByCompetitor, setLatestScanAdCountsByCompetitor] = useState(() => {
    try { return JSON.parse(localStorage.getItem("atlas_latest_ad_counts_by_competitor")) || {}; } catch { return {}; }
  });
  const [latestScanTargetName, setLatestScanTargetName] = useState(() => localStorage.getItem("atlas_latest_target_name") || "");
  const [latestScanCompId, setLatestScanCompId] = useState(() => localStorage.getItem("atlas_latest_comp_id") || null);
  const [hasLatestScan, setHasLatestScan] = useState(() => localStorage.getItem("atlas_has_latest_scan") === "1");

  const [settings, setSettings] = useState({ default_report_email: "", report_subject_template: "", report_notes: "", google_sheet_id: "" });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");

  const [isScanning, setIsScanning] = useState(false);
  const [isStartingScan, setIsStartingScan] = useState(false);
  const [isSyncingDashboard, setIsSyncingDashboard] = useState(false);
  const [isScanMinimized, setIsScanMinimized] = useState(false);
  const [savingCompetitor, setSavingCompetitor] = useState(false);
  const [savingList, setSavingList] = useState(false);
  const [savingRecipient, setSavingRecipient] = useState(false);
  const [deletingTargetKey, setDeletingTargetKey] = useState(null);
  const [viewingCountryPkg, setViewingCountryPkg] = useState(null);
  const [isMaxAds, setIsMaxAds] = useState(false); 
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [sourceSearch, setSourceSearch] = useState("");
  
  const [lastScanTime, setLastScanTime] = useState(() => localStorage.getItem("atlas_last_scan_time") || "Never");
  const [scanQuery, setScanQuery] = useState("");
  const [scanLimit, setScanLimit] = useState(20);
  const [selectedSource, setSelectedSource] = useState("manual"); 
  const [selectedEmailList, setSelectedEmailList] = useState("none");
  const [customReportEmail, setCustomReportEmail] = useState("");

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);

  const [countryPackage, setCountryPackage] = useState("");
  const [countryScanData, setCountryScanData] = useState(null);
  const [countryScanJob, setCountryScanJob] = useState(null);
  const [countryScanError, setCountryScanError] = useState("");
  const [countryScanModalOpen, setCountryScanModalOpen] = useState(false);
  const [countryScanLoading, setCountryScanLoading] = useState(false);
  const [isCountryScanMinimized, setIsCountryScanMinimized] = useState(false);
  const [countryScanFilter, setCountryScanFilter] = useState("all");
  const [countryScanSearch, setCountryScanSearch] = useState("");
  const deferredCountryScanSearch = useDeferredValue(countryScanSearch);
  const [countryScanViewTab, setCountryScanViewTab] = useState("availability");
  const [countryPerformanceSort, setCountryPerformanceSort] = useState("atlas_desc");
  const [selectedGameCountryScan, setSelectedGameCountryScan] = useState(null);
  const [selectedGameCountryLoading, setSelectedGameCountryLoading] = useState(false);
  const [selectedGameVideos, setSelectedGameVideos] = useState([]);
  const [selectedGameVideosLoading, setSelectedGameVideosLoading] = useState(false);
  const [countryScanLibrary, setCountryScanLibrary] = useState(() => initialDashCache?.countryScanLibrary || []);
  const [countryLibrarySearch, setCountryLibrarySearch] = useState("");
  const deferredCountryLibrarySearch = useDeferredValue(countryLibrarySearch);

  const [activeStatPanel, setActiveStatPanel] = useState(null);
  const [statPanelSearch, setStatPanelSearch] = useState("");
  const deferredStatPanelSearch = useDeferredValue(statPanelSearch);
  const [scanProgress, setScanProgress] = useState({
    target: "",
    currentAd: 0,
    totalAds: 500,
    targetUniqueGames: 0,
    uniqueGamesFound: 0,
    adsInspected: 0,
    discoveredCreatives: 0,
    duplicateAds: 0,
    adsWithoutPackages: 0,
    maxAdsToInspect: 500,
    scanStopReason: null,
    timeRemaining: "Calculating...",
    logs: []
  });
  const countryScanDetailCacheRef = useRef(new Map());
  // Scan IDs whose completion popup has already been shown. Persisted so the popup
  // never re-opens on its own after the user closes it (navigation, drawer, reload).
  const announcedCountryScanIdsRef = useRef(null);
  if (announcedCountryScanIdsRef.current === null) {
    let initial = [];
    try { initial = JSON.parse(localStorage.getItem(COUNTRY_SCAN_ANNOUNCED_KEY) || "[]"); } catch {}
    announcedCountryScanIdsRef.current = new Set(Array.isArray(initial) ? initial.map(String) : []);
  }
  const markCountryScanAnnounced = useCallback((scanId) => {
    if (!scanId) return;
    const set = announcedCountryScanIdsRef.current;
    set.add(String(scanId));
    try { localStorage.setItem(COUNTRY_SCAN_ANNOUNCED_KEY, JSON.stringify([...set].slice(-50))); } catch {}
  }, []);
  const selectedGamePackageRef = useRef(null);
  const selectedGameVideosCacheRef = useRef(new Map());
  const telemetryCacheRef = useRef(new Map());
  const [telemetryRefreshingPkg, setTelemetryRefreshingPkg] = useState(null);
  const lastHandledTerminalRef = useRef(null);
  const lastAppliedTerminalSnapshotRef = useRef(null);
  const scanLaunchPendingRef = useRef(false);

  const [targetLists, setTargetLists] = useState(() => initialDashCache?.targetLists || []);
  const [savedCompetitors, setSavedCompetitors] = useState(() => initialDashCache?.savedCompetitors || []);
  const [emailLists, setEmailLists] = useState(() => initialDashCache?.emailLists || []); 
  
  const [newListName, setNewListName] = useState("");
  const [newListTargets, setNewListTargets] = useState("");
  const [newCompName, setNewCompName] = useState("");
  const [newCompAdsId, setNewCompAdsId] = useState("");
  const [newEmailName, setNewEmailName] = useState(""); 
  const [newEmailTargets, setNewEmailTargets] = useState(""); 

  const [isNodeOnline, setIsNodeOnline] = useState(true);

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("atlas_theme");
    if (saved === "light" || saved === "light-warm") return "light-warm";
    if (saved === "light-crisp") return "light-crisp";
    return "dark";
  });
  const [accent, setAccent] = useState(() => (localStorage.getItem("atlas_accent") === "mono" ? "mono" : "cobalt"));
  const [sidebarPinned, setSidebarPinned] = useState(() => localStorage.getItem("atlas_sidebar_pinned") === "true");
  const [sidebarHovered, setSidebarHovered] = useState(false);

  const toggleSidebarPin = useCallback(() => {
    setSidebarPinned((prev) => {
      const next = !prev;
      try { localStorage.setItem("atlas_sidebar_pinned", next ? "true" : "false"); } catch {}
      return next;
    });
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    setAuthToken(null);
    setCurrentUser(null);
    setActiveTab("dashboard");
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      handleLogout();
      setLoginError("Session expired. Please log in again.");
    };
    window.addEventListener("atlas:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("atlas:unauthorized", handleUnauthorized);
  }, [handleLogout]);

  useEffect(() => {
    const closeDropdowns = () => {
      setActiveDropdown(null);
      setSourceSearch("");
    };
    document.addEventListener("click", closeDropdowns);
    return () => document.removeEventListener("click", closeDropdowns);
  }, []);

  const applyAppearance = useCallback((nextTheme, nextAccent) => {
    const resolvedTheme =
      nextTheme === "light" || nextTheme === "light-warm"
        ? "light-warm"
        : nextTheme === "light-crisp"
        ? "light-crisp"
        : "dark";
    const resolvedAccent = nextAccent === "mono" ? "mono" : "cobalt";
    const root = window.document.documentElement;
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const applyThemeDom = () => {
      root.dataset.theme = resolvedTheme;
      root.dataset.accent = resolvedAccent;
      if (resolvedTheme === "dark") root.classList.add("dark");
      else root.classList.remove("dark");
      try {
        localStorage.setItem("atlas_theme", resolvedTheme);
        localStorage.setItem("atlas_accent", resolvedAccent);
      } catch {}
    };

    const commitState = () => {
      startTransition(() => {
        setTheme(resolvedTheme);
        setAccent(resolvedAccent);
      });
    };

    if (prefersReducedMotion) {
      applyThemeDom();
      commitState();
      return;
    }

    if (typeof document.startViewTransition === "function") {
      try {
        root.classList.add("atlas-vt-switching");
        const vt = document.startViewTransition(() => {
          applyThemeDom();
        });
        const cleanup = () => {
          root.classList.remove("atlas-vt-switching");
        };
        if (vt?.ready && typeof vt.ready.then === "function") {
          vt.ready.then(cleanup, cleanup);
        } else {
          window.requestAnimationFrame(cleanup);
        }
        commitState();
        return;
      } catch {
        root.classList.remove("atlas-vt-switching");
      }
    }

    root.classList.add("atlas-theme-transition");
    applyThemeDom();
    commitState();
    window.setTimeout(() => {
      root.classList.remove("atlas-theme-transition");
    }, 220);
  }, []);

  // Preload heavy lazy-split views on idle so switching to Amazon feels instant
  useEffect(() => {
    if (!authToken || !currentUser) return undefined;
    const timer = window.setTimeout(() => {
      void import("./AmazonIntelligenceView.jsx");
    }, 600);
    return () => window.clearTimeout(timer);
  }, [authToken, currentUser]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.theme = theme;
    root.dataset.accent = accent;
    if (theme === "dark" && !root.classList.contains("dark")) {
      root.classList.add("dark");
    } else if (theme !== "dark" && root.classList.contains("dark")) {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("atlas_theme", theme);
      localStorage.setItem("atlas_accent", accent);
    } catch {}
  }, [theme, accent]);

  useEffect(() => {
    if (!activeStatPanel) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setActiveStatPanel(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeStatPanel]);

  const hasFreshDashLoadRef = useRef(false);

  // Parallel data load with a single batched React state commit on settle
  const loadAllData = useCallback(async () => {
    if (!authToken || !currentUser) return;
    setIsSyncingDashboard(true);
    const freshData = {};
    let nextEmails = null;
    let nextSettings = null;
    let statsFulfilled = false;

    const requests = [
      fetchJson(`${API_BASE}/api/stats`).then(data => {
        statsFulfilled = true;
        freshData.stats = data?.error ? { competitors: 0, accounts: 0, games: 0 } : data;
      }),
      fetchJson(`${API_BASE}/api/competitors`).then(data => {
        const val = Array.isArray(data) ? data : [];
        const realCompetitorTree = val.filter(comp => !comp.is_unassigned);
        freshData.competitorTree = realCompetitorTree;

        const seenGames = new Map();
        for (const comp of val) {
          for (const acc of comp.accounts || []) {
            for (const g of acc.games || []) {
              const key = g.id || g.package_name;
              if (!seenGames.has(key)) {
                seenGames.set(key, {
                  ...g,
                  publisher_name: g.publisher_name || (acc.is_unassigned ? null : acc.publisher_name),
                  competitor_id: g.competitor_id ?? (comp.is_unassigned ? null : comp.id),
                  competitor_name: g.competitor_name || (comp.is_unassigned ? null : comp.name)
                });
              }
            }
          }
        }
        const derivedTrending = [...seenGames.values()].sort(
          (a, b) => (Number(b.ad_count) || 0) - (Number(a.ad_count) || 0)
        );
        freshData.trending = derivedTrending;
      }),
      fetchJson(`${API_BASE}/api/lists`).then(data => {
        freshData.targetLists = Array.isArray(data) ? data : [];
      }),
      fetchJson(`${API_BASE}/api/saved-competitors`).then(data => {
        freshData.savedCompetitors = Array.isArray(data) ? data : [];
      }),
      fetchJson(`${API_BASE}/api/settings`).then(data => {
        if (data && !data.error) nextSettings = data;
      }),
      fetchJson(`${API_BASE}/api/country-scans`).then(data => {
        freshData.countryScanLibrary = Array.isArray(data) ? data : [];
      }),
      fetchJson(`${API_BASE}/api/suspended-games`).then(data => {
        freshData.suspendedGames = Array.isArray(data) ? data : [];
      }),
    ];
    try {
      const results = await Promise.allSettled(requests);
      const anyFulfilled = results.some(result => result.status === "fulfilled");
      results.filter(result => result.status === "rejected").forEach(result => console.error("Atlas data load failed:", result.reason));

      if (anyFulfilled) {
        hasFreshDashLoadRef.current = true;
        setIsNodeOnline(true);
        if (freshData.stats) setStats(freshData.stats);
        if (freshData.competitorTree) setCompetitorTree(freshData.competitorTree);
        if (freshData.trending) setTrending(freshData.trending);
        if (freshData.targetLists) setTargetLists(freshData.targetLists);
        if (freshData.savedCompetitors) setSavedCompetitors(freshData.savedCompetitors);
        if (nextEmails) setEmailLists(nextEmails);
        if (nextSettings) setSettings(prev => ({ ...prev, ...nextSettings }));
        if (freshData.countryScanLibrary) setCountryScanLibrary(freshData.countryScanLibrary);
        if (freshData.suspendedGames) setSuspendedGames(freshData.suspendedGames);
        void setCachedCatalogue("atlas_dashboard_meta", freshData);
      } else if (!statsFulfilled) {
        setIsNodeOnline(false);
      }
    } finally {
      setIsSyncingDashboard(false);
    }
  }, [authToken, currentUser]);

  // 0ms instant startup from local L1 memory / IndexedDB cache
  useEffect(() => {
    if (!authToken || !currentUser || initialDashCache) return;
    let cancelled = false;
    getCachedCatalogue("atlas_dashboard_meta").then((cached) => {
      if (cancelled || hasFreshDashLoadRef.current || !cached?.data) return;
      if (cached.data.stats) setStats(cached.data.stats);
      if (cached.data.competitorTree) setCompetitorTree(cached.data.competitorTree);
      if (cached.data.trending) setTrending(cached.data.trending);
      if (cached.data.targetLists) setTargetLists(cached.data.targetLists);
      if (cached.data.savedCompetitors) setSavedCompetitors(cached.data.savedCompetitors);
      if (cached.data.emailLists) setEmailLists(cached.data.emailLists);
      if (cached.data.countryScanLibrary) setCountryScanLibrary(cached.data.countryScanLibrary);
      if (cached.data.suspendedGames) setSuspendedGames(cached.data.suspendedGames);
    });
    return () => { cancelled = true; };
  }, [authToken, currentUser, initialDashCache]);

  useEffect(() => {
    if (authToken && currentUser) {
      loadAllData();
    }
  }, [authToken, currentUser, loadAllData]);

  const applyScanStatus = useCallback((status) => {
    if (!status || typeof status !== "object") return;

    const state = status.state || (status.running ? "running" : "idle");

    if (state === "idle") {
      if (!scanLaunchPendingRef.current) {
        setIsScanning(false);
      }
      return;
    }

    // A finished scan's status is retained by the server until the next scan,
    // so polling keeps returning the identical snapshot. Re-applying it would
    // create new state objects and re-render the whole app every poll. The
    // server bumps updatedAt on any real change (e.g. a package removal), so
    // changed snapshots still go through.
    const isActiveState = Boolean(status.running) || state === "starting" || state === "running" || state === "cancelling";
    if (!isActiveState && status.updatedAt) {
      const snapshotKey = `${status.scanId || "scan"}:${state}:${status.updatedAt}`;
      if (lastAppliedTerminalSnapshotRef.current === snapshotKey) {
        setIsScanning(false);
        return;
      }
      lastAppliedTerminalSnapshotRef.current = snapshotKey;
    }

    setScanProgress(prev => ({
      ...prev,
      target: status.target || prev.target,
      targetIndex: status.targetIndex ?? prev.targetIndex,
      totalTargets: status.totalTargets ?? prev.totalTargets,
      currentAd: status.currentAd ?? prev.currentAd,
      totalAds: status.totalAds ?? prev.totalAds,
      targetUniqueGames: status.targetUniqueGames ?? prev.targetUniqueGames,
      uniqueGamesFound: status.uniqueGamesFound ?? prev.uniqueGamesFound,
      adsInspected: status.adsInspected ?? prev.adsInspected,
      discoveredCreatives: status.discoveredCreatives ?? prev.discoveredCreatives,
      duplicateAds: status.duplicateAds ?? prev.duplicateAds,
      adsWithoutPackages: status.adsWithoutPackages ?? prev.adsWithoutPackages,
      maxAdsToInspect: status.maxAdsToInspect ?? prev.maxAdsToInspect,
      scanStopReason: status.scanStopReason ?? prev.scanStopReason,
      timeRemaining: status.timeRemaining || prev.timeRemaining,
      logs: Array.isArray(status.logs) ? status.logs.slice(-5) : prev.logs
    }));

    if (status.adCounts && typeof status.adCounts === "object") {
      setLatestScanAdCounts(status.adCounts);
      localStorage.setItem("atlas_latest_ad_counts", JSON.stringify(status.adCounts));
    }

    if (status.adCountsByCompetitor && typeof status.adCountsByCompetitor === "object") {
      setLatestScanAdCountsByCompetitor(status.adCountsByCompetitor);
      localStorage.setItem("atlas_latest_ad_counts_by_competitor", JSON.stringify(status.adCountsByCompetitor));
    }

    if (status.running || state === "starting" || state === "running" || state === "cancelling") {
      setIsScanning(true);
      return;
    }

    const terminalKey = `${status.scanId || "scan"}:${state}:${status.finishedAt || status.updatedAt || ""}`;
    const isNewTerminalState = lastHandledTerminalRef.current !== terminalKey;

    if (state === "complete" || status.isComplete) {
      const completedPackages = Array.isArray(status.packages)
        ? [...new Set(status.packages
            .filter(pkg => typeof pkg === "string")
            .map(pkg => pkg.trim().toLowerCase())
            .filter(Boolean))]
        : [];
      const completedAdCounts = status.adCounts && typeof status.adCounts === "object"
        ? status.adCounts
        : {};
      const completedAdCountsByCompetitor = status.adCountsByCompetitor && typeof status.adCountsByCompetitor === "object"
        ? status.adCountsByCompetitor
        : {};

      // Always replace the previous snapshot, even when this scan found zero
      // packages or the server omitted a result field.
      setLatestScanPackages(completedPackages);
      localStorage.setItem("atlas_latest_packages", JSON.stringify(completedPackages));
      setLatestScanAdCounts(completedAdCounts);
      localStorage.setItem("atlas_latest_ad_counts", JSON.stringify(completedAdCounts));
      setLatestScanAdCountsByCompetitor(completedAdCountsByCompetitor);
      localStorage.setItem("atlas_latest_ad_counts_by_competitor", JSON.stringify(completedAdCountsByCompetitor));

      if (status.competitorId) {
        setLatestScanCompId(status.competitorId);
        localStorage.setItem("atlas_latest_comp_id", status.competitorId.toString());
      }

      setHasLatestScan(true);
      localStorage.setItem("atlas_has_latest_scan", "1");

      if (isNewTerminalState) {
        const finishedDate = status.finishedAt ? new Date(status.finishedAt) : new Date();
        const displayTime = finishedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setLastScanTime(displayTime);
        localStorage.setItem("atlas_last_scan_time", displayTime);
        lastHandledTerminalRef.current = terminalKey;
        selectedGameVideosCacheRef.current.clear();
        void loadAllData();
      }

      setIsScanning(false);
      return;
    }

    if (state === "cancelled" || status.isCancelled || state === "error" || status.isError || status.fatalError) {
      if (isNewTerminalState) {
        lastHandledTerminalRef.current = terminalKey;
        selectedGameVideosCacheRef.current.clear();
        void loadAllData();
      }

      setIsScanning(false);
    }
  }, [loadAllData]);

  const applyScanStatusRef = useRef(applyScanStatus);
  useEffect(() => {
    applyScanStatusRef.current = applyScanStatus;
  }, [applyScanStatus]);

  const isScanningRef = useRef(isScanning);
  useEffect(() => {
    isScanningRef.current = isScanning;
  }, [isScanning]);

  // Adaptive scan polling: 1.5s while scanning, 20s while idle, paused when tab is hidden, backoff on offline/502
  useEffect(() => {
    if (!authToken || !currentUser) return;

    let disposed = false;
    let requestInFlight = false;
    let timerId = null;
    let consecutiveErrors = 0;

    const pollScanStatus = async () => {
      if (disposed) return;
      if (document.hidden && !isScanningRef.current && !scanLaunchPendingRef.current) {
        return;
      }
      if (requestInFlight) return;
      requestInFlight = true;

      let nextInterval = isScanningRef.current || scanLaunchPendingRef.current ? 1500 : 20000;

      try {
        const status = await fetchJson(`${API_BASE}/api/scan-status`);
        if (!disposed) {
          consecutiveErrors = 0;
          setIsNodeOnline(true);
          applyScanStatusRef.current(status);
          const active = status?.running || ["starting", "running", "cancelling"].includes(status?.state);
          nextInterval = active || scanLaunchPendingRef.current ? 1500 : 20000;
        }
      } catch (err) {
        consecutiveErrors += 1;
        setIsNodeOnline(false);
        nextInterval = Math.min(60000, 15000 * Math.pow(2, Math.max(0, consecutiveErrors - 1)));
        if (!disposed && err?.message && !err.message.includes("Unauthorized")) {
          console.warn("Scan status poll failed:", err.message);
        }
      } finally {
        requestInFlight = false;
        if (!disposed && !(document.hidden && !isScanningRef.current && !scanLaunchPendingRef.current)) {
          timerId = window.setTimeout(pollScanStatus, nextInterval);
        }
      }
    };

    const handleVisibility = () => {
      if (!document.hidden && !disposed) {
        if (timerId) window.clearTimeout(timerId);
        void pollScanStatus();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    void pollScanStatus();

    return () => {
      disposed = true;
      if (timerId) window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [authToken, currentUser]);

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    if (isLoggingIn) return;
    const user = usernameInput.trim();
    const pass = passwordInput.trim();
    if (!user || !pass) {
      setLoginError("Please enter both username and password.");
      return;
    }

    setIsLoggingIn(true);
    try {
      setLoginError("");
      const res = await fetchJson(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass })
      });

      localStorage.setItem(AUTH_TOKEN_KEY, res.token);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(res.user));
      setAuthToken(res.token);
      setCurrentUser(res.user);
      setActiveTab(res.user?.role === "admin" ? "dashboard" : "playStore");
      setUsernameInput("");
      setPasswordInput("");
    } catch (err) {
      setLoginError(err.message || "Invalid credentials.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const toggleNode = useCallback((nodeId, currentExpanded) => {
    setExpandedNodes(prev => ({
      ...prev,
      [nodeId]: typeof currentExpanded === "boolean" ? !currentExpanded : !prev[nodeId]
    }));
  }, []);

  const handleNukeCompetitorData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (!isAdmin) return;
    const confirmed = await AtlasFeedback.confirm(
      `Permanently delete all data for ${name}, including associated games and publishers?`,
      { title: "Delete Competitor?", confirmLabel: "Delete", destructive: true }
    );
    if (!confirmed) return;

    const prevTree = competitorTree;
    const prevSaved = savedCompetitors;
    const prevTrending = trending;
    setCompetitorTree(prev => prev.filter(comp => String(comp.id) !== String(id)));
    setSavedCompetitors(prev => prev.filter(comp => String(comp.id) !== String(id)));
    setTrending(prev => prev.filter(game => String(game.competitor_id) !== String(id)));
    try {
      await fetchJson(`${API_BASE}/api/competitors/${id}/data`, { method: "DELETE" });
      AtlasFeedback.toast(`Deleted data for ${name}.`, { tone: "success" });
      void loadAllData();
    } catch (err) {
      setCompetitorTree(prevTree);
      setSavedCompetitors(prevSaved);
      setTrending(prevTrending);
      AtlasFeedback.toast(err?.message || `Failed to delete ${name}.`, { tone: "danger" });
      void loadAllData();
    }
  }, [isAdmin, competitorTree, savedCompetitors, trending, loadAllData]);

  const handleNukePublisherData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (!isAdmin) return;
    const confirmed = await AtlasFeedback.confirm(
      `Permanently delete all data for publisher ${name}?`,
      { title: "Delete Publisher?", confirmLabel: "Delete", destructive: true }
    );
    if (!confirmed) return;

    const prevTree = competitorTree;
    const prevTrending = trending;
    setCompetitorTree(prev => prev.map(comp => ({
      ...comp,
      accounts: (comp.accounts || []).filter(acc => String(acc.id) !== String(id))
    })));
    setTrending(prev => prev.filter(game => game.publisher_name !== name));
    try {
      await fetchJson(`${API_BASE}/api/publishers/${id}/data`, { method: "DELETE" });
      AtlasFeedback.toast(`Deleted publisher ${name}.`, { tone: "success" });
      void loadAllData();
    } catch (err) {
      setCompetitorTree(prevTree);
      setTrending(prevTrending);
      AtlasFeedback.toast(err?.message || `Failed to delete ${name}.`, { tone: "danger" });
      void loadAllData();
    }
  }, [isAdmin, competitorTree, trending, loadAllData]);

  const handleDeleteGame = useCallback(async (e, game) => {
    e?.stopPropagation?.();
    if (!isAdmin || !game?.id) return;

    if (isScanning) {
      await AtlasFeedback.inform("Wait for the active scan to finish before deleting a game.", { title: "Scan in progress" });
      return;
    }

    const gameLabel = game.title || game.package_name || "this game";
    const confirmed = await AtlasFeedback.confirm(
      `Permanently delete ${gameLabel} from Atlas? Removes game, publisher links, and ad history.`,
      { title: "Delete Game?", confirmLabel: "Delete", destructive: true }
    );
    if (!confirmed) return;

    const packageName = game.package_name;
    const prevTrending = trending;
    const prevTree = competitorTree;
    const prevSelected = selectedGame;

    // Optimistic state update with rollback on error
    setTrending(prev => prev.filter(item => item.id !== game.id && (!packageName || item.package_name !== packageName)));
    setCompetitorTree(prev => prev.map(comp => ({
      ...comp,
      accounts: (comp.accounts || []).map(acc => ({
        ...acc,
        games: (acc.games || []).filter(g => g.id !== game.id && (!packageName || g.package_name !== packageName))
      }))
    })));
    setSelectedGame(prev => {
      const sameGame = prev && (prev.id === game.id || (packageName && prev.package_name === packageName));
      if (sameGame) {
        setIsDrawerOpen(false);
        return null;
      }
      return prev;
    });

    try {
      const deleted = await fetchJson(`${API_BASE}/api/games/${game.id}/data`, { method: "DELETE" });
      const resolvedPkg = deleted?.package_name || packageName;

      if (resolvedPkg) {
        selectedGameVideosCacheRef.current.delete(resolvedPkg);
        setLatestScanPackages(prev => {
          const next = (prev || []).filter(pkg => pkg !== resolvedPkg);
          localStorage.setItem("atlas_latest_packages", JSON.stringify(next));
          return next;
        });

        setLatestScanAdCounts(prev => {
          const next = { ...(prev || {}) };
          delete next[resolvedPkg];
          localStorage.setItem("atlas_latest_ad_counts", JSON.stringify(next));
          return next;
        });

        setLatestScanAdCountsByCompetitor(prev => {
          const next = {};
          for (const [competitorId, counts] of Object.entries(prev || {})) {
            const nextCounts = { ...(counts || {}) };
            delete nextCounts[resolvedPkg];
            if (Object.keys(nextCounts).length > 0) next[competitorId] = nextCounts;
          }
          localStorage.setItem("atlas_latest_ad_counts_by_competitor", JSON.stringify(next));
          return next;
        });
      }

      AtlasFeedback.toast(`Deleted ${gameLabel}.`, { tone: "success" });
      void loadAllData();
    } catch (err) {
      setTrending(prevTrending);
      setCompetitorTree(prevTree);
      if (prevSelected) setSelectedGame(prevSelected);
      AtlasFeedback.toast(err?.message || "Failed to delete game.", { tone: "danger" });
      void loadAllData();
    }
  }, [isAdmin, isScanning, trending, competitorTree, selectedGame, loadAllData]);

  const handleSetGameSuspended = useCallback(async (game, suspended, event) => {
    event?.stopPropagation?.();
    if (!isAdmin || !game?.id) return;

    const label = game.title || game.package_name || "this game";
    const message = suspended
      ? `Mark ${label} as suspended? Atlas preserves its stats, assets, and latest country status.`
      : `Restore ${label} from the Suspended tab?`;

    const confirmed = await AtlasFeedback.confirm(message, {
      title: suspended ? "Mark as Suspended?" : "Restore Game?",
      confirmLabel: suspended ? "Suspend" : "Restore",
      destructive: suspended
    });
    if (!confirmed) return;

    const prevTrending = trending;
    const prevTree = competitorTree;
    const prevSuspended = suspendedGames;
    const prevSelected = selectedGame;

    // Optimistic state update with rollback
    setTrending(prev => prev.map(item => item.id === game.id ? { ...item, is_suspended: suspended } : item));
    setCompetitorTree(prev => prev.map(comp => ({
      ...comp,
      accounts: (comp.accounts || []).map(acc => ({
        ...acc,
        games: (acc.games || []).map(g => g.id === game.id ? { ...g, is_suspended: suspended } : g)
      }))
    })));
    if (!suspended) {
      setSuspendedGames(prev => prev.filter(item => Number(item.gameId) !== Number(game.id) && item.packageName !== game.package_name));
    }

    if (selectedGame && selectedGame.id === game.id) {
      setIsDrawerOpen(false);
      setSelectedGame(null);
    }

    try {
      await fetchJson(`${API_BASE}/api/games/${game.id}/suspended`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended })
      });
      AtlasFeedback.toast(suspended ? `${label} marked as suspended.` : `Restored ${label}.`, { tone: "success" });
      void loadAllData();
    } catch (error) {
      setTrending(prevTrending);
      setCompetitorTree(prevTree);
      setSuspendedGames(prevSuspended);
      if (prevSelected) setSelectedGame(prevSelected);
      AtlasFeedback.toast(error?.message || "Unable to update suspension state.", { tone: "danger" });
      void loadAllData();
    }
  }, [isAdmin, loadAllData, selectedGame, trending, competitorTree, suspendedGames]);

  const handleRestoreSuspendedGame = useCallback(async (item, event) => {
    event?.stopPropagation?.();
    const game = item?.game || {};
    const gameId = item?.gameId || game.id;
    if (!gameId) {
      void AtlasFeedback.inform("This archived suspension no longer has a live Atlas game record to restore.", { title: "Cannot restore" });
      return;
    }
    await handleSetGameSuspended({
      ...game,
      id: gameId,
      title: item.appTitle || game.title,
      package_name: item.packageName || game.package_name
    }, false, event);
  }, [handleSetGameSuspended]);

  const getLatestScanAdCount = useCallback((game) => {
    if (!game?.package_name) return 0;

    const competitorKey = game.competitor_id !== undefined && game.competitor_id !== null
      ? String(game.competitor_id)
      : null;

    if (competitorKey) {
      const competitorCounts = latestScanAdCountsByCompetitor?.[competitorKey];
      if (competitorCounts && competitorCounts[game.package_name] !== undefined) {
        return Number(competitorCounts[game.package_name]) || 0;
      }
    }

    return Number(latestScanAdCounts?.[game.package_name]) || 0;
  }, [latestScanAdCounts, latestScanAdCountsByCompetitor]);

  const withLatestScanAdCount = useCallback((game) => {
    if (viewMode !== "latest") return game;

    return {
      ...game,
      historical_ad_count: game.ad_count,
      ad_count: getLatestScanAdCount(game)
    };
  }, [viewMode, getLatestScanAdCount]);

  const isFromLatestScan = (game) => {
    if (viewMode === "all") return true;
    if (!hasLatestScan || !game?.package_name) return false;

    const packageName = String(game.package_name).trim().toLowerCase();
    const competitorKey = game?.competitor_id !== undefined && game?.competitor_id !== null
      ? String(game.competitor_id)
      : null;
    const countsByCompetitor = latestScanAdCountsByCompetitor || {};
    const hasCompetitorCounts = Object.keys(countsByCompetitor).length > 0;

    // When the scan returned per-competitor counts, use them to avoid showing
    // a historical game just because its package also exists elsewhere.
    if (competitorKey && Object.prototype.hasOwnProperty.call(countsByCompetitor, competitorKey)) {
      const competitorCounts = countsByCompetitor[competitorKey] || {};
      return Number(competitorCounts[packageName]) > 0;
    }

    if (competitorKey && hasCompetitorCounts) return false;

    // The completed scan's package list is authoritative, including an empty
    // list. Never fall back to the database's historical competitor tree.
    return Array.isArray(latestScanPackages) && latestScanPackages.some(
      pkg => typeof pkg === "string" && pkg.trim().toLowerCase() === packageName
    );
  };

  const visibleTrending = useMemo(() => {
    const visibleGames = trending
      .filter(isFromLatestScan)
      .map(withLatestScanAdCount);

    return dedupeGames(visibleGames);
  }, [trending, viewMode, hasLatestScan, latestScanPackages, latestScanCompId, latestScanTargetName, latestScanAdCountsByCompetitor, withLatestScanAdCount]);

  const visibleCompetitorTree = useMemo(() => {
    return competitorTree.map(comp => {
      if (viewMode === "all") return comp;

      const visibleAccounts = (comp.accounts || []).map(acc => {
        const taggedGames = (acc.games || []).map(game => ({
          ...game,
          competitor_id: comp.id,
          competitor_name: comp.name
        }));

        const visibleGames = taggedGames
          .filter(isFromLatestScan)
          .map(withLatestScanAdCount);

        return { ...acc, games: visibleGames };
      }).filter(acc => acc.games.length > 0);

      return { ...comp, accounts: visibleAccounts };
    }).filter(comp => viewMode === "all" || comp.accounts.length > 0);
  }, [competitorTree, viewMode, hasLatestScan, latestScanPackages, latestScanAdCountsByCompetitor, withLatestScanAdCount]);

  const displayStats = useMemo(() => {
    return viewMode === "all" ? stats : {
      competitors: visibleCompetitorTree.length,
      accounts: visibleCompetitorTree.reduce((sum, comp) => sum + (comp.accounts?.length || 0), 0),
      games: visibleTrending.length
    };
  }, [stats, viewMode, visibleCompetitorTree, visibleTrending]);

  const statCompetitors = useMemo(() => {
    if (activeStatPanel !== "competitors") return [];
    return visibleCompetitorTree.map((comp) => {
      const accounts = comp.accounts || [];
      const games = accounts.flatMap((acc) => acc.games || []);

      return {
        ...comp,
        publisherCount: accounts.length,
        gameCount: games.length,
        totalInstalls: games.reduce((sum, game) => sum + getInstallCount(game), 0),
      };
    }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [activeStatPanel, visibleCompetitorTree]);

  const statPublishers = useMemo(() => {
    if (activeStatPanel !== "publishers") return [];
    const publishers = [];

    visibleCompetitorTree.forEach((comp) => {
      (comp.accounts || []).forEach((account) => {
        const games = account.games || [];
        publishers.push({
          ...account,
          competitorName: comp.name,
          competitorId: comp.id,
          totalGames: games.length,
          totalInstalls: games.reduce((sum, game) => sum + getInstallCount(game), 0),
        });
      });
    });

    return publishers.sort((a, b) => (a.publisher_name || "").localeCompare(b.publisher_name || ""));
  }, [activeStatPanel, visibleCompetitorTree]);

  const statGames = useMemo(() => {
    if (activeStatPanel !== "games") return [];
    return [...visibleTrending].sort((a, b) =>
      (a.title || "").localeCompare(b.title || "")
    );
  }, [activeStatPanel, visibleTrending]);

  const filteredStatItems = useMemo(() => {
    if (!activeStatPanel) return [];

    const query = deferredStatPanelSearch.trim().toLowerCase();
    let items = [];

    if (activeStatPanel === "competitors") items = statCompetitors;
    if (activeStatPanel === "publishers") items = statPublishers;
    if (activeStatPanel === "games") items = statGames;

    if (!query) return items;

    return items.filter((item) => {
      if (activeStatPanel === "competitors") {
        return (item.name || "").toLowerCase().includes(query) ||
          (item.ads_id || "").toLowerCase().includes(query);
      }

      if (activeStatPanel === "publishers") {
        return (item.publisher_name || "").toLowerCase().includes(query) ||
          (item.competitorName || "").toLowerCase().includes(query);
      }

      return (item.title || "").toLowerCase().includes(query) ||
        (item.publisher_name || "").toLowerCase().includes(query) ||
        (item.package_name || "").toLowerCase().includes(query);
    });
  }, [activeStatPanel, deferredStatPanelSearch, statCompetitors, statPublishers, statGames]);

  const globalSearchResults = useMemo(() => {
    const query = deferredGlobalSearchQuery.trim().toLowerCase();
    if (query.length < 2) return { games: [], publishers: [], competitors: [] };

    const games = [];
    for (const game of visibleTrending) {
      if (
        (game.title || "").toLowerCase().includes(query) ||
        (game.publisher_name || "").toLowerCase().includes(query) ||
        (game.package_name || "").toLowerCase().includes(query)
      ) {
        games.push(game);
        if (games.length >= 5) break;
      }
    }

    const publishers = [];
    const competitors = [];
    for (const comp of visibleCompetitorTree) {
      if (
        competitors.length < 4 &&
        ((comp.name || "").toLowerCase().includes(query) ||
          (comp.ads_id || "").toLowerCase().includes(query))
      ) {
        competitors.push(comp);
      }
      if (publishers.length < 4) {
        for (const account of comp.accounts || []) {
          if (
            (account.publisher_name || "").toLowerCase().includes(query) ||
            (comp.name || "").toLowerCase().includes(query)
          ) {
            publishers.push({
              ...account,
              competitorName: comp.name,
              competitorId: comp.id,
            });
            if (publishers.length >= 4) break;
          }
        }
      }
      if (competitors.length >= 4 && publishers.length >= 4) break;
    }

    return { games, publishers, competitors };
  }, [deferredGlobalSearchQuery, visibleTrending, visibleCompetitorTree]);

  const globalSearchResultCount =
    globalSearchResults.games.length +
    globalSearchResults.publishers.length +
    globalSearchResults.competitors.length;

  const flatGlobalResults = useMemo(() => {
    const items = [];
    globalSearchResults.games.forEach((item) => items.push({ kind: "game", item }));
    globalSearchResults.publishers.forEach((item) => items.push({ kind: "publisher", item }));
    globalSearchResults.competitors.forEach((item) => items.push({ kind: "competitor", item }));
    return items;
  }, [globalSearchResults]);

  useEffect(() => {
    setGlobalSearchHighlightIdx(-1);
  }, [deferredGlobalSearchQuery, activeDropdown]);

  const sortedTrending = useMemo(() => {
    const decorated = visibleTrending.map((game) => {
      let metric = 0;
      if (trendingSort === "ads") {
        metric = Number(game.ad_count) || 0;
      } else if (trendingSort === "newest") {
        metric = getGameReleaseTime(game);
      } else {
        metric = getInstallCount(game);
      }
      return {
        game,
        metric,
        identity: getGameIdentity(game),
      };
    });

    decorated.sort((a, b) => {
      if (b.metric !== a.metric) return b.metric - a.metric;
      return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
    });

    return decorated.map((entry) => entry.game);
  }, [visibleTrending, trendingSort]);

  const handleSaveSettings = async (e) => {
    e.preventDefault(); 
    if (!isAdmin) return;
    setIsSavingSettings(true); 
    setSettingsStatus("");
    try {
      const data = await fetchJson(`${API_BASE}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      if (data?.status === "success") { setSettingsStatus("Settings saved successfully!"); setTimeout(() => setSettingsStatus(""), 3500); }
    } catch { setSettingsStatus("Failed to save settings."); } finally { setIsSavingSettings(false); }
  };

  const handleCreateList = async (e) => {
    e.preventDefault();
    if (!isAdmin || savingList) return;
    const name = newListName.trim();
    const parsedTargets = newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
    if (!name || parsedTargets.length === 0) {
      AtlasFeedback.toast("Enter a batch list name and at least one target ID.", { tone: "amber" });
      return;
    }
    setSavingList(true);
    try {
      const created = await fetchJson(`${API_BASE}/api/lists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          targets: parsedTargets
        })
      });
      setTargetLists(prev => [created, ...prev]);
      setNewListName("");
      setNewListTargets("");
      AtlasFeedback.toast(`Saved batch list "${name}".`, { tone: "success" });
    } catch (err) {
      console.error("List creation error:", err);
      AtlasFeedback.toast(err?.message || "Failed to save batch list.", { tone: "danger" });
    } finally {
      setSavingList(false);
    }
  };

  const handleSaveCompetitor = async (e) => {
    e.preventDefault();
    if (!isAdmin || savingCompetitor) return;
    const name = newCompName.trim();
    const adsId = newCompAdsId.trim();
    if (!name || !adsId) {
      AtlasFeedback.toast("Enter both competitor name and Advertiser ID.", { tone: "amber" });
      return;
    }
    setSavingCompetitor(true);
    try {
      const created = await fetchJson(`${API_BASE}/api/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, adsId, country: "Any" })
      });
      const newEntry = { id: created.id, name, ads_id: adsId, country: "Any" };
      setSavedCompetitors(prev => [newEntry, ...prev]);
      setCompetitorTree(prev => [{ ...newEntry, accounts: [] }, ...prev]);
      setStats(prev => ({ ...prev, competitors: (Number(prev.competitors) || 0) + 1 }));
      setNewCompName("");
      setNewCompAdsId("");
      AtlasFeedback.toast(`Saved competitor "${name}".`, { tone: "success" });
    } catch (err) {
      console.error("Competitor save error:", err);
      AtlasFeedback.toast(err?.message || "Failed to save competitor.", { tone: "danger" });
    } finally {
      setSavingCompetitor(false);
    }
  };

  const handleSaveEmailList = async (e) => {
    e.preventDefault();
    if (!isAdmin || savingRecipient) return;
    const name = newEmailName.trim();
    const parsedEmails = newEmailTargets.split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
    if (!name || parsedEmails.length === 0) {
      AtlasFeedback.toast("Enter a contact group name and at least one email.", { tone: "amber" });
      return;
    }
    setSavingRecipient(true);
    try {
      await fetchJson(`${API_BASE}/api/emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          emails: parsedEmails
        })
      });
      setNewEmailName("");
      setNewEmailTargets("");
      const updatedEmails = await fetchJson(`${API_BASE}/api/emails`);
      setEmailLists(Array.isArray(updatedEmails) ? updatedEmails : []);
      AtlasFeedback.toast(`Saved recipient group "${name}".`, { tone: "success" });
    } catch (err) {
      console.error("Email list save error:", err);
      AtlasFeedback.toast(err?.message || "Failed to save recipient group.", { tone: "danger" });
    } finally {
      setSavingRecipient(false);
    }
  };

  const handleDeleteList = async (id) => {
    if (!isAdmin || deletingTargetKey) return;
    const confirmed = await AtlasFeedback.confirm("Delete this target list?", {
      title: "Delete Batch List?",
      confirmLabel: "Delete",
      destructive: true
    });
    if (!confirmed) return;

    const prevLists = targetLists;
    setDeletingTargetKey(`list:${id}`);
    setTargetLists(prev => prev.filter(item => item.id !== id));
    try {
      await fetchJson(`${API_BASE}/api/lists/${id}`, { method: "DELETE" });
      AtlasFeedback.toast("Deleted target list.", { tone: "success" });
    } catch (err) {
      console.error("List delete error:", err);
      setTargetLists(prevLists);
      AtlasFeedback.toast(err?.message || "Failed to delete target list.", { tone: "danger" });
      void loadAllData();
    } finally {
      setDeletingTargetKey(null);
    }
  };

  const handleDeleteCompetitor = async (id) => {
    if (!isAdmin || deletingTargetKey) return;
    const confirmed = await AtlasFeedback.confirm("Delete this saved competitor?", {
      title: "Delete Competitor?",
      confirmLabel: "Delete",
      destructive: true
    });
    if (!confirmed) return;

    const prevSaved = savedCompetitors;
    const prevTree = competitorTree;
    setDeletingTargetKey(`comp:${id}`);
    setSavedCompetitors(prev => prev.filter(item => item.id !== id));
    setCompetitorTree(prev => prev.filter(item => item.id !== id));
    try {
      await fetchJson(`${API_BASE}/api/saved-competitors/${id}`, { method: "DELETE" });
      AtlasFeedback.toast("Deleted saved competitor.", { tone: "success" });
      void loadAllData();
    } catch (err) {
      console.error("Competitor delete error:", err);
      setSavedCompetitors(prevSaved);
      setCompetitorTree(prevTree);
      AtlasFeedback.toast(err?.message || "Failed to delete competitor.", { tone: "danger" });
      void loadAllData();
    } finally {
      setDeletingTargetKey(null);
    }
  };

  const handleDeleteEmail = async (id) => {
    if (!isAdmin || deletingTargetKey) return;
    const confirmed = await AtlasFeedback.confirm("Delete this email target?", {
      title: "Delete Recipient?",
      confirmLabel: "Delete",
      destructive: true
    });
    if (!confirmed) return;

    const prevEmails = emailLists;
    setDeletingTargetKey(`email:${id}`);
    setEmailLists(prev => prev.filter(item => item.id !== id));
    try {
      await fetchJson(`${API_BASE}/api/emails/${id}`, { method: "DELETE" });
      AtlasFeedback.toast("Deleted email recipient.", { tone: "success" });
    } catch (err) {
      console.error("Email delete error:", err);
      setEmailLists(prevEmails);
      AtlasFeedback.toast(err?.message || "Failed to delete recipient.", { tone: "danger" });
      void loadAllData();
    } finally {
      setDeletingTargetKey(null);
    }
  };
  
  const handleCancelScan = async () => {
    if (!isAdmin) return;
    const confirmed = await AtlasFeedback.confirm("Abort the current scan? Any targets already processed will be saved safely.", {
      title: "Abort Scan?",
      confirmLabel: "Abort",
      destructive: true
    });
    if (!confirmed) return;
    try {
      await fetchJson(`${API_BASE}/api/cancel-scan`, { method: "POST" });
      setScanProgress(prev => ({ ...prev, logs: [...prev.logs, "> Sending cancel request to backend..."] }));
      AtlasFeedback.toast("Cancelling active scan...", { tone: "amber" });
    } catch (err) {
      console.error("Scan cancel error:", err);
      AtlasFeedback.toast(err?.message || "Failed to cancel scan.", { tone: "danger" });
    }
  };

  const handleRunScan = async () => {
    if (!isAdmin) return AtlasFeedback.inform("Only administrators can initiate scans.", { title: "Admin required" });
    if (isStartingScan || isScanning) return;
    if (selectedSource === "manual" && !scanQuery.trim()) {
      return AtlasFeedback.inform("Please enter a competitor name or AR ID before starting a scan.", { title: "Target required" });
    }

    const directReportEmail = customReportEmail.trim();
    if (selectedEmailList === "custom" && !EMAIL_REGEX.test(directReportEmail)) {
      return AtlasFeedback.inform("Please enter a valid email address for the report.", { title: "Invalid email" });
    }

    let targetCompId = null;
    let targetDisplayName = scanQuery;

    if (selectedSource.startsWith("comp_")) {
      targetCompId = selectedSource.split("_")[1];
      const found = savedCompetitors.find(c => `comp_${c.id}` === selectedSource);
      if (found) targetDisplayName = found.name;
    } else if (selectedSource.startsWith("list_")) {
      const foundList = targetLists.find(l => `list_${l.id}` === selectedSource);
      if (foundList) targetDisplayName = foundList.name;
    }

    setLatestScanTargetName(targetDisplayName);
    setLatestScanCompId(targetCompId);
    setLatestScanPackages([]);
    setLatestScanAdCounts({});
    setLatestScanAdCountsByCompetitor({});
    setHasLatestScan(false);
    localStorage.setItem("atlas_latest_target_name", targetDisplayName || "");
    localStorage.removeItem("atlas_latest_packages");
    localStorage.removeItem("atlas_latest_ad_counts");
    localStorage.removeItem("atlas_latest_ad_counts_by_competitor");
    localStorage.setItem("atlas_has_latest_scan", "0");
    if (targetCompId) localStorage.setItem("atlas_latest_comp_id", targetCompId);
    else localStorage.removeItem("atlas_latest_comp_id");

    setViewMode("all");
    setIsStartingScan(true);
    setIsScanning(true);
    setIsScanMinimized(false);

    const finalLimit = isMaxAds ? 500 : Math.max(1, Number(scanLimit) || 1);
    setScanProgress({
      target: "Initializing...",
      targetIndex: 1,
      totalTargets: 1,
      currentAd: 0,
      totalAds: 500,
      targetUniqueGames: finalLimit,
      uniqueGamesFound: 0,
      adsInspected: 0,
      discoveredCreatives: 0,
      duplicateAds: 0,
      adsWithoutPackages: 0,
      maxAdsToInspect: 500,
      scanStopReason: null,
      timeRemaining: "Calculating...",
      logs: ["> Starting scan with a unique-game target..."]
    });

    let scanType = "manual";
    let targetId = null;
    if (selectedSource.startsWith("list_")) {
      scanType = "list";
      targetId = selectedSource.split("_")[1];
    } else if (selectedSource.startsWith("comp_")) {
      scanType = "competitor";
      targetId = selectedSource.split("_")[1];
    }

    scanLaunchPendingRef.current = true;

    try {
      await fetchJson(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchQuery: scanQuery,
          scanType,
          targetId,
          targetCountry: "Any",
          limit: finalLimit,
          sendReport: selectedEmailList !== "none",
          emailListId: selectedEmailList === "custom" ? null : selectedEmailList,
          reportEmail: selectedEmailList === "custom" ? directReportEmail : null
        })
      });

      scanLaunchPendingRef.current = false;

      const status = await fetchJson(`${API_BASE}/api/scan-status`);
      applyScanStatus(status);
    } catch (err) {
      scanLaunchPendingRef.current = false;
      console.error("Scan dispatch error:", err);
      setIsScanning(false);
      setScanProgress(prev => ({
        ...prev,
        timeRemaining: "Stopped",
        logs: [...prev.logs, `> ${err.message || "Unable to start scan."}`].slice(-5)
      }));
      AtlasFeedback.toast(err?.message || "Unable to start scan.", { tone: "danger" });
    } finally {
      setIsStartingScan(false);
    }
  };

  const fetchLatestCountryScan = useCallback(async (packageName) => {
    const normalized = String(packageName || "").trim();
    if (!normalized) return null;

    const payload = await fetchJson(API_BASE + "/api/country-scans/latest?packageName=" + encodeURIComponent(normalized));
    countryScanDetailCacheRef.current.set(normalized, payload);
    return payload;
  }, []);

  const refreshCountryScanLibrary = useCallback(async () => {
    try {
      const data = await fetchJson(API_BASE + "/api/country-scans");
      setCountryScanLibrary(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Country scan library refresh failed:", error);
    }
  }, []);

  const openCountryScanDetails = useCallback((payload, packageName) => {
    if (payload) {
      setCountryScanData(payload);
      if (packageName) countryScanDetailCacheRef.current.set(packageName, payload);
    }
    if (packageName) setCountryPackage(packageName);
    setCountryScanFilter("all");
    setCountryScanSearch("");
    setCountryScanViewTab("availability");
    setCountryScanError("");
    setCountryScanLoading(false);
    setCountryScanModalOpen(true);
  }, []);

  const handleViewSavedCountryScan = useCallback(async (packageOverride) => {
    const packageName = String(packageOverride || countryPackage || "").trim();
    if (!packageName) {
      setCountryScanError("Enter an Android package name first.");
      setCountryScanLoading(false);
      setCountryScanModalOpen(true);
      return;
    }

    const libraryEntry = countryScanLibrary.find(item => item.packageName === packageName);
    const cached = countryScanDetailCacheRef.current.get(packageName);
    const cacheMatchesLatest = cached &&
      (!libraryEntry?.scanId || Number(cached.scan?.id) === Number(libraryEntry.scanId));

    setCountryPackage(packageName);
    setCountryScanError("");
    setCountryScanFilter("all");
    setCountryScanSearch("");
    setCountryScanViewTab("availability");

    if (cacheMatchesLatest) {
      setCountryScanData(cached);
      setCountryScanLoading(false);
      setCountryScanModalOpen(true);
      if (selectedGame?.package_name === packageName) setSelectedGameCountryScan(cached);
      return;
    }

    setCountryScanData(null);
    setCountryScanLoading(true);
    setViewingCountryPkg(packageName);
    setCountryScanModalOpen(true);

    try {
      const payload = await fetchLatestCountryScan(packageName);
      setCountryScanData(payload);
      if (selectedGame?.package_name === packageName) setSelectedGameCountryScan(payload);
    } catch (error) {
      setCountryScanError(error.message || "No saved country scan was found.");
    } finally {
      setCountryScanLoading(false);
      setViewingCountryPkg((prev) => (prev === packageName ? null : prev));
    }
  }, [countryPackage, countryScanLibrary, fetchLatestCountryScan, selectedGame?.package_name]);

  const handleStartCountryScan = useCallback(async (packageOverride) => {
    const packageName = String(packageOverride || countryPackage || "").trim();
    if (!isAdmin) return;

    if (!packageName) {
      setCountryScanError("Enter an Android package name first.");
      setCountryScanModalOpen(true);
      return;
    }

    setCountryPackage(packageName);
    setCountryScanModalOpen(false);
    setCountryScanData(null);
    setCountryScanLoading(false);
    setCountryScanError("");
    setCountryScanFilter("all");
    setCountryScanSearch("");
    setCountryScanViewTab("availability");
    setIsCountryScanMinimized(false);
    setCountryScanJob({
      scanId: null,
      packageName,
      state: "starting",
      checked: 0,
      total: 0,
      currentCountry: null,
      currentCountryName: null
    });

    try {
      const job = await fetchJson(API_BASE + "/api/country-scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName })
      });
      setCountryScanJob(job);
      localStorage.setItem(COUNTRY_SCAN_JOB_KEY, JSON.stringify({
        scanId: job.scanId,
        packageName: job.packageName
      }));
    } catch (error) {
      setCountryScanJob(null);
      setCountryScanError(error.message || "Unable to start country scan.");
      setCountryScanModalOpen(true);
    }
  }, [countryPackage, isAdmin]);

  useEffect(() => {
    if (!authToken || !currentUser) return undefined;

    let disposed = false;

    const recoverCountryScan = async () => {
      let savedJob = null;
      try {
        savedJob = JSON.parse(localStorage.getItem(COUNTRY_SCAN_JOB_KEY) || "null");
      } catch {
        localStorage.removeItem(COUNTRY_SCAN_JOB_KEY);
      }

      try {
        const activeResponse = await fetchJson(API_BASE + "/api/country-scans/active");
        if (disposed) return;

        let recovered = activeResponse?.activeScan || null;

        if (!recovered && savedJob?.scanId) {
          try {
            recovered = await fetchJson(API_BASE + "/api/country-scans/status/" + savedJob.scanId);
          } catch {
            recovered = null;
          }
        }

        if (!recovered?.scanId) {
          localStorage.removeItem(COUNTRY_SCAN_JOB_KEY);
          return;
        }

        const alreadyAnnounced = announcedCountryScanIdsRef.current.has(String(recovered.scanId));
        const isRunning = ["starting", "running"].includes(recovered.state);
        const isFinished = ["complete", "error"].includes(recovered.state);
        if (isRunning || (isFinished && !alreadyAnnounced)) {
          setCountryPackage(recovered.packageName || savedJob?.packageName || "");
          setCountryScanJob(recovered);
          localStorage.setItem(COUNTRY_SCAN_JOB_KEY, JSON.stringify({
            scanId: recovered.scanId,
            packageName: recovered.packageName || savedJob?.packageName || ""
          }));
        } else {
          localStorage.removeItem(COUNTRY_SCAN_JOB_KEY);
        }
      } catch (error) {
        console.error("Country scan recovery failed:", error);
      }
    };

    void recoverCountryScan();
    return () => { disposed = true; };
  }, [authToken, currentUser]);

  useEffect(() => {
    if (!isDrawerOpen || !selectedGame?.package_name) return undefined;

    if (selectedGame?.is_suspended && selectedGame?.suspension_country_scan) {
      setSelectedGameCountryLoading(false);
      setSelectedGameCountryScan(selectedGame.suspension_country_scan);
      return undefined;
    }

    const packageName = selectedGame.package_name;
    const cached = countryScanDetailCacheRef.current.get(packageName);
    if (cached) {
      setSelectedGameCountryLoading(false);
      setSelectedGameCountryScan(cached);
      return undefined;
    }

    let cancelled = false;
    setSelectedGameCountryLoading(true);
    setSelectedGameCountryScan(null);

    fetchLatestCountryScan(packageName)
      .then(payload => {
        if (!cancelled) setSelectedGameCountryScan(payload);
      })
      .catch(() => {
        if (!cancelled) setSelectedGameCountryScan(null);
      })
      .finally(() => {
        if (!cancelled) setSelectedGameCountryLoading(false);
      });

    return () => { cancelled = true; };
  }, [isDrawerOpen, selectedGame?.package_name, selectedGame?.is_suspended, selectedGame?.suspension_country_scan, fetchLatestCountryScan]);

  useEffect(() => {
    if (!isDrawerOpen || !selectedGame?.package_name) {
      setSelectedGameVideos([]);
      setSelectedGameVideosLoading(false);
      return undefined;
    }

    const packageName = selectedGame.package_name;
    const cachedEntry = selectedGameVideosCacheRef.current.get(packageName);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      setSelectedGameVideos(cachedEntry.data);
      setSelectedGameVideosLoading(false);
      return undefined;
    }

    let cancelled = false;
    setSelectedGameVideos([]);
    setSelectedGameVideosLoading(true);

    fetchJson(API_BASE + "/api/video-assets?packageName=" + encodeURIComponent(packageName))
      .then(payload => {
        const list = Array.isArray(payload) ? payload : [];
        selectedGameVideosCacheRef.current.set(packageName, {
          expiresAt: Date.now() + 15000,
          data: list
        });
        if (!cancelled) setSelectedGameVideos(list);
      })
      .catch(error => {
        if (!cancelled) {
          console.warn("Game video lookup failed:", error?.message || error);
          setSelectedGameVideos([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedGameVideosLoading(false);
      });

    return () => { cancelled = true; };
  }, [isDrawerOpen, selectedGame?.package_name]);

  const applyTelemetryToState = useCallback((updatedGame) => {
    if (!updatedGame?.package_name) return;
    const pkg = updatedGame.package_name;
    telemetryCacheRef.current.set(pkg, updatedGame);
    setSelectedGame(prev => (prev && prev.package_name === pkg ? { ...prev, ...updatedGame } : prev));
    setTrending(prev => prev.map(g => (g.package_name === pkg ? { ...g, ...updatedGame } : g)));
    setCompetitorTree(prev => prev.map(comp => ({
      ...comp,
      accounts: (comp.accounts || []).map(acc => ({
        ...acc,
        games: (acc.games || []).map(g => (g.package_name === pkg ? { ...g, ...updatedGame } : g))
      }))
    })));
  }, []);

  const handleRefreshGameTelemetry = useCallback(async (game) => {
    const pkg = typeof game === "string" ? game : game?.package_name;
    if (!pkg) return;
    setTelemetryRefreshingPkg(pkg);
    try {
      const res = await fetchJson(`${API_BASE}/api/telemetry/${encodeURIComponent(pkg)}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (res?.game) applyTelemetryToState(res.game);
    } catch (error) {
      console.warn("Telemetry refresh failed:", error?.message || error);
    } finally {
      setTelemetryRefreshingPkg(null);
    }
  }, [applyTelemetryToState]);

  useEffect(() => {
    if (!isDrawerOpen || !selectedGame?.package_name) return undefined;
    const pkg = selectedGame.package_name;
    if (selectedGame.real_installs != null && selectedGame.store_scanned_at) {
      return undefined;
    }
    const cached = telemetryCacheRef.current.get(pkg);
    if (cached) {
      applyTelemetryToState(cached);
      return undefined;
    }
    let cancelled = false;
    fetchJson(`${API_BASE}/api/telemetry/${encodeURIComponent(pkg)}`)
      .then(gamePayload => {
        if (!cancelled && gamePayload?.package_name) {
          applyTelemetryToState(gamePayload);
        }
      })
      .catch(error => {
        if (!cancelled) console.warn("Telemetry lookup failed:", error?.message || error);
      });
    return () => { cancelled = true; };
  }, [isDrawerOpen, selectedGame?.package_name, selectedGame?.real_installs, selectedGame?.store_scanned_at, applyTelemetryToState]);

  useEffect(() => {
    selectedGamePackageRef.current = selectedGame?.package_name || null;
  }, [selectedGame?.package_name]);

  useEffect(() => {
    const scanId = countryScanJob?.scanId;
    if (!scanId) return undefined;
    // Already finished and shown once: never poll/re-open again on its own.
    if (announcedCountryScanIdsRef.current.has(String(scanId))) return undefined;

    let cancelled = false;
    let timer = null;

    const poll = async () => {
      let shouldContinue = true;

      try {
        const status = await fetchJson(API_BASE + "/api/country-scans/status/" + scanId);
        if (cancelled) return;

        if (status.state === "complete") {
          const payload = await fetchLatestCountryScan(status.packageName);
          if (cancelled) return;
          shouldContinue = false;
          markCountryScanAnnounced(scanId);

          setCountryScanData(payload);
          setCountryScanLoading(false);
          setCountryScanError("");
          setCountryScanFilter("all");
          setCountryScanSearch("");
          setCountryScanJob(status);
          setIsCountryScanMinimized(false);
          setCountryScanModalOpen(true);
          localStorage.removeItem(COUNTRY_SCAN_JOB_KEY);
          void refreshCountryScanLibrary();
          void loadAllData();
          const liveCount = Number(payload?.scan?.counts?.live) || 0;
          AtlasFeedback.toast(`Country scan finished for ${status.packageName} (${liveCount} live).`, { tone: "success" });

          if (selectedGamePackageRef.current === status.packageName) {
            setSelectedGameCountryScan(payload);
            setSelectedGameCountryLoading(false);
          }
        } else if (status.state === "error") {
          shouldContinue = false;
          markCountryScanAnnounced(scanId);
          setCountryScanJob(status);
          setCountryScanLoading(false);
          setCountryScanError(status.error || "Country scan failed.");
          setCountryScanModalOpen(true);
          localStorage.removeItem(COUNTRY_SCAN_JOB_KEY);
          AtlasFeedback.toast(status.error || "Country scan failed.", { tone: "danger" });
        } else {
          setCountryScanJob(status);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Country scan progress check failed:", error);
        }
      }

      if (!cancelled && shouldContinue) {
        timer = window.setTimeout(poll, 1500);
      }
    };

    timer = window.setTimeout(poll, 500);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryScanJob?.scanId]);

  const countryChangesByCode = useMemo(() => {
    const map = new Map();
    for (const change of countryScanData?.changes || []) map.set(change.countryCode, change);
    return map;
  }, [countryScanData]);

  const visibleCountryResults = useMemo(() => {
    const search = deferredCountryScanSearch.trim().toLowerCase();
    return (countryScanData?.results || []).filter(item => {
      const matchesSearch = !search ||
        String(item.countryName || "").toLowerCase().includes(search) ||
        String(item.countryCode || "").toLowerCase().includes(search);
      if (!matchesSearch) return false;
      if (countryScanFilter === "all") return true;
      if (countryScanFilter === "changed") return countryChangesByCode.has(item.countryCode);
      return item.state === countryScanFilter;
    });
  }, [countryScanData, countryScanFilter, deferredCountryScanSearch, countryChangesByCode]);

  const filteredCountryScanLibrary = useMemo(() => {
    const query = deferredCountryLibrarySearch.trim().toLowerCase();
    if (!query) return countryScanLibrary;

    return countryScanLibrary.filter(item =>
      String(item.appTitle || "").toLowerCase().includes(query) ||
      String(item.developer || "").toLowerCase().includes(query) ||
      String(item.packageName || "").toLowerCase().includes(query) ||
      (item.competitors || []).some(name => String(name || "").toLowerCase().includes(query))
    );
  }, [countryScanLibrary, deferredCountryLibrarySearch]);

  const countryPerformanceRows = useMemo(() => {
    const query = deferredCountryScanSearch.trim().toLowerCase();
    const rows = (countryScanData?.results || [])
      .filter(item => {
        if (item.playRating == null && item.atlasMarketScore == null && !item.ratingsCount && !item.reviewsCount) return false;
        if (!query) return true;
        return String(item.countryName || "").toLowerCase().includes(query) ||
          String(item.countryCode || "").toLowerCase().includes(query);
      })
      .map(item => ({ ...item }));

    const numeric = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const validScores = rows
      .map(item => Number(item.atlasMarketScore))
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b);
    const q1 = validScores.length ? validScores[Math.floor((validScores.length - 1) * 0.25)] : null;
    const q3 = validScores.length ? validScores[Math.floor((validScores.length - 1) * 0.75)] : null;
    const hasUsefulSpread = q1 != null && q3 != null && (q3 - q1) >= 0.5;

    for (const item of rows) {
      const score = Number(item.atlasMarketScore);
      item.performanceBand = !Number.isFinite(score) || !hasUsefulSpread
        ? "typical"
        : score >= q3
          ? "strong"
          : score <= q1
            ? "weak"
            : "typical";
    }

    rows.sort((a, b) => {
      if (countryPerformanceSort === "atlas_asc") return numeric(a.atlasMarketScore, Infinity) - numeric(b.atlasMarketScore, Infinity);
      if (countryPerformanceSort === "rating_desc") return numeric(b.playRating, -Infinity) - numeric(a.playRating, -Infinity);
      if (countryPerformanceSort === "rating_asc") return numeric(a.playRating, Infinity) - numeric(b.playRating, Infinity);
      if (countryPerformanceSort === "ratings_desc") return numeric(b.ratingsCount, 0) - numeric(a.ratingsCount, 0);
      if (countryPerformanceSort === "reviews_desc") return numeric(b.reviewsCount, 0) - numeric(a.reviewsCount, 0);
      if (countryPerformanceSort === "negative_desc") return numeric(b.negativeShare, -Infinity) - numeric(a.negativeShare, -Infinity);
      if (countryPerformanceSort === "positive_desc") return numeric(b.positiveShare, -Infinity) - numeric(a.positiveShare, -Infinity);
      return numeric(b.atlasMarketScore, -Infinity) - numeric(a.atlasMarketScore, -Infinity);
    });

    return rows;
  }, [countryScanData, deferredCountryScanSearch, countryPerformanceSort]);

  const countryScanSummary = useMemo(() => {
    if (!countryScanData?.scan) return "";

    const counts = countryScanData.scan.counts || {};
    const total = (countryScanData.results || []).length ||
      ["live", "pre_register", "early_access", "unavailable", "unknown"]
        .reduce((sum, state) => sum + (Number(counts[state]) || 0), 0);

    if (!total) return "Scan completed, but no Google Play country results were returned.";

    const allState = [
      ["live", "Live"],
      ["pre_register", "Pre-register"],
      ["early_access", "Early access"],
      ["unavailable", "Unavailable"],
      ["unknown", "Unknown"]
    ].find(([state]) => (Number(counts[state]) || 0) === total);

    if (allState) {
      return allState[0] === "live"
        ? `Live in all ${total} Google Play countries/regions.`
        : `${allState[1]} in all ${total} Google Play countries/regions.`;
    }

    const parts = [
      ["live", "live"],
      ["pre_register", "pre-register"],
      ["early_access", "early access"],
      ["unavailable", "unavailable"],
      ["unknown", "unknown"]
    ]
      .map(([state, label]) => [Number(counts[state]) || 0, label])
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`);

    return `Checked ${total} Google Play countries/regions: ${parts.join(", ")}.`;
  }, [countryScanData]);

  const handleGameClick = useCallback((game) => {
    setSelectedGameCountryScan(null);
    setSelectedGameVideos([]);
    setSelectedGame(game);
    setIsDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
  }, []);
  const openStatPanel = useCallback((panel) => {
    setStatPanelSearch("");
    setActiveStatPanel(panel);
  }, []);
  const closeStatPanel = useCallback(() => {
    setActiveStatPanel(null);
    setStatPanelSearch("");
  }, []);
  const openGameFromStatPanel = useCallback((game) => {
    setActiveStatPanel(null);
    setStatPanelSearch("");
    setSelectedGameCountryScan(null);
    setSelectedGameVideos([]);
    setSelectedGame(game);
    setIsDrawerOpen(true);
  }, []);

  const openPlayStoreFromSearch = useCallback((value) => {
    if (value) setPlayStoreSearchQuery(value);
    setActiveTab("playStore");
    setActiveDropdown(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const getTargetSourceName = () => {
    if (selectedSource === "manual") return "Manual entry";
    if (selectedSource.startsWith("comp_")) { const comp = savedCompetitors.find(c => `comp_${c.id}` === selectedSource); return comp ? comp.name : "Saved competitor"; }
    if (selectedSource.startsWith("list_")) { const list = targetLists.find(l => `list_${l.id}` === selectedSource); return list ? list.name : "Target list"; }
    return "Select Source";
  };

  const getEmailListName = () => {
    if (selectedEmailList === "none") return "Don't send";
    if (selectedEmailList === "custom") return customReportEmail.trim() || "Custom email";
    const list = emailLists.find(e => e.id.toString() === selectedEmailList.toString());
    return list ? list.name : "Don't send";
  };

  const dropDownAnim = { hidden: { opacity: 0, y: -10, scale: 0.95 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.15, ease: "easeOut" } }, exit: { opacity: 0, y: -10, scale: 0.95, transition: { duration: 0.1, ease: "easeIn" } } };
  const scanPercentage = Math.min(
    100,
    Math.max(
      (Number(scanProgress.uniqueGamesFound) || 0) / Math.max(1, Number(scanProgress.targetUniqueGames) || 1),
      (Number(scanProgress.adsInspected) || 0) /
        Math.max(1, Number(scanProgress.discoveredCreatives) || Number(scanProgress.maxAdsToInspect) || 500)
    ) * 100
  ).toFixed(0);
  const isCountryScanRunning = ["starting", "running"].includes(countryScanJob?.state);
  const countryScanPercentage = Math.min(
    100,
    ((countryScanJob?.checked || 0) / Math.max(1, countryScanJob?.total || 1)) * 100
  ).toFixed(0);

  const isSidebarExpanded = sidebarPinned || sidebarHovered;

  // FULL-SCREEN SECURITY GATE FOR UNAUTHENTICATED USERS
  if (!authToken || !currentUser) {
    return (
      <div className="min-h-screen bg-bg-base text-text-main flex items-center justify-center p-5 relative">
        <div className="absolute top-4 right-4">
          <AppearanceMenu
            theme={theme}
            accent={accent}
            onChangeTheme={(nextTheme) => applyAppearance(nextTheme, accent)}
            onChangeAccent={(nextAccent) => applyAppearance(theme, nextAccent)}
          />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="w-full max-w-[400px] bg-surface-solid border border-border-subtle rounded-xl p-6 sm:p-8 shadow-sm"
        >
          <div className="flex items-center gap-3 mb-7">
            <img src="/atlas-logo.png" alt="Atlas" className="h-9 w-9 object-contain rounded-lg" />
            <div>
              <div className="text-base font-semibold tracking-tight text-text-main">Atlas</div>
              <div className="text-xs text-text-muted">Game market intelligence</div>
            </div>
          </div>

          <div className="mb-5">
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-main">Sign in</h1>
            <p className="text-[13px] text-text-muted mt-1">Enter your workspace credentials to continue.</p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted block">Username</label>
              <input
                type="text"
                autoFocus
                autoComplete="username"
                disabled={isLoggingIn}
                value={usernameInput}
                onChange={(e) => { setUsernameInput(e.target.value); setLoginError(""); }}
                className="w-full h-10 bg-input-bg text-text-main border border-border-subtle rounded-lg px-3 text-[13px] outline-none focus:border-accent focus:bg-surface-solid transition-colors disabled:opacity-60"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted block">Password</label>
              <input
                type="password"
                autoComplete="current-password"
                disabled={isLoggingIn}
                value={passwordInput}
                onChange={(e) => { setPasswordInput(e.target.value); setLoginError(""); }}
                className="w-full h-10 bg-input-bg text-text-main border border-border-subtle rounded-lg px-3 text-[13px] outline-none focus:border-accent focus:bg-surface-solid transition-colors disabled:opacity-60"
              />
            </div>

            {loginError && (
              <div className="atlas-badge-danger border flex items-start gap-2 text-xs rounded-lg px-3 py-2.5">
                <AtlasIcon name="error" size={16} className="mt-0.5 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <div className="pt-1">
              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full h-10 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover disabled:opacity-60 text-btn-primary-fg text-[13px] font-medium transition-colors inline-flex items-center justify-center gap-2"
              >
                {isLoggingIn && <AtlasIcon name="progress_activity" size={16} className="animate-spin" />}
                <span>{isLoggingIn ? "Signing in..." : "Sign in"}</span>
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    );
  }
  return (
    <div className="bg-bg-base text-text-main min-h-screen relative overflow-x-hidden pb-24 md:pb-0">
      {/* TOP WORKSPACE HEADER */}
      <header className="fixed top-0 left-0 right-0 h-14 z-50 bg-surface-solid/95 backdrop-blur-md border-b border-border-subtle flex items-center px-3 sm:px-4 gap-3">
        <div className="flex items-center gap-2.5 min-w-0 sm:w-[192px]">
          <button
            type="button"
            onClick={() => { setActiveTab("dashboard"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className="flex items-center gap-2.5 min-w-0 rounded-lg focus-visible:outline-none"
            title="Return to Dashboard"
          >
            <img src="/atlas-logo.png" alt="Atlas Logo" className="h-7 w-7 object-contain rounded-md" />
            <span className="text-[15px] font-semibold tracking-tight text-text-main hidden sm:block">Atlas</span>
          </button>
        </div>

        <div className="flex-1 flex justify-center min-w-0">
          <div className="hidden sm:block relative w-full max-w-[540px]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center h-9 rounded-lg bg-input-bg border border-border-subtle focus-within:border-accent focus-within:bg-surface-solid transition-colors px-3 gap-2.5">
              <AtlasIcon name="search" size={16} className="text-text-muted" />
              <input
                value={globalSearchQuery}
                onFocus={() => { if (globalSearchQuery.trim().length >= 2) setActiveDropdown("globalSearch"); }}
                onChange={(e) => {
                  const value = e.target.value;
                  setGlobalSearchQuery(value);
                  setActiveDropdown(value.trim().length >= 2 ? "globalSearch" : null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && activeDropdown === "globalSearch" && flatGlobalResults.length > 0) {
                    e.preventDefault();
                    setGlobalSearchHighlightIdx((prev) => (prev + 1) % flatGlobalResults.length);
                    return;
                  }
                  if (e.key === "ArrowUp" && activeDropdown === "globalSearch" && flatGlobalResults.length > 0) {
                    e.preventDefault();
                    setGlobalSearchHighlightIdx((prev) => (prev <= 0 ? flatGlobalResults.length - 1 : prev - 1));
                    return;
                  }
                  if (e.key === "Enter") {
                    if (activeDropdown === "globalSearch" && globalSearchHighlightIdx >= 0 && flatGlobalResults[globalSearchHighlightIdx]) {
                      e.preventDefault();
                      const hit = flatGlobalResults[globalSearchHighlightIdx];
                      setActiveDropdown(null);
                      if (hit.kind === "game") handleGameClick(hit.item);
                      else if (hit.kind === "publisher") openPlayStoreFromSearch(hit.item.publisher_name);
                      else if (hit.kind === "competitor") openPlayStoreFromSearch(hit.item.name);
                      return;
                    }
                    openPlayStoreFromSearch(globalSearchQuery.trim());
                  }
                  if (e.key === "Escape") setActiveDropdown(null);
                }}
                placeholder="Search games, publishers, competitors, packages..."
                className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-text-main placeholder:text-text-muted/80"
              />
              {globalSearchQuery ? (
                <button
                  type="button"
                  onClick={() => { setGlobalSearchQuery(""); setActiveDropdown(null); }}
                  className="w-6 h-6 rounded-md hover:bg-surface-solid flex items-center justify-center text-text-muted hover:text-text-main"
                  aria-label="Clear search"
                >
                  <AtlasIcon name="close" size={14} />
                </button>
              ) : (
                <kbd className="hidden lg:inline-flex items-center rounded-md border border-border-subtle bg-surface-solid px-1.5 py-0.5 text-[11px] text-text-muted font-mono">
                  Enter
                </kbd>
              )}
            </div>

            <AnimatePresence>
              {activeDropdown === "globalSearch" && globalSearchQuery.trim().length >= 2 && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-11 left-0 right-0 bg-surface-solid border border-border-subtle rounded-xl shadow-lg overflow-hidden z-[70]"
                >
                  {globalSearchResultCount === 0 ? (
                    <div className="px-4 py-7 text-center text-[13px] text-text-muted">
                      No Atlas results for “{globalSearchQuery.trim()}”.
                    </div>
                  ) : (
                    <div className="max-h-[420px] overflow-y-auto custom-scrollbar py-1.5">
                      {globalSearchResults.games.length > 0 && (
                        <div className="py-1">
                          <div className="px-3.5 py-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">Games</div>
                          {globalSearchResults.games.map((game, idx) => (
                            <button
                              type="button"
                              key={`search-game-${getGameIdentity(game)}`}
                              onMouseEnter={() => setGlobalSearchHighlightIdx(idx)}
                              onClick={() => { setActiveDropdown(null); handleGameClick(game); }}
                              className={cn(
                                "w-full flex items-center gap-3 px-3.5 py-2 text-left hover:bg-input-bg transition-colors",
                                globalSearchHighlightIdx === idx && "bg-input-bg"
                              )}
                            >
                              <div className="w-8 h-8 rounded-lg overflow-hidden bg-input-bg border border-border-subtle flex-shrink-0 flex items-center justify-center text-text-muted">
                                {game.icon ? <img loading="lazy" decoding="async" src={game.icon} alt="" className="w-full h-full object-cover" /> : <AtlasIcon name="sports_esports" size={16} />}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-medium text-text-main truncate">{game.title || game.package_name}</div>
                                <div className="text-xs text-text-muted truncate">{game.publisher_name || game.package_name}</div>
                              </div>
                              <AtlasIcon name="chevron_right" size={15} className="text-text-muted" />
                            </button>
                          ))}
                        </div>
                      )}

                      {globalSearchResults.publishers.length > 0 && (
                        <div className="py-1 border-t border-border-subtle">
                          <div className="px-3.5 py-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">Publishers</div>
                          {globalSearchResults.publishers.map((publisher, index) => {
                            const flatIdx = globalSearchResults.games.length + index;
                            return (
                              <button
                                type="button"
                                key={`search-pub-${publisher.competitorId}-${publisher.id ?? publisher.publisher_name}-${index}`}
                                onMouseEnter={() => setGlobalSearchHighlightIdx(flatIdx)}
                                onClick={() => openPlayStoreFromSearch(publisher.publisher_name)}
                                className={cn(
                                  "w-full flex items-center gap-3 px-3.5 py-2 text-left hover:bg-input-bg transition-colors",
                                  globalSearchHighlightIdx === flatIdx && "bg-input-bg"
                                )}
                              >
                                <AtlasIcon name="business" size={16} className="text-text-muted" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-[13px] font-medium text-text-main truncate">{publisher.publisher_name}</div>
                                  <div className="text-xs text-text-muted truncate">{publisher.competitorName || "Publisher"}</div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {globalSearchResults.competitors.length > 0 && (
                        <div className="py-1 border-t border-border-subtle">
                          <div className="px-3.5 py-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">Competitors</div>
                          {globalSearchResults.competitors.map((competitor, index) => {
                            const flatIdx = globalSearchResults.games.length + globalSearchResults.publishers.length + index;
                            return (
                              <button
                                type="button"
                                key={`search-comp-${competitor.id ?? competitor.name}`}
                                onMouseEnter={() => setGlobalSearchHighlightIdx(flatIdx)}
                                onClick={() => openPlayStoreFromSearch(competitor.name)}
                                className={cn(
                                  "w-full flex items-center gap-3 px-3.5 py-2 text-left hover:bg-input-bg transition-colors",
                                  globalSearchHighlightIdx === flatIdx && "bg-input-bg"
                                )}
                              >
                                <AtlasIcon name="domain" size={16} className="text-text-muted" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-[13px] font-medium text-text-main truncate">{competitor.name}</div>
                                  <div className="text-xs text-text-muted font-mono truncate">{competitor.ads_id || "Competitor"}</div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => openPlayStoreFromSearch(globalSearchQuery.trim())}
                        className="w-full border-t border-border-subtle px-3.5 py-2.5 text-left text-xs font-medium text-link hover:bg-input-bg transition-colors flex items-center justify-between"
                      >
                        View results in Play Store
                        <AtlasIcon name="arrow_forward" size={15} />
                      </button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="relative flex items-center justify-end gap-2 sm:w-[320px]" onClick={(e) => e.stopPropagation()}>
          {isAdmin && (
            <div className="hidden lg:flex items-center bg-input-bg rounded-lg p-1 border border-border-subtle">
              <button
                type="button"
                onClick={() => setViewMode("all")}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  viewMode === "all" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
                )}
              >
                All time
              </button>
              <button
                type="button"
                onClick={() => setViewMode("latest")}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  viewMode === "latest" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
                )}
              >
                Latest
              </button>
            </div>
          )}

          <AppearanceMenu
            theme={theme}
            accent={accent}
            onChangeTheme={(nextTheme) => applyAppearance(nextTheme, accent)}
            onChangeAccent={(nextAccent) => applyAppearance(theme, nextAccent)}
          />

          <button
            type="button"
            onClick={() => setIsGuideOpen(true)}
            className="w-9 h-9 rounded-lg hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors"
            title="How Atlas works"
            aria-label="How Atlas works"
          >
            <AtlasIcon name="help" size={17} />
          </button>

          <button
            type="button"
            onClick={() => setActiveDropdown(activeDropdown === "account" ? null : "account")}
            className="w-8 h-8 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center text-xs font-semibold"
            title={`${currentUser?.username || "User"} account`}
            aria-expanded={activeDropdown === "account"}
          >
            {String(currentUser?.username || "A").slice(0, 1).toUpperCase()}
          </button>

          <AnimatePresence>
            {activeDropdown === "account" && (
              <motion.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.12 }}
                className="absolute top-11 right-0 w-56 bg-surface-solid border border-border-subtle rounded-xl shadow-lg overflow-hidden z-[70]"
              >
                <div className="px-3.5 py-3 border-b border-border-subtle">
                  <div className="text-[13px] font-medium text-text-main truncate">{currentUser?.username || "Atlas user"}</div>
                  <div className="text-xs text-text-muted mt-0.5">{isAdmin ? "Administrator" : "View-only access"}</div>
                </div>
                <div className="p-1.5">
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => { setActiveTab("settings"); setActiveDropdown(null); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-input-bg text-left text-[13px] text-text-main transition-colors"
                    >
                      <AtlasIcon name="settings" size={15} className="text-text-muted" />
                      <span>Settings</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-input-bg text-left text-[13px] text-text-main transition-colors"
                  >
                    <AtlasIcon name="logout" size={15} className="text-text-muted" />
                    <span>Sign out</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* PINNABLE COLLAPSIBLE NARROW ICON RAIL */}
      <aside
        onMouseEnter={() => { if (!sidebarPinned) setSidebarHovered(true); }}
        onMouseLeave={() => setSidebarHovered(false)}
        className={cn(
          "hidden md:flex fixed left-0 top-14 bottom-0 z-40 bg-surface-solid border-r border-border-subtle flex-col transition-[width,box-shadow] duration-200 ease-out overflow-hidden",
          isSidebarExpanded ? "w-[224px]" : "w-16",
          !sidebarPinned && sidebarHovered && "shadow-xl"
        )}
      >
        <div
          className={cn(
            "h-11 px-3 border-b border-border-subtle flex items-center shrink-0",
            isSidebarExpanded ? "justify-between" : "justify-center"
          )}
        >
          {isSidebarExpanded ? (
            <>
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted truncate">
                Workspace
              </span>
              <button
                type="button"
                onClick={toggleSidebarPin}
                title={sidebarPinned ? "Unpin sidebar" : "Pin sidebar open"}
                aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar open"}
                aria-pressed={sidebarPinned}
                className={cn(
                  "w-7 h-7 rounded-md flex items-center justify-center transition-colors",
                  sidebarPinned
                    ? "bg-primary-container text-on-primary-container"
                    : "text-text-muted hover:bg-input-bg hover:text-text-main"
                )}
              >
                <AtlasIcon name={sidebarPinned ? "pin_off" : "pin"} size={14} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={toggleSidebarPin}
              title="Pin sidebar open"
              aria-label="Pin sidebar open"
              className="w-8 h-8 rounded-md text-text-muted hover:bg-input-bg hover:text-text-main flex items-center justify-center transition-colors"
            >
              <AtlasIcon name="panel_left" size={16} />
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto custom-scrollbar p-2 flex flex-col gap-1">
          {[
            { id: "summary", icon: "monitoring", label: "Summary" },
            { id: "playStore", customIcon: GooglePlayIcon, label: "Play Store" },
            { id: "amazon", customIcon: AmazonAppstoreIcon, label: "Amazon" },
            { id: "automated", icon: "track_changes", label: "Targets" }
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              title={!isSidebarExpanded ? tab.label : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "w-full h-9 rounded-lg flex items-center text-[13px] font-medium transition-colors",
                isSidebarExpanded ? "px-2.5 gap-3 justify-start" : "justify-center",
                activeTab === tab.id
                  ? "bg-primary-container text-on-primary-container"
                  : "text-text-muted hover:bg-input-bg hover:text-text-main"
              )}
            >
              {tab.customIcon ? (
                <tab.customIcon className="w-[18px] h-[18px] flex-shrink-0" />
              ) : (
                <AtlasIcon name={tab.icon} size={18} />
              )}
              {isSidebarExpanded && <span className="truncate">{tab.label}</span>}
            </button>
          ))}

          {isAdmin && (
            <>
              <div className="my-2 border-t border-border-subtle" />
              {[
                { id: "dashboard", icon: "dashboard", label: "Dashboard" },
                { id: "countryScans", icon: "public", label: "Country Scans" },
                { id: "settings", icon: "settings", label: "Settings" }
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  title={!isSidebarExpanded ? tab.label : undefined}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "w-full h-9 rounded-lg flex items-center text-[13px] font-medium transition-colors",
                    isSidebarExpanded ? "px-2.5 gap-3 justify-start" : "justify-center",
                    activeTab === tab.id
                      ? "bg-primary-container text-on-primary-container"
                      : "text-text-muted hover:bg-input-bg hover:text-text-main"
                  )}
                >
                  <AtlasIcon name={tab.icon} size={18} />
                  {isSidebarExpanded && <span className="truncate">{tab.label}</span>}
                </button>
              ))}
            </>
          )}
        </nav>

        <div className="mt-auto border-t border-border-subtle p-3">
          <div
            className={cn("flex items-center", isSidebarExpanded ? "gap-2.5 px-1" : "justify-center")}
            title={isNodeOnline ? "System online" : "System offline"}
          >
            <span className={cn("w-2 h-2 rounded-full shrink-0", isNodeOnline ? "bg-sem-success" : "bg-sem-danger")} />
            {isSidebarExpanded && (
              <span className="text-xs text-text-muted truncate">
                {isNodeOnline ? "System online" : "System offline"}
              </span>
            )}
          </div>
        </div>
      </aside>

      <div className={cn("relative z-10 w-full transition-[padding] duration-200 ease-out", sidebarPinned ? "md:pl-[224px]" : "md:pl-16")}>
        <main className="relative min-h-screen px-4 sm:px-6 lg:px-8 pt-20 pb-28 md:pb-12 w-full max-w-[1520px] mx-auto">
          
          {!isNodeOnline && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-5 w-full atlas-badge-warning border rounded-xl px-4 py-2.5 flex flex-col sm:flex-row items-center justify-center gap-2 text-xs z-40 relative"
            >
              <span className="flex items-center gap-2 font-medium">
                <span className="w-2 h-2 rounded-full bg-sem-warning" />
                Server offline
              </span>
              <span className="hidden sm:block opacity-40">|</span>
              <span className="text-center sm:text-left">
                Workstation server is unreachable. Active tracking hours: 9:00 AM - 6:00 PM.
              </span>
            </motion.div>
          )}

          {activeTab === "dashboard" && (
            <div className="atlas-page-enter flex flex-col w-full gap-5">
              <PageHeader
                title="Dashboard"
                subtitle="Track ad detections, publishers, and live catalogues."
                badge={
                  isSyncingDashboard && (
                    <Badge tone="neutral">
                      <AtlasIcon name="progress_activity" size={12} className="animate-spin text-accent" />
                      Syncing
                    </Badge>
                  )
                }
                actions={
                  isAdmin && (
                    <div className="lg:hidden flex items-center bg-input-bg rounded-lg p-1 border border-border-subtle">
                      <button
                        type="button"
                        onClick={() => setViewMode("all")}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium",
                          viewMode === "all" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted"
                        )}
                      >
                        All time
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("latest")}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium",
                          viewMode === "latest" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted"
                        )}
                      >
                        Latest
                      </button>
                    </div>
                  )
                }
              />

              {isAdmin && (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                  <div className={cn("xl:col-span-8 bg-surface-solid rounded-xl p-4 border border-border-subtle z-40 transition-colors", isScanning && "ring-1 ring-accent/40 opacity-85")}>
                    <div className="flex flex-col md:flex-row flex-wrap items-end gap-3 w-full">
                      <div className="flex-[2] min-w-full md:min-w-[190px] space-y-1.5">
                        <label className="text-xs text-text-muted font-medium block">Target competitor / ID</label>
                        <div className="relative">
                          <AtlasIcon name="my_location" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                          <input
                            value={selectedSource === "manual" ? scanQuery : "Auto-target selected"}
                            onChange={(e) => setScanQuery(e.target.value)}
                            disabled={!isAdmin || selectedSource !== "manual" || isScanning}
                            className="w-full h-9 bg-input-bg text-text-main border border-border-subtle text-[13px] font-medium rounded-lg pl-9 pr-3 outline-none transition-colors focus:border-accent focus:bg-surface-solid disabled:opacity-50"
                            placeholder="e.g. Voodoo or AR12345"
                            type="text"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:flex flex-[3] gap-3 w-full">
                        <div className="flex-[1.5] min-w-[140px] space-y-1.5 relative">
                          <label className="text-xs text-text-muted font-medium block truncate">Target source</label>
                          <div
                            onClick={(e) => {
                              if (!isScanning && isAdmin) {
                                e.stopPropagation();
                                if (activeDropdown !== "source") setSourceSearch("");
                                setActiveDropdown(activeDropdown === "source" ? null : "source");
                              }
                            }}
                            className={cn(
                              "w-full h-9 bg-input-bg text-text-main border border-border-subtle rounded-lg px-3 outline-none transition-colors cursor-pointer flex items-center justify-between gap-2 select-none hover:border-border-strong",
                              activeDropdown === "source" && "border-accent",
                              (!isAdmin || isScanning) && "opacity-50 cursor-not-allowed"
                            )}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <AtlasIcon name="list_alt" size={15} className="text-text-muted hidden sm:block" />
                              <span className="truncate font-medium text-[13px]">{getTargetSourceName()}</span>
                            </span>
                            <AtlasIcon
                              name="expand_more"
                              size={15}
                              className="text-text-muted transition-transform"
                              style={{ transform: activeDropdown === "source" ? "rotate(180deg)" : "rotate(0deg)" }}
                            />
                          </div>
                          <AnimatePresence>
                            {activeDropdown === "source" && isAdmin && (
                              <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 w-full md:w-[500px] mt-1.5 bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-2 z-50">
                                <div className="flex items-center gap-2 bg-input-bg border border-border-subtle rounded-lg px-3 py-1.5 mb-2">
                                  <AtlasIcon name="search" size={15} className="text-text-muted" />
                                  <input
                                    autoFocus
                                    value={sourceSearch}
                                    onChange={(e) => setSourceSearch(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-full bg-transparent text-text-main text-[13px] outline-none placeholder:text-text-muted"
                                    placeholder="Search competitors or lists..."
                                  />
                                  {sourceSearch && (
                                    <button type="button" onClick={() => setSourceSearch("")} className="text-text-muted hover:text-text-main">
                                      <AtlasIcon name="close" size={14} />
                                    </button>
                                  )}
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[280px] overflow-y-auto custom-scrollbar">
                                  <div className="min-w-0">
                                    <div onClick={() => { setSelectedSource("manual"); setSourceSearch(""); setActiveDropdown(null); }} className="px-2.5 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-[13px] font-medium transition-colors flex items-center gap-2">
                                      <AtlasIcon name="edit_note" size={15} className="text-text-muted" />
                                      <span>Manual entry</span>
                                    </div>
                                    <div className="px-2.5 py-1 mt-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted border-b border-border-subtle mb-1">Saved competitors</div>
                                    {savedCompetitors
                                      .filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                      .map(c => (
                                        <div key={`comp_${c.id}`} onClick={() => { setSelectedSource(`comp_${c.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-2.5 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-[13px] font-medium transition-colors flex items-center gap-2 min-w-0">
                                          <AtlasIcon name="domain" size={15} className="text-text-muted" />
                                          <span className="truncate">{c.name}</span>
                                        </div>
                                      ))}
                                    {savedCompetitors.length > 0 && savedCompetitors.filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                                      <div className="px-2.5 py-3 text-xs text-text-muted">No competitors found.</div>
                                    )}
                                  </div>

                                  <div className="min-w-0">
                                    <div className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-text-muted border-b border-border-subtle mb-1">Target lists</div>
                                    {targetLists
                                      .filter(l => (l.name || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                      .map(l => (
                                        <div key={`list_${l.id}`} onClick={() => { setSelectedSource(`list_${l.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-2.5 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-[13px] font-medium transition-colors flex items-center gap-2 min-w-0">
                                          <AtlasIcon name="list_alt" size={15} className="text-text-muted" />
                                          <span className="truncate">{l.name}</span>
                                        </div>
                                      ))}
                                    {targetLists.length > 0 && targetLists.filter(l => (l.name || "").toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                                      <div className="px-2.5 py-3 text-xs text-text-muted">No lists found.</div>
                                    )}
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <div className="flex-[1.5] min-w-[160px] space-y-1.5 relative">
                          <label className="text-xs text-text-muted font-medium block truncate">Email report</label>
                          <div
                            onClick={(e) => {
                              if (!isScanning && isAdmin) {
                                e.stopPropagation();
                                setActiveDropdown(activeDropdown === "email" ? null : "email");
                              }
                            }}
                            className={cn(
                              "w-full h-9 bg-input-bg text-text-main border border-border-subtle rounded-lg px-3 outline-none cursor-pointer flex items-center gap-2 select-none transition-colors hover:border-border-strong",
                              activeDropdown === "email" && "border-accent",
                              selectedEmailList === "custom" && EMAIL_REGEX.test(customReportEmail.trim()) && "border-sem-success/50",
                              (!isAdmin || isScanning) && "opacity-50 cursor-not-allowed"
                            )}
                          >
                            <AtlasIcon name="mail" size={15} className="text-text-muted hidden sm:block" />

                            <div className="flex-1 min-w-0">
                              {selectedEmailList === "custom" && isAdmin ? (
                                <input
                                  autoFocus
                                  type="email"
                                  inputMode="email"
                                  autoComplete="email"
                                  value={customReportEmail}
                                  onChange={(e) => setCustomReportEmail(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      setSelectedEmailList("none");
                                      setCustomReportEmail("");
                                      e.currentTarget.blur();
                                    }
                                  }}
                                  disabled={isScanning}
                                  placeholder="recipient@email.com"
                                  className="w-full bg-transparent text-text-main placeholder:text-text-muted/70 text-[13px] font-medium outline-none disabled:cursor-not-allowed"
                                />
                              ) : (
                                <span className="block truncate font-medium text-[13px]">
                                  {getEmailListName()}
                                </span>
                              )}
                            </div>

                            {selectedEmailList === "custom" && customReportEmail.trim() && (
                              <span title={EMAIL_REGEX.test(customReportEmail.trim()) ? "Valid email" : "Enter a valid email"}>
                                <AtlasIcon
                                  name={EMAIL_REGEX.test(customReportEmail.trim()) ? "check_circle" : "error"}
                                  size={15}
                                  className={EMAIL_REGEX.test(customReportEmail.trim()) ? "text-sem-success" : "text-sem-danger"}
                                />
                              </span>
                            )}

                            <AtlasIcon
                              name="expand_more"
                              size={15}
                              className="text-text-muted transition-transform"
                              style={{ transform: activeDropdown === "email" ? "rotate(180deg)" : "rotate(0deg)" }}
                            />
                          </div>

                          <AnimatePresence>
                            {activeDropdown === "email" && isAdmin && (
                              <motion.div
                                variants={dropDownAnim}
                                initial="hidden"
                                animate="show"
                                exit="exit"
                                onClick={(e) => e.stopPropagation()}
                                className="absolute top-full left-0 w-full mt-1.5 bg-surface-solid border border-border-subtle rounded-xl shadow-lg max-h-[300px] overflow-y-auto custom-scrollbar p-1.5 z-50"
                              >
                                <div
                                  onClick={() => { setSelectedEmailList("none"); setActiveDropdown(null); }}
                                  className={cn(
                                    "px-2.5 py-2 rounded-lg hover:bg-input-bg text-text-main cursor-pointer text-[13px] font-medium transition-colors flex items-center gap-2",
                                    selectedEmailList === "none" && "bg-input-bg"
                                  )}
                                >
                                  <AtlasIcon name="mail_off" size={15} className="text-text-muted" /> Don't send
                                </div>

                                <div
                                  onClick={() => { setSelectedEmailList("custom"); setActiveDropdown(null); }}
                                  className={cn(
                                    "px-2.5 py-2 mt-0.5 rounded-lg hover:bg-input-bg text-text-main cursor-pointer text-[13px] font-medium transition-colors flex items-center gap-2",
                                    selectedEmailList === "custom" && "bg-primary-container text-on-primary-container"
                                  )}
                                >
                                  <AtlasIcon name="alternate_email" size={15} className="text-text-muted" />
                                  <div className="min-w-0">
                                    <div>Custom email</div>
                                    <div className="text-xs font-normal text-text-muted truncate">Type a one-time recipient</div>
                                  </div>
                                </div>

                                {emailLists.length > 0 && (
                                  <>
                                    <div className="px-2.5 py-1 mt-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted border-b border-border-subtle mb-1">Saved contacts</div>
                                    {emailLists.map((emailList) => (
                                      <div
                                        key={emailList.id}
                                        onClick={() => { setSelectedEmailList(emailList.id); setActiveDropdown(null); }}
                                        className={cn(
                                          "px-2.5 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-[13px] font-medium transition-colors truncate flex items-center gap-2",
                                          selectedEmailList?.toString() === emailList.id.toString() && "bg-primary-container text-on-primary-container"
                                        )}
                                      >
                                        <AtlasIcon name="group" size={15} />
                                        <span className="truncate">{emailList.name}</span>
                                      </div>
                                    ))}
                                  </>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>

                      <div className="flex-1 min-w-full md:min-w-[130px] space-y-1.5 relative">
                        <label className="text-xs text-text-muted font-medium block">Unique games</label>
                        <div className={cn("flex items-center bg-input-bg border border-border-subtle rounded-lg transition-colors h-9", (!isAdmin || isMaxAds || isScanning) && "opacity-50 cursor-not-allowed", activeDropdown === "limit" && "border-accent")}>
                          <button type="button" disabled={!isAdmin || isMaxAds || isScanning} onClick={() => setScanLimit(Math.max(1, scanLimit - 10))} className="h-full px-2.5 text-text-muted hover:text-text-main hover:bg-surface-solid rounded-l-lg transition-colors disabled:opacity-50">
                            <AtlasIcon name="remove" size={14} />
                          </button>
                          <input disabled={!isAdmin || isMaxAds || isScanning} value={isMaxAds ? "500" : scanLimit} onChange={(e) => { const val = e.target.value.replace(/\D/g, ""); setScanLimit(val === "" ? "" : Number(val)); }} onBlur={() => { if (!scanLimit || scanLimit < 1) setScanLimit(1); }} className="w-full h-full bg-transparent text-text-main text-center text-[13px] font-medium tabular-nums outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed" type="text" />
                          <button type="button" disabled={!isAdmin || isMaxAds || isScanning} onClick={() => setScanLimit((scanLimit || 0) + 10)} className="h-full px-2.5 text-text-muted hover:text-text-main hover:bg-surface-solid transition-colors disabled:opacity-50">
                            <AtlasIcon name="add" size={14} />
                          </button>
                          <div className="w-px h-full bg-border-subtle" />
                          <button type="button" disabled={!isAdmin || isMaxAds || isScanning} onClick={(e) => { e.stopPropagation(); if (isAdmin && !isMaxAds && !isScanning) setActiveDropdown(activeDropdown === "limit" ? null : "limit"); }} className="h-full px-2 text-text-muted hover:text-text-main hover:bg-surface-solid rounded-r-lg transition-colors disabled:opacity-50 flex items-center justify-center">
                            <AtlasIcon name="arrow_drop_down" size={15} />
                          </button>
                        </div>
                        <AnimatePresence>
                          {activeDropdown === "limit" && isAdmin && !isMaxAds && (
                            <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 w-full md:w-28 mt-1.5 bg-surface-solid border border-border-subtle rounded-xl shadow-lg overflow-hidden p-1.5 z-50 grid grid-cols-3 md:grid-cols-1 gap-1">
                              {[10, 20, 50, 100, 250, 500].map(val => (
                                <button
                                  type="button"
                                  key={val}
                                  onClick={() => { setScanLimit(val); setActiveDropdown(null); }}
                                  className="px-2.5 py-1.5 rounded-lg hover:bg-input-bg text-[13px] font-medium tabular-nums text-center transition-colors"
                                >
                                  {val}
                                </button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <div className="flex gap-2 items-center flex-shrink-0 w-full xl:w-auto">
                        <button
                          type="button"
                          onClick={() => setIsMaxAds(!isMaxAds)}
                          disabled={isScanning}
                          className={cn(
                            "h-9 px-3 rounded-lg font-medium text-xs transition-colors flex items-center justify-center gap-1.5 border disabled:opacity-50 disabled:cursor-not-allowed",
                            isMaxAds
                              ? "bg-primary-container text-on-primary-container border-transparent"
                              : "bg-surface-solid border-border-subtle text-text-main hover:bg-input-bg"
                          )}
                          title="Aim for up to 500 unique games"
                        >
                          <AtlasIcon name="all_inclusive" size={15} /> Max
                        </button>

                        {isScanning ? (
                          <button
                            type="button"
                            onClick={handleCancelScan}
                            className="h-9 flex-1 md:flex-none atlas-badge-danger hover:opacity-90 font-medium px-4 rounded-lg border flex justify-center items-center gap-1.5 text-[13px]"
                          >
                            <AtlasIcon name="cancel" size={15} /> Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleRunScan}
                            disabled={isStartingScan}
                            className="h-9 flex-1 md:flex-none bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg font-medium px-4 rounded-lg transition-colors flex justify-center items-center gap-1.5 text-[13px] disabled:opacity-60"
                          >
                            <AtlasIcon name={isStartingScan ? "progress_activity" : "data_usage"} size={15} className={isStartingScan ? "animate-spin" : ""} />
                            {isStartingScan ? "Starting..." : "Scan"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="xl:col-span-4 bg-surface-solid rounded-xl p-4 border border-border-subtle flex flex-col justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <AtlasIcon name="public" size={16} className="text-text-muted" />
                        <h2 className="text-[13px] font-semibold text-text-main">Country availability</h2>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">Inspect storefront availability across 176 regions</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1 min-w-0">
                        <input
                          value={countryPackage}
                          onChange={(event) => setCountryPackage(event.target.value.trimStart())}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && isAdmin && countryPackage.trim() && !isCountryScanRunning) {
                              handleStartCountryScan();
                            }
                          }}
                          placeholder="com.publisher.game"
                          className="w-full h-9 bg-input-bg text-text-main border border-border-subtle rounded-lg px-3 outline-none focus:border-accent focus:bg-surface-solid font-mono text-xs"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleViewSavedCountryScan()}
                        disabled={!countryPackage.trim()}
                        title="View saved scan"
                        className="h-9 px-3 rounded-lg border border-border-subtle bg-surface-solid text-text-main text-xs font-medium hover:bg-input-bg disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0"
                      >
                        <AtlasIcon name="history" size={14} className="text-text-muted" />
                        Saved
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStartCountryScan()}
                        disabled={!countryPackage.trim() || isCountryScanRunning}
                        className="h-9 px-3 rounded-lg border border-border-strong bg-input-bg hover:bg-surface-solid text-text-main text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0 transition-colors"
                      >
                        <AtlasIcon
                          name={isCountryScanRunning ? "progress_activity" : "travel_explore"}
                          size={14}
                          className={isCountryScanRunning ? "animate-spin" : ""}
                        />
                        {isCountryScanRunning ? "Scanning" : "Check"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <KpiStrip
                items={[
                  {
                    label: "Last scan",
                    value: lastScanTime,
                    note: "Most recent run"
                  },
                  {
                    label: "Competitors",
                    value: displayStats.competitors,
                    note: viewMode === "latest" ? "In latest scan" : "Tracked groups",
                    badge: <AtlasIcon name="arrow_forward" size={13} className="text-text-muted" />,
                    onClick: () => openStatPanel("competitors")
                  },
                  {
                    label: "Publishers",
                    value: displayStats.accounts,
                    note: viewMode === "latest" ? "In latest scan" : "Discovered accounts",
                    badge: <AtlasIcon name="arrow_forward" size={13} className="text-text-muted" />,
                    onClick: () => openStatPanel("publishers")
                  },
                  {
                    label: "Games",
                    value: displayStats.games,
                    note: viewMode === "latest" ? "In latest scan" : "Unique titles",
                    badge: <AtlasIcon name="arrow_forward" size={13} className="text-text-muted" />,
                    onClick: () => openStatPanel("games")
                  }
                ]}
              />

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <TrendingTargets
                  sortedTrending={sortedTrending}
                  trendingSort={trendingSort}
                  onSort={setTrendingSort}
                  onGameClick={handleGameClick}
                  viewMode={viewMode}
                  latestScanTargetName={latestScanTargetName}
                />
                <LiveDirectory
                  visibleCompetitorTree={visibleCompetitorTree}
                  viewMode={viewMode}
                  expandedNodes={expandedNodes}
                  isAdmin={isAdmin}
                  onToggleNode={toggleNode}
                  onGameClick={handleGameClick}
                  onNukeCompetitorData={handleNukeCompetitorData}
                  onNukePublisherData={handleNukePublisherData}
                  onDeleteGame={handleDeleteGame}
                  isScanning={isScanning}
                />
              </div>
            </div>
          )}

          {/* COUNTRY SCAN LIBRARY TAB */}
          {activeTab === "countryScans" && (
            <div className="atlas-page-enter flex flex-col w-full gap-5 max-w-7xl mx-auto">
              <PageHeader
                title="Country Scans"
                subtitle="Saved Google Play country availability snapshots for review and rescanning."
                actions={
                  <span className="text-xs font-mono text-text-muted tabular-nums">
                    {countryScanLibrary.length} saved {countryScanLibrary.length === 1 ? "package" : "packages"}
                  </span>
                }
              />

              <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 pb-4 border-b border-border-subtle">
                <div className="flex-1 flex flex-col sm:flex-row gap-2">
                  <div className="flex-1 relative">
                    <AtlasIcon name="deployed_code" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                    <input
                      value={countryPackage}
                      onChange={(event) => setCountryPackage(event.target.value.trimStart())}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && isAdmin && countryPackage.trim() && !isCountryScanRunning) {
                          handleStartCountryScan();
                        }
                      }}
                      placeholder="Scan a package, e.g. com.publisher.game"
                      className="w-full h-9 bg-surface-solid text-text-main border border-border-subtle rounded-lg pl-9 pr-3 outline-none focus:border-accent font-mono text-xs"
                    />
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleStartCountryScan()}
                      disabled={!countryPackage.trim() || isCountryScanRunning}
                      className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 shrink-0"
                    >
                      <AtlasIcon name={isCountryScanRunning ? "progress_activity" : "travel_explore"} size={15} className={isCountryScanRunning ? "animate-spin" : ""} />
                      {isCountryScanRunning ? "Scanning..." : "Scan package"}
                    </button>
                  )}
                </div>

                <div className="relative w-full lg:w-80">
                  <AtlasIcon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    value={countryLibrarySearch}
                    onChange={(event) => setCountryLibrarySearch(event.target.value)}
                    placeholder="Filter saved scans..."
                    className="w-full h-9 bg-surface-solid text-text-main border border-border-subtle rounded-lg pl-9 pr-8 outline-none focus:border-accent text-[13px]"
                  />
                  {countryLibrarySearch && (
                    <button
                      type="button"
                      onClick={() => setCountryLibrarySearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md text-text-muted hover:text-text-main hover:bg-input-bg flex items-center justify-center"
                      aria-label="Clear country scan search"
                    >
                      <AtlasIcon name="close" size={14} />
                    </button>
                  )}
                </div>
              </div>

              {filteredCountryScanLibrary.length === 0 ? (
                <div className="bg-surface-solid border border-border-subtle rounded-xl min-h-[260px] flex flex-col items-center justify-center text-center p-8">
                  <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle text-text-muted flex items-center justify-center">
                    <AtlasIcon name="public_off" size={18} />
                  </div>
                  <h2 className="text-sm font-semibold text-text-main mt-3">
                    {countryScanLibrary.length === 0 ? "No country scans saved yet" : "No saved scans match your search"}
                  </h2>
                  <p className="text-[13px] text-text-muted mt-1 max-w-md">
                    {countryScanLibrary.length === 0
                      ? "Run a country availability scan and the package will appear here for review and rescanning."
                      : "Try searching by game title, developer, or Android package name."}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {filteredCountryScanLibrary.map(item => {
                    const counts = item.counts || {};
                    const runningThisPackage = isCountryScanRunning && countryScanJob?.packageName === item.packageName;

                    return (
                      <div
                        key={item.packageName}
                        className={cn(
                          "bg-surface-solid border rounded-xl p-4 transition-colors",
                          runningThisPackage ? "border-accent" : "border-border-subtle"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle text-text-muted flex items-center justify-center flex-shrink-0">
                            <AtlasIcon name="sports_esports" size={18} />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                  <h2 className="text-sm font-semibold text-text-main truncate">
                                    {item.appTitle || item.packageName}
                                  </h2>
                                  <PaidBadge item={item} compact showPrice={false} />
                                </div>
                                {item.developer && (
                                  <p className="text-xs text-text-muted mt-0.5 truncate">{item.developer}</p>
                                )}
                                {(item.competitors || []).length > 0 && (
                                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                    {(item.competitors || []).map(name => (
                                      <Badge key={name} tone="neutral" title={`Atlas competitor: ${name}`}>
                                        {name}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void AtlasFeedback.copy(item.packageName, "Copied package ID")}
                                  title="Copy package ID"
                                  className="text-xs text-text-muted hover:text-link font-mono mt-1.5 truncate inline-flex items-center gap-1 max-w-full transition-colors"
                                >
                                  <span className="truncate">{item.packageName}</span>
                                  <AtlasIcon name="content_copy" size={12} className="opacity-70" />
                                </button>
                              </div>

                              {runningThisPackage && (
                                <Badge tone="accent">
                                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                                  Scanning
                                </Badge>
                              )}
                            </div>

                            <div className="flex flex-wrap gap-1.5 mt-3">
                              {[
                                ["live", Number(counts.live) || 0],
                                ["pre_register", Number(counts.pre_register) || 0],
                                ["early_access", Number(counts.early_access) || 0],
                                ["unavailable", Number(counts.unavailable) || 0],
                                ["unknown", Number(counts.unknown) || 0]
                              ].filter(([, count]) => count > 0).map(([state, count]) => {
                                const meta = getCountryStateMeta(state);
                                return (
                                  <span key={state} className={cn("px-2 py-0.5 rounded-md border text-xs font-medium tabular-nums", meta.className)}>
                                    {count} {meta.label}
                                  </span>
                                );
                              })}
                            </div>

                            <div className="mt-3.5 pt-3 border-t border-border-subtle flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                              <div className="text-xs text-text-muted tabular-nums">
                                <span>{item.completedAt ? new Date(item.completedAt).toLocaleDateString() : "No completion time"}</span>
                                <span className="mx-1.5">·</span>
                                <span>{item.scanCount || 1} {(item.scanCount || 1) === 1 ? "scan" : "scans"}</span>
                                {item.totalCountries ? (
                                  <>
                                    <span className="mx-1.5">·</span>
                                    <span>{item.totalCountries} regions</span>
                                  </>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <a
                                  href={"https://play.google.com/store/apps/details?id=" + encodeURIComponent(item.packageName)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="w-8 h-8 rounded-lg border border-border-subtle bg-surface-solid text-text-muted hover:text-text-main hover:bg-input-bg flex items-center justify-center transition-colors"
                                  title="Open on Google Play"
                                >
                                  <AtlasIcon name="open_in_new" size={14} />
                                </a>
                                <button
                                  type="button"
                                  disabled={viewingCountryPkg === item.packageName}
                                  onClick={() => handleViewSavedCountryScan(item.packageName)}
                                  className="h-8 px-3 rounded-lg border border-border-subtle bg-surface-solid text-text-main text-xs font-medium hover:bg-input-bg disabled:opacity-60 flex items-center gap-1.5"
                                >
                                  <AtlasIcon
                                    name={viewingCountryPkg === item.packageName ? "progress_activity" : "visibility"}
                                    size={14}
                                    className={viewingCountryPkg === item.packageName ? "animate-spin" : ""}
                                  />
                                  {viewingCountryPkg === item.packageName ? "Loading" : "View"}
                                </button>
                                {isAdmin && (
                                  <button
                                    type="button"
                                    onClick={() => handleStartCountryScan(item.packageName)}
                                    disabled={isCountryScanRunning}
                                    className="h-8 px-3 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-medium disabled:opacity-50 flex items-center gap-1.5"
                                  >
                                    <AtlasIcon name="refresh" size={14} />
                                    Rescan
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* DATABASE TARGETS TAB */}
          {activeTab === "automated" && (
            <div className="atlas-page-enter flex flex-col w-full gap-5 max-w-7xl mx-auto">
              <PageHeader
                title="Targets"
                subtitle={isAdmin ? "Manage saved competitors and reusable batch lists." : "View saved competitor targets and active batch lists."}
              />

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {isAdmin && (
                  <div className="lg:col-span-4 space-y-5">
                    <div className="bg-surface-solid border border-border-subtle rounded-xl p-5">
                      <h2 className="text-[15px] font-semibold text-text-main mb-4 flex items-center gap-2">
                        <AtlasIcon name="person_add" size={17} className="text-text-muted" />
                        Save Competitor
                      </h2>
                      <form onSubmit={handleSaveCompetitor} className="space-y-3">
                        <input value={newCompName} disabled={savingCompetitor} onChange={(e) => setNewCompName(e.target.value)} className="w-full h-9 bg-input-bg text-text-main border border-border-subtle text-[13px] rounded-lg px-3 outline-none focus:border-accent focus:bg-surface-solid transition-colors disabled:opacity-60" placeholder="e.g. Playmax" type="text" />
                        <input value={newCompAdsId} disabled={savingCompetitor} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full h-9 bg-input-bg text-text-main border border-border-subtle font-mono text-xs rounded-lg px-3 outline-none focus:border-accent focus:bg-surface-solid transition-colors disabled:opacity-60" placeholder="AR123456789012345" type="text" />
                        <button type="submit" disabled={savingCompetitor} className="w-full h-9 bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg font-medium px-4 rounded-lg transition-colors disabled:opacity-50 text-[13px] inline-flex items-center justify-center gap-1.5">
                          {savingCompetitor && <AtlasIcon name="progress_activity" size={14} className="animate-spin" />}
                          <span>{savingCompetitor ? "Saving..." : "Save Entity"}</span>
                        </button>
                      </form>
                    </div>

                    <div className="bg-surface-solid border border-border-subtle rounded-xl p-5">
                      <h2 className="text-[15px] font-semibold text-text-main mb-4 flex items-center gap-2">
                        <AtlasIcon name="format_list_bulleted_add" size={17} className="text-text-muted" />
                        Create Batch List
                      </h2>
                      <form onSubmit={handleCreateList} className="space-y-3">
                        <input value={newListName} disabled={savingList} onChange={(e) => setNewListName(e.target.value)} className="w-full h-9 bg-input-bg text-text-main border border-border-subtle text-[13px] rounded-lg px-3 outline-none focus:border-accent focus:bg-surface-solid transition-colors disabled:opacity-60" placeholder="e.g. Tier 1 Tracking" type="text" />
                        <textarea value={newListTargets} disabled={savingList} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-xs rounded-lg p-3 outline-none focus:border-accent focus:bg-surface-solid transition-colors resize-none disabled:opacity-60" placeholder="AR123...&#10;AR456..." />
                        <button type="submit" disabled={savingList} className="w-full h-9 bg-surface-solid border border-border-subtle text-text-main hover:bg-input-bg font-medium px-4 rounded-lg transition-colors disabled:opacity-50 text-[13px] inline-flex items-center justify-center gap-1.5">
                          {savingList && <AtlasIcon name="progress_activity" size={14} className="animate-spin" />}
                          <span>{savingList ? "Saving..." : "Save List"}</span>
                        </button>
                      </form>
                    </div>
                  </div>
                )}

                <div className={cn("space-y-5", isAdmin ? "lg:col-span-8" : "lg:col-span-12")}>
                  <div className="bg-surface-solid border border-border-subtle rounded-xl p-5">
                    <h2 className="text-[15px] font-semibold text-text-main mb-4 flex items-center gap-2">
                      <AtlasIcon name="person" size={16} className="text-text-muted" />
                      Saved competitors
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {savedCompetitors.map((comp) => (
                        <div key={comp.id} className="border border-border-subtle bg-input-bg/35 rounded-lg p-3.5 flex items-center justify-between group">
                          <div className="min-w-0 pr-3">
                            <h3 className="text-[13px] font-semibold text-text-main truncate">{comp.name}</h3>
                            <button
                              type="button"
                              onClick={() => void AtlasFeedback.copy(comp.ads_id, "Copied Advertiser ID")}
                              title="Copy Advertiser ID"
                              className="font-mono text-xs text-text-muted hover:text-link mt-1 truncate inline-flex items-center gap-1 max-w-full transition-colors"
                            >
                              <span className="truncate">{comp.ads_id}</span>
                              <AtlasIcon name="content_copy" size={12} className="opacity-70" />
                            </button>
                          </div>
                          {isAdmin && (
                            <button
                              type="button"
                              disabled={deletingTargetKey === `comp:${comp.id}`}
                              onClick={() => handleDeleteCompetitor(comp.id)}
                              className="w-8 h-8 rounded-lg text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center transition-colors opacity-65 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 disabled:opacity-50"
                            >
                              <AtlasIcon name={deletingTargetKey === `comp:${comp.id}` ? "progress_activity" : "delete"} size={15} className={deletingTargetKey === `comp:${comp.id}` ? "animate-spin" : ""} />
                            </button>
                          )}
                        </div>
                      ))}
                      {savedCompetitors.length === 0 && (
                        <div className="col-span-full text-[13px] text-text-muted py-6 text-center border border-dashed border-border-subtle rounded-lg">
                          No competitors saved.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-surface-solid border border-border-subtle rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <AtlasIcon name="view_list" size={16} className="text-text-muted" />
                      <div>
                        <h2 className="text-[15px] font-semibold text-text-main">Batch lists</h2>
                        <p className="text-xs text-text-muted">Reusable groups of advertiser IDs for multi-target scans.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {targetLists.map((list) => (
                        <div
                          key={list.id}
                          className="group border border-border-subtle bg-input-bg/35 rounded-lg p-3.5"
                        >
                          <div className="flex items-start justify-between gap-2 mb-2.5">
                            <div className="min-w-0">
                              <h3 className="text-[13px] font-semibold text-text-main truncate">{list.name}</h3>
                              <p className="text-xs text-text-muted mt-0.5 tabular-nums">
                                {(list.targets?.length || 0)} {(list.targets?.length || 0) === 1 ? "target" : "targets"}
                              </p>
                            </div>

                            {isAdmin && (
                              <button
                                type="button"
                                disabled={deletingTargetKey === `list:${list.id}`}
                                onClick={() => handleDeleteList(list.id)}
                                className="w-7 h-7 rounded-md text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center opacity-65 group-hover:opacity-100 focus:opacity-100 transition-colors flex-shrink-0 disabled:opacity-50"
                                title="Delete batch list"
                                aria-label={`Delete ${list.name}`}
                              >
                                <AtlasIcon name={deletingTargetKey === `list:${list.id}` ? "progress_activity" : "delete"} size={14} className={deletingTargetKey === `list:${list.id}` ? "animate-spin" : ""} />
                              </button>
                            )}
                          </div>

                          <div className="bg-surface-solid border border-border-subtle rounded-md p-2.5 max-h-28 overflow-y-auto custom-scrollbar">
                            {(list.targets || []).map((target, index) => (
                              <div key={`${target}-${index}`} className="py-0.5 text-xs text-text-muted font-mono truncate">
                                {target}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {targetLists.length === 0 && (
                        <div className="col-span-full rounded-lg border border-dashed border-border-subtle px-5 py-8 text-center">
                          <div className="w-9 h-9 rounded-lg bg-input-bg flex items-center justify-center mx-auto mb-2 text-text-muted">
                            <AtlasIcon name="playlist_add" size={17} />
                          </div>
                          <p className="text-[13px] font-medium text-text-main">No batch lists yet</p>
                          <p className="text-xs text-text-muted mt-0.5">Create one to scan multiple advertisers together.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SETTINGS TAB (ADMIN ONLY) */}
          {activeTab === "settings" && isAdmin && (
            <div className="atlas-page-enter flex flex-col w-full gap-5 max-w-3xl mx-auto">
              <PageHeader
                title="System Settings"
                subtitle="Configure Atlas integrations and workspace preferences."
              />

              <form onSubmit={handleSaveSettings} className="space-y-4">
                <div className="bg-surface-solid border border-border-subtle rounded-xl p-5 space-y-4">
                  <h3 className="text-[15px] font-semibold text-text-main flex items-center gap-2">
                    <AtlasIcon name="cloud_sync" size={17} className="text-text-muted" />
                    Cloud configuration
                  </h3>

                  <div className="space-y-1.5">
                    <label className="text-xs text-text-muted block font-medium">Google Spreadsheet ID</label>
                    <input
                      type="text"
                      value={settings.google_sheet_id}
                      onChange={(e) => setSettings(s => ({ ...s, google_sheet_id: e.target.value }))}
                      className="w-full h-9 bg-input-bg text-text-main border border-border-subtle font-mono text-xs rounded-lg px-3 outline-none focus:border-accent focus:bg-surface-solid transition-colors"
                      placeholder="e.g. 1tQysvSfu..."
                    />
                  </div>
                </div>

                <div className="flex flex-col-reverse sm:flex-row items-center justify-between pt-1 gap-3">
                  {settingsStatus ? (
                    <span className={cn("text-xs font-medium px-3 py-1.5 rounded-lg border w-full sm:w-auto text-center", settingsStatus.includes("success") ? "atlas-badge-success" : "atlas-badge-danger")}>
                      {settingsStatus}
                    </span>
                  ) : <span />}
                  <button
                    type="submit"
                    disabled={isSavingSettings}
                    className="w-full sm:w-auto h-9 bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg font-medium px-5 rounded-lg transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 text-[13px]"
                  >
                    <AtlasIcon name={isSavingSettings ? "sync" : "save"} size={15} className={isSavingSettings ? "animate-spin" : ""} />
                    {isSavingSettings ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* SUMMARY MARKET PULSE TAB */}
          {activeTab === "summary" && (
            <Suspense
              fallback={
                <div className="py-16 text-center text-xs text-text-muted flex items-center justify-center gap-2">
                  <AtlasIcon name="progress_activity" size={16} className="animate-spin" />
                  <span>Loading Summary...</span>
                </div>
              }
            >
              <MarketSummaryView
                onOpenCountryScan={(pkg) => handleViewSavedCountryScan(pkg)}
                onSearchInPlayStore={(query) => {
                  setPlayStoreSearchQuery(query);
                  setActiveTab("playStore");
                }}
                isAdmin={isAdmin}
              />
            </Suspense>
          )}

          {/* PLAY STORE INTELLIGENCE TAB */}
          {activeTab === "playStore" && (
            <PlayStoreIntelligenceView
              onOpenCountryScan={(pkg) => handleViewSavedCountryScan(pkg)}
              initialSearchQuery={playStoreSearchQuery}
              isAdmin={isAdmin}
            />
          )}

          {/* AMAZON APPSTORE INTELLIGENCE TAB */}
          {activeTab === "amazon" && (
            <Suspense
              fallback={
                <div className="py-16 text-center text-xs text-text-muted flex items-center justify-center gap-2">
                  <AtlasIcon name="progress_activity" size={16} className="animate-spin" />
                  <span>Loading Amazon Appstore...</span>
                </div>
              }
            >
              <AmazonIntelligenceView
                isAdmin={isAdmin}
              />
            </Suspense>
          )}

        </main>
      </div>

      {/* MOBILE BOTTOM NAVIGATION */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-surface-solid/95 backdrop-blur-md border-t border-border-subtle px-2 pb-[env(safe-area-inset-bottom)]">
        <div className="h-16 flex items-center justify-around">
          {[
            { id: "summary", icon: "monitoring", label: "Summary" },
            { id: "playStore", customIcon: GooglePlayIcon, label: "Play Store" },
            { id: "amazon", customIcon: AmazonAppstoreIcon, label: "Amazon" },
            { id: "automated", icon: "track_changes", label: "Targets" },
            ...(isAdmin
              ? [
                  { id: "dashboard", icon: "dashboard", label: "Dashboard" },
                  { id: "countryScans", icon: "public", label: "Countries" },
                  { id: "settings", icon: "settings", label: "Settings" }
                ]
              : [])
          ].map((tab) => (
            <button key={`mobile-${tab.id}`} type="button" onClick={() => setActiveTab(tab.id)} className="flex flex-col items-center gap-1 min-w-[56px]">
              <span className={cn(
                "w-11 h-7 rounded-lg flex items-center justify-center transition-colors",
                activeTab === tab.id ? "bg-primary-container text-on-primary-container" : "text-text-muted"
              )}>
                {tab.customIcon ? (
                  <tab.customIcon className="w-[18px] h-[18px] flex-shrink-0" />
                ) : (
                  <AtlasIcon name={tab.icon} size={18} />
                )}
              </span>
              <span className={cn("text-[11px] font-medium truncate", activeTab === tab.id ? "text-text-main" : "text-text-muted")}>{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* EXPANDABLE DASHBOARD STAT LISTS */}
      <AnimatePresence>
        {activeStatPanel && (() => {
          const meta = {
            competitors: {
              title: "Competitors",
              subtitle: "Tracked competitor groups",
              icon: "corporate_fare",
              total: statCompetitors.length,
              placeholder: "Search competitors or advertiser IDs...",
            },
            publishers: {
              title: "Publishers",
              subtitle: "Publisher accounts discovered across groups",
              icon: "account_box",
              total: statPublishers.length,
              placeholder: "Search publishers or competitor groups...",
            },
            games: {
              title: "Games",
              subtitle: "Unique games discovered by Atlas",
              icon: "sports_esports",
              total: statGames.length,
              placeholder: "Search games, publishers, or package names...",
            },
          }[activeStatPanel];

          return (
            <div className="fixed inset-0 z-[115] flex items-center justify-center p-3 sm:p-5">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                onClick={closeStatPanel}
                className="absolute inset-0 bg-black/60"
              />

              <motion.div
                initial={{ opacity: 0, scale: 0.985, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.985, y: 8 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="relative z-10 w-full max-w-4xl h-[82vh] md:h-[78vh] bg-surface-solid border border-border-subtle rounded-xl shadow-xl overflow-hidden flex flex-col will-change-transform"
              >
                <div className="p-4 sm:p-5 border-b border-border-subtle bg-surface-solid flex-shrink-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center flex-shrink-0 text-text-muted">
                        <AtlasIcon name={meta.icon} size={20} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="text-lg font-semibold text-text-main tracking-tight">{meta.title}</h2>
                          <Badge tone="neutral">{meta.total}</Badge>
                          {viewMode === "latest" && <Badge tone="success">Latest scan</Badge>}
                        </div>
                        <p className="text-xs text-text-muted mt-0.5 truncate">{meta.subtitle}</p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={closeStatPanel}
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main transition-colors flex-shrink-0"
                      aria-label={`Close ${meta.title} list`}
                    >
                      <AtlasIcon name="close" size={18} />
                    </button>
                  </div>

                  <div className="mt-3.5 flex items-center gap-2 bg-input-bg border border-border-subtle rounded-lg px-3 h-9 focus-within:border-accent focus-within:bg-surface-solid transition-colors">
                    <AtlasIcon name="search" size={15} className="text-text-muted" />
                    <input
                      autoFocus
                      value={statPanelSearch}
                      onChange={(event) => setStatPanelSearch(event.target.value)}
                      placeholder={meta.placeholder}
                      className="w-full bg-transparent text-text-main placeholder:text-text-muted/70 outline-none text-[13px]"
                    />
                    {statPanelSearch && (
                      <button type="button" onClick={() => setStatPanelSearch("")} className="text-text-muted hover:text-text-main flex-shrink-0">
                        <AtlasIcon name="close" size={15} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar divide-y divide-border-subtle bg-surface-solid">
                  {filteredStatItems.length === 0 ? (
                    <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center text-text-muted px-6">
                      <AtlasIcon name="search_off" size={28} className="opacity-45 mb-2" />
                      <p className="text-[13px] font-semibold text-text-main">No matches found</p>
                      <p className="text-xs mt-1">Try a different search term.</p>
                    </div>
                  ) : activeStatPanel === "competitors" ? (
                    filteredStatItems.map((comp) => (
                      <div key={`stat-comp-${comp.id ?? comp.name}`} className="flex items-center gap-3 px-4 py-3 hover:bg-input-bg/40 transition-colors">
                        <div className="w-9 h-9 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted flex-shrink-0">
                          <AtlasIcon name="corporate_fare" size={17} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-[13px] font-semibold text-text-main truncate">{comp.name || "Unnamed Competitor"}</h3>
                          <p className="font-mono text-xs text-text-muted truncate mt-0.5">{comp.ads_id || "No advertiser ID"}</p>
                        </div>
                        <div className="hidden sm:flex items-center gap-2 flex-shrink-0 text-xs text-text-muted tabular-nums">
                          <span>{comp.publisherCount} pubs</span>
                          <span>·</span>
                          <span>{comp.gameCount} games</span>
                        </div>
                      </div>
                    ))
                  ) : activeStatPanel === "publishers" ? (
                    filteredStatItems.map((publisher, index) => (
                      <div key={`stat-pub-${publisher.competitorId}-${publisher.id ?? publisher.publisher_name}-${index}`} className="flex items-center gap-3 px-4 py-3 hover:bg-input-bg/40 transition-colors">
                        <div className="w-9 h-9 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center text-text-muted flex-shrink-0">
                          <AtlasIcon name="account_box" size={17} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-[13px] font-semibold text-text-main truncate">{publisher.publisher_name || "Unknown Publisher"}</h3>
                          <p className="text-xs text-text-muted truncate mt-0.5">
                            Group: <span className="text-text-main font-medium">{publisher.competitorName || "Unknown"}</span>
                          </p>
                        </div>
                        <div className="hidden sm:flex items-center gap-2 flex-shrink-0 text-xs text-text-muted tabular-nums">
                          <span>{publisher.totalGames} games</span>
                          <span>·</span>
                          <span>{formatInstalls(publisher.totalInstalls)}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    filteredStatItems.map((game) => (
                      <button
                        type="button"
                        key={`stat-game-${getGameIdentity(game)}`}
                        onClick={() => openGameFromStatPanel(game)}
                        className="w-full text-left group flex items-center gap-3 px-4 py-3 hover:bg-input-bg/50 transition-colors"
                      >
                        <div className="w-10 h-10 rounded-lg overflow-hidden bg-input-bg border border-border-subtle flex items-center justify-center flex-shrink-0 text-text-muted">
                          {game.icon ? <img loading="lazy" decoding="async" src={game.icon} alt={game.title || "Game"} className="w-full h-full object-cover" /> : <AtlasIcon name="sports_esports" size={18} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-[13px] font-semibold text-text-main truncate">{game.title || "Untitled Game"}</h3>
                          <p className="text-xs text-text-muted truncate mt-0.5">{game.publisher_name || "Unknown Publisher"}</p>
                          <p className="font-mono text-xs text-text-muted/80 truncate hidden md:block">{game.package_name}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          {Number(game.ad_count) > 0 && (
                            <Badge tone="accent">
                              {viewMode === "latest" ? `+${game.ad_count} Ads` : `${game.ad_count} Detections`}
                            </Badge>
                          )}
                          <div className="flex items-center gap-2 text-xs text-text-muted tabular-nums">
                            {getInstallCount(game) > 0 && <span>{game.installs || formatInstalls(getInstallCount(game))}</span>}
                            {getAgeText(getGameReleaseValue(game)) && <span>{getAgeText(getGameReleaseValue(game))}</span>}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <div className="flex-shrink-0 px-4 py-2.5 border-t border-border-subtle bg-surface-glass flex items-center justify-between gap-3 text-xs text-text-muted">
                  <span className="tabular-nums">Showing {filteredStatItems.length} of {meta.total}</span>
                  {activeStatPanel === "games" && <span className="hidden sm:block">Click a game to open details</span>}
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {isDrawerOpen && selectedGame && (
          <UniversalGameDetailDrawer
            game={selectedGame}
            onClose={closeDrawer}
            onSelectGame={(sibling) => setSelectedGame(sibling)}
            onRefreshTelemetry={handleRefreshGameTelemetry}
            isRefreshing={telemetryRefreshingPkg === selectedGame.package_name}
            onOpenCountryScan={(pkg) => handleStartCountryScan(pkg)}
            allGames={trending}
            isAdmin={isAdmin}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {countryScanModalOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-5">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
              onClick={() => setCountryScanModalOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.985, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.985, y: 8 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="relative w-full max-w-5xl h-[88vh] max-h-[860px] bg-surface-solid border border-border-subtle rounded-xl shadow-xl overflow-hidden flex flex-col"
            >
              <div className="px-5 py-4 border-b border-border-subtle flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AtlasIcon name="public" size={18} className="text-text-muted" />
                    <h2 className="text-base font-semibold text-text-main">Country availability scan</h2>
                  </div>
                  <p className="text-xs text-text-muted mt-1 font-mono truncate">
                    {countryScanData?.scan?.packageName || (isCountryScanRunning ? countryScanJob.packageName : countryPackage || "Package")}
                  </p>
                  {countryScanData?.scan?.appTitle && (
                    <div className="mt-1 flex items-center gap-2 min-w-0">
                      <p className="text-xs text-text-muted truncate">
                        {countryScanData.scan.appTitle}{countryScanData.scan.developer ? " · " + countryScanData.scan.developer : ""}
                      </p>
                      <PaidBadge item={countryScanData.scan} compact showPrice={false} />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setCountryScanModalOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main flex items-center justify-center transition-colors"
                >
                  <AtlasIcon name="close" size={18} />
                </button>
              </div>

              {countryScanLoading ? (
                <div className="flex-1 flex items-center justify-center p-6">
                  <div className="w-full max-w-md text-center">
                    <div className="w-12 h-12 rounded-xl bg-input-bg border border-border-subtle text-text-muted flex items-center justify-center mx-auto">
                      <AtlasIcon name="database" size={22} />
                    </div>
                    <h3 className="text-base font-semibold text-text-main mt-4">Loading country results</h3>
                    <p className="text-[13px] text-text-muted mt-1">
                      Fetching the latest storefront snapshot and previous-scan comparison.
                    </p>
                    <div className="mt-5 h-1.5 bg-input-bg rounded-full overflow-hidden">
                      <motion.div
                        key={countryPackage}
                        initial={{ width: "8%" }}
                        animate={{ width: "88%" }}
                        transition={{ duration: 4.5, ease: [0.22, 1, 0.36, 1] }}
                        className="h-full bg-btn-primary rounded-full"
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
                      <span>Loading saved scan...</span>
                      <span className="font-mono">{countryPackage}</span>
                    </div>
                  </div>
                </div>
              ) : isCountryScanRunning && !countryScanData && !countryScanError ? (
                <div className="flex-1 flex items-center justify-center p-6">
                  <div className="w-full max-w-md text-center">
                    <div className="w-12 h-12 rounded-xl bg-input-bg border border-border-subtle text-accent flex items-center justify-center mx-auto">
                      <AtlasIcon name="progress_activity" size={22} className="animate-spin" />
                    </div>
                    <h3 className="text-base font-semibold text-text-main mt-4">Scanning Play storefronts</h3>
                    <p className="text-[13px] text-text-muted mt-1">
                      {countryScanJob.currentCountryName || countryScanJob.currentCountry || "Starting country scan..."}
                    </p>
                    <div className="flex items-center justify-between text-xs text-text-muted mt-5 tabular-nums">
                      <span>{countryScanJob.checked || 0} checked</span>
                      <span>{countryScanJob.total || 0} total</span>
                    </div>
                    <div className="mt-2 h-1.5 bg-input-bg rounded-full overflow-hidden">
                      <div
                        className="h-full bg-btn-primary rounded-full transition-all duration-300"
                        style={{ width: Math.min(100, ((countryScanJob.checked || 0) / Math.max(1, countryScanJob.total || 1)) * 100) + "%" }}
                      />
                    </div>
                    <p className="text-xs text-text-muted mt-3">Results are saved by package name even if the app is not in the directory.</p>
                  </div>
                </div>
              ) : countryScanError ? (
                <div className="flex-1 flex items-center justify-center p-6">
                  <div className="max-w-lg text-center">
                    <AtlasIcon name="error" size={28} className="text-sem-danger mx-auto" />
                    <h3 className="text-sm font-semibold text-text-main mt-3">Country scan unavailable</h3>
                    <p className="text-[13px] text-text-muted mt-1">{countryScanError}</p>
                  </div>
                </div>
              ) : countryScanData ? (
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                  <div className="px-5 py-4 border-b border-border-subtle">
                    <div className="mb-3.5 rounded-lg border border-border-subtle bg-input-bg/50 px-3.5 py-2.5 flex items-start gap-2.5">
                      <AtlasIcon name="public" size={16} className="text-text-muted mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-text-main">{countryScanSummary}</p>
                        {countryScanData.previousScan && (
                          <p className="text-xs text-text-muted mt-0.5">
                            {(countryScanData.changes?.length || 0) === 0
                              ? "No country availability changes since the previous scan."
                              : `${countryScanData.changes.length} country ${countryScanData.changes.length === 1 ? "status changed" : "statuses changed"} since the previous scan.`}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      {["live", "pre_register", "early_access", "unavailable", "unknown"].map(state => {
                        const meta = getCountryStateMeta(state);
                        const count = countryScanData.scan?.counts?.[state] || 0;
                        return (
                          <button
                            type="button"
                            key={state}
                            onClick={() => setCountryScanFilter(state)}
                            className={cn(
                              "rounded-lg border p-3 text-left transition-colors",
                              meta.className,
                              countryScanFilter === state && "ring-2 ring-accent/35"
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium truncate">{meta.label}</span>
                              <AtlasIcon name={meta.icon} size={14} />
                            </div>
                            <div className="text-xl font-semibold mt-1 tabular-nums">{count}</div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="text-xs text-text-muted">
                        Last scanned {countryScanData.scan?.completedAt ? new Date(countryScanData.scan.completedAt).toLocaleString() : "—"}
                        {countryScanData.previousScan ? " · compared with previous scan" : " · first saved scan"}
                      </div>
                      <div className="flex items-center gap-2">
                        {(countryScanData.changes?.length || 0) > 0 && (
                          <button
                            type="button"
                            onClick={() => setCountryScanFilter("changed")}
                            className="h-8 px-3 rounded-lg atlas-badge-warning border text-xs font-medium"
                          >
                            {countryScanData.changes.length} changes
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => handleStartCountryScan(countryScanData.scan.packageName)}
                            className="h-8 px-3 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-medium flex items-center gap-1.5"
                          >
                            <AtlasIcon name="refresh" size={14} />
                            Scan again
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="px-5 py-2.5 border-b border-border-subtle flex items-center">
                    <div className="inline-flex items-center gap-1 bg-input-bg border border-border-subtle rounded-lg p-1">
                      {[
                        ["availability", "Availability", "public"],
                        ["performance", "Market performance", "monitoring"]
                      ].map(([id, label, icon]) => (
                        <button
                          type="button"
                          key={id}
                          onClick={() => setCountryScanViewTab(id)}
                          className={cn(
                            "h-8 px-3 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors",
                            countryScanViewTab === id
                              ? "bg-surface-solid text-text-main shadow-sm"
                              : "text-text-muted hover:text-text-main"
                          )}
                        >
                          <AtlasIcon name={icon} size={14} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="px-5 py-3 border-b border-border-subtle flex flex-col sm:flex-row gap-2">
                    <div className="flex-1 flex items-center gap-2 bg-input-bg border border-border-subtle rounded-lg px-3 h-9">
                      <AtlasIcon name="search" size={15} className="text-text-muted" />
                      <input
                        value={countryScanSearch}
                        onChange={event => setCountryScanSearch(event.target.value)}
                        placeholder="Search country or code..."
                        className="w-full bg-transparent outline-none text-[13px] text-text-main placeholder:text-text-muted"
                      />
                    </div>

                    {countryScanViewTab === "availability" ? (
                      <div className="flex gap-1 overflow-x-auto custom-scrollbar">
                        {[
                          ["all", "All"],
                          ["changed", "Changed"],
                          ["live", "Live"],
                          ["pre_register", "Pre-register"],
                          ["early_access", "Early access"],
                          ["unavailable", "Unavailable"],
                          ["unknown", "Unknown"]
                        ].map(([id, label]) => (
                          <button
                            type="button"
                            key={id}
                            onClick={() => setCountryScanFilter(id)}
                            className={cn(
                              "h-9 px-3 rounded-lg text-xs font-medium whitespace-nowrap border",
                              countryScanFilter === id
                                ? "bg-primary-container text-on-primary-container border-transparent"
                                : "bg-surface-solid text-text-muted border-border-subtle hover:text-text-main"
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <select
                        value={countryPerformanceSort}
                        onChange={event => setCountryPerformanceSort(event.target.value)}
                        className="h-9 px-3 rounded-lg border border-border-subtle bg-surface-solid text-text-main text-xs outline-none"
                      >
                        <option value="atlas_desc">Highest calculated score</option>
                        <option value="atlas_asc">Lowest calculated score</option>
                        <option value="rating_desc">Highest Play rating</option>
                        <option value="rating_asc">Lowest Play rating</option>
                        <option value="ratings_desc">Most ratings</option>
                        <option value="reviews_desc">Most reviews</option>
                        <option value="positive_desc">Highest positive share</option>
                        <option value="negative_desc">Highest negative share</option>
                      </select>
                    )}
                  </div>

                  <div key={countryScanViewTab} className="p-4 atlas-tab-swap">
                    {countryScanViewTab === "performance" ? (
                      countryPerformanceRows.length === 0 ? (
                        <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                          <AtlasIcon name="monitoring" size={26} className="text-text-muted" />
                          <p className="text-[13px] text-text-main font-medium mt-3">No market performance data in this scan</p>
                          <p className="text-xs text-text-muted mt-1 max-w-md">Country rating, rating-count, review-count and sentiment data are collected on newer scans.</p>
                        </div>
                      ) : (
                        <>
                          <div className="mb-3 rounded-lg border border-border-subtle bg-input-bg/50 px-3 py-2 text-xs text-text-muted">
                            <span className="font-medium text-text-main">Calculated score</span> is a confidence-adjusted 0-100 score based on observed star distribution.
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {countryPerformanceRows.map((item, index) => (
                              <div key={item.countryCode} className="rounded-xl border border-border-subtle bg-surface-solid p-3.5">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-center gap-3 min-w-0">
                                    <span className="text-lg flex-shrink-0">
                                      {getCountryFlag(item.countryCode) || <AtlasIcon name="public" size={16} className="text-text-muted" />}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                        <div className="text-[13px] font-medium text-text-main truncate">{item.countryName}</div>
                                        <PaidBadge item={item} compact />
                                        <Badge tone={item.performanceBand === "strong" ? "success" : item.performanceBand === "weak" ? "danger" : "neutral"}>
                                          {item.performanceBand === "strong" ? "Strong" : item.performanceBand === "weak" ? "Weak" : "Typical"}
                                        </Badge>
                                      </div>
                                      <div className="text-xs text-text-muted mt-0.5">{item.countryCode} · {item.performanceConfidence || "none"} confidence</div>
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-xs text-text-muted">Score</div>
                                    <div className="text-base font-semibold text-text-main tabular-nums">{item.atlasMarketScore == null ? "—" : Number(item.atlasMarketScore).toFixed(1)}</div>
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                                  <div className="rounded-lg bg-input-bg/60 px-2.5 py-2">
                                    <div className="text-xs text-text-muted">Play rating</div>
                                    <div className="text-xs font-semibold text-text-main mt-0.5 flex items-center gap-1 tabular-nums">
                                      <AtlasIcon name="star" size={12} className="text-sem-warning" />
                                      {item.playRating == null ? "—" : Number(item.playRating).toFixed(2)}
                                    </div>
                                  </div>
                                  <div className="rounded-lg bg-input-bg/60 px-2.5 py-2">
                                    <div className="text-xs text-text-muted">Ratings</div>
                                    <div className="text-xs font-semibold text-text-main mt-0.5 tabular-nums">{Number(item.ratingsCount || 0).toLocaleString()}</div>
                                  </div>
                                  <div className="rounded-lg bg-input-bg/60 px-2.5 py-2">
                                    <div className="text-xs text-text-muted">Reviews</div>
                                    <div className="text-xs font-semibold text-text-main mt-0.5 tabular-nums">{Number(item.reviewsCount || 0).toLocaleString()}</div>
                                  </div>
                                  <div className="rounded-lg bg-input-bg/60 px-2.5 py-2">
                                    <div className="text-xs text-text-muted">Rank</div>
                                    <div className="text-xs font-semibold text-text-main mt-0.5 tabular-nums">#{index + 1}</div>
                                  </div>
                                </div>

                                {(item.positiveShare != null || item.negativeShare != null) && (
                                  <div className="mt-3">
                                    <div className="flex items-center justify-between text-xs text-text-muted tabular-nums">
                                      <span className="text-sem-success">
                                        Positive {item.positiveShare == null ? "—" : Number(item.positiveShare).toFixed(1) + "%"}
                                        {item.positiveRatings ? ` · ${Number(item.positiveRatings).toLocaleString()}` : ""}
                                      </span>
                                      <span className="text-sem-danger">
                                        Negative {item.negativeShare == null ? "—" : Number(item.negativeShare).toFixed(1) + "%"}
                                        {item.negativeRatings ? ` · ${Number(item.negativeRatings).toLocaleString()}` : ""}
                                      </span>
                                    </div>
                                    <div className="mt-1.5 h-1.5 bg-input-bg rounded-full overflow-hidden flex">
                                      <div className="h-full bg-sem-success" style={{ width: (item.positiveShare || 0) + "%" }} />
                                      <div className="h-full bg-sem-danger" style={{ width: (item.negativeShare || 0) + "%" }} />
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </>
                      )
                    ) : visibleCountryResults.length === 0 ? (
                      <div className="h-full min-h-[220px] flex items-center justify-center text-[13px] text-text-muted">No countries match this filter.</div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {visibleCountryResults.map(item => {
                          const meta = getCountryStateMeta(item.state);
                          const change = countryChangesByCode.get(item.countryCode);
                          return (
                            <div key={item.countryCode} className="rounded-lg border border-border-subtle bg-surface-solid p-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="text-lg flex-shrink-0">
                                  {getCountryFlag(item.countryCode) || <AtlasIcon name="public" size={16} className="text-text-muted" />}
                                </span>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="text-[13px] font-medium text-text-main truncate">{item.countryName}</div>
                                    <PaidBadge item={item} compact />
                                  </div>
                                  <div className="text-xs text-text-muted mt-0.5">{item.countryCode} · {item.confidence || "unknown"} confidence</div>
                                  {change && (
                                    <div className="text-xs text-sem-warning mt-1">
                                      {getCountryStateMeta(change.from).label} to {getCountryStateMeta(change.to).label}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <span className={cn("px-2 py-0.5 rounded-md border text-xs font-medium flex-shrink-0", meta.className)}>
                                {meta.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-text-muted">No country scan loaded.</div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCountryScanRunning && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className={cn(
              "fixed left-4 right-4 md:left-auto md:right-6 z-[101] bg-surface-solid border border-border-subtle rounded-xl shadow-lg overflow-hidden",
              isScanning ? "bottom-60 md:bottom-[180px]" : "bottom-20 md:bottom-6",
              isCountryScanMinimized ? "md:w-[300px]" : "md:w-[360px]"
            )}
          >
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
                <div className="min-w-0">
                  <h4 className="text-[13px] font-semibold text-text-main">Country scan running</h4>
                  <p className="text-xs text-text-muted truncate mt-0.5">
                    {countryScanJob?.packageName || countryPackage}
                    {countryScanJob?.currentCountryName ? ` · ${countryScanJob.currentCountryName}` : ""}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsCountryScanMinimized(!isCountryScanMinimized)}
                className="w-7 h-7 rounded-md text-text-muted hover:text-text-main hover:bg-input-bg flex items-center justify-center transition-colors flex-shrink-0"
                title={isCountryScanMinimized ? "Expand" : "Minimize"}
                aria-label={isCountryScanMinimized ? "Expand country scan progress" : "Minimize country scan progress"}
              >
                <AtlasIcon name={isCountryScanMinimized ? "expand_content" : "minimize"} size={15} />
              </button>
            </div>

            <AnimatePresence initial={false}>
              {!isCountryScanMinimized && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-3.5">
                    <div className="relative h-1.5 bg-input-bg rounded-full overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-btn-primary rounded-full transition-[width] duration-300 ease-out"
                        style={{ width: `${countryScanPercentage}%` }}
                      />
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-text-muted tabular-nums">
                      <span>
                        <span className="text-text-main font-medium">{countryScanJob?.checked || 0}</span> / {countryScanJob?.total || 0} regions · {countryScanPercentage}%
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isScanning && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className={cn(
              "fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-[100] bg-surface-solid border border-border-subtle rounded-xl shadow-lg overflow-hidden",
              isScanMinimized ? "md:w-[300px]" : "md:w-[360px]"
            )}
          >
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
                <div className="min-w-0">
                  <h4 className="text-[13px] font-semibold text-text-main">Scanning advertiser</h4>
                  <p className="text-xs text-text-muted truncate mt-0.5 tabular-nums">
                    {scanProgress.target} · {scanProgress.targetIndex}/{scanProgress.totalTargets}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                {isAdmin && (
                  <button
                    onClick={handleCancelScan}
                    className="w-7 h-7 rounded-md text-text-muted hover:text-sem-danger hover:bg-sem-danger/10 flex items-center justify-center transition-colors"
                    title="Cancel scan"
                    aria-label="Cancel scan"
                  >
                    <AtlasIcon name="stop_circle" size={16} />
                  </button>
                )}
                <button
                  onClick={() => setIsScanMinimized(!isScanMinimized)}
                  className="w-7 h-7 rounded-md text-text-muted hover:text-text-main hover:bg-input-bg flex items-center justify-center transition-colors"
                  title={isScanMinimized ? "Expand" : "Minimize"}
                  aria-label={isScanMinimized ? "Expand scan progress" : "Minimize scan progress"}
                >
                  <AtlasIcon name={isScanMinimized ? "expand_content" : "minimize"} size={15} />
                </button>
              </div>
            </div>

            <AnimatePresence initial={false}>
              {!isScanMinimized && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-3.5">
                    <div className="relative h-1.5 bg-input-bg rounded-full overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-btn-primary rounded-full transition-[width] duration-300 ease-out"
                        style={{ width: `${scanPercentage}%` }}
                      />
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-text-muted tabular-nums">
                      <span>
                        <span className="text-text-main font-medium">{scanProgress.uniqueGamesFound || 0}</span> / {scanProgress.targetUniqueGames || 0} games · {scanPercentage}%
                      </span>
                      <span className="flex-shrink-0">{scanProgress.timeRemaining}</span>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted tabular-nums">
                      <span>
                        <span className="text-text-main font-medium">{scanProgress.adsInspected || 0}</span>/{scanProgress.maxAdsToInspect || 500} ads
                      </span>
                      <span>
                        <span className="text-text-main font-medium">{scanProgress.duplicateAds || 0}</span> duplicates
                      </span>
                      {(scanProgress.adsWithoutPackages || 0) > 0 && (
                        <span>
                          <span className="text-text-main font-medium">{scanProgress.adsWithoutPackages}</span> skipped
                        </span>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-1.5 text-xs text-text-muted min-w-0 font-mono">
                      <AtlasIcon name="terminal" size={13} className="shrink-0" />
                      <span className="truncate">{scanProgress.logs[scanProgress.logs.length - 1] || "Preparing scan..."}</span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HOW ATLAS WORKS MODAL */}
      <AnimatePresence>
        {isGuideOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 px-safe pt-safe">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
              onClick={() => setIsGuideOpen(false)}
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.985, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.985, y: 8 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="relative w-full max-w-2xl bg-surface-solid border border-border-subtle rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[86vh]"
            >
              <div className="px-5 py-4 border-b border-border-subtle flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-input-bg border border-border-subtle text-text-muted flex items-center justify-center flex-shrink-0">
                    <AtlasIcon name="explore" size={18} />
                  </div>
                  <div>
                    <h2 className="text-base text-text-main font-semibold tracking-tight">How Atlas works</h2>
                    <p className="text-xs text-text-muted mt-0.5">Scanning, organizing, and reviewing competitor game intelligence.</p>
                  </div>
                </div>

                <button
                  onClick={() => setIsGuideOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-input-bg flex items-center justify-center transition-colors text-text-muted hover:text-text-main flex-shrink-0"
                  aria-label="Close guide"
                >
                  <AtlasIcon name="close" size={18} />
                </button>
              </div>

              <div className="px-5 py-5 overflow-y-auto custom-scrollbar">
                <div className="space-y-5">
                  <section className="grid grid-cols-[32px_1fr] gap-3">
                    <div className="w-8 h-8 rounded-lg bg-input-bg border border-border-subtle text-text-main flex items-center justify-center text-xs font-semibold">1</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">What Atlas tracks</h3>
                      <p className="text-[13px] text-text-muted leading-6 mt-1">
                        Atlas monitors competitor advertising activity, resolves Google Play package IDs from live creatives, and organizes discovered titles under their publishers and competitor groups.
                      </p>
                    </div>
                  </section>

                  <div className="h-px bg-border-subtle" />

                  <section className="grid grid-cols-[32px_1fr] gap-3">
                    <div className="w-8 h-8 rounded-lg bg-input-bg border border-border-subtle text-text-main flex items-center justify-center text-xs font-semibold">2</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">Run a scan</h3>
                      <div className="mt-2.5 space-y-2">
                        {[
                          { icon: "search", title: "Brand search", text: "Enter a competitor name to search its Google Ads Transparency presence." },
                          { icon: "fingerprint", title: "Advertiser ID", text: "Paste an AR advertiser ID to scan an exact account." },
                          { icon: "playlist_play", title: "Batch list", text: "Select a saved batch list to scan multiple advertiser IDs sequentially." },
                        ].map((item) => (
                          <div key={item.title} className="flex items-start gap-3 rounded-lg border border-border-subtle bg-input-bg/35 p-3">
                            <div className="w-8 h-8 rounded-md bg-surface-solid border border-border-subtle flex items-center justify-center text-text-muted flex-shrink-0">
                              <AtlasIcon name={item.icon} size={15} />
                            </div>
                            <div>
                              <p className="text-[13px] font-semibold text-text-main">{item.title}</p>
                              <p className="text-xs text-text-muted leading-5 mt-0.5">{item.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <div className="h-px bg-border-subtle" />

                  <section className="grid grid-cols-[32px_1fr] gap-3">
                    <div className="w-8 h-8 rounded-lg bg-input-bg border border-border-subtle text-text-main flex items-center justify-center text-xs font-semibold">3</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">Review &amp; manage data</h3>
                      <div className="mt-2.5 grid sm:grid-cols-2 gap-2.5">
                        <div className="rounded-lg border border-border-subtle bg-input-bg/35 p-3">
                          <AtlasIcon name="account_tree" size={16} className="text-text-muted" />
                          <p className="text-[13px] font-semibold text-text-main mt-2">Live Directory</p>
                          <p className="text-xs text-text-muted leading-5 mt-1">Expand competitor groups and publishers to inspect linked titles.</p>
                        </div>
                        <div className="rounded-lg border border-border-subtle bg-input-bg/35 p-3">
                          <AtlasIcon name="delete_sweep" size={16} className="text-text-muted" />
                          <p className="text-[13px] font-semibold text-text-main mt-2">Data cleanup</p>
                          <p className="text-xs text-text-muted leading-5 mt-1">Admins can remove individual games, publishers, or competitor groups cleanly.</p>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              <div className="px-5 py-3.5 border-t border-border-subtle flex items-center justify-between gap-3">
                <p className="text-xs text-text-muted hidden sm:block">Reopen this guide anytime from the help button.</p>
                <button
                  onClick={() => setIsGuideOpen(false)}
                  className="ml-auto h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-[13px] font-medium transition-colors"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;










