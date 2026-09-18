import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { cn } from "./lib/utils";

// NGROK URL
const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";

const AUTH_TOKEN_KEY = "atlas_auth_token";
const AUTH_USER_KEY = "atlas_auth_user";

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
  ? "http://localhost:3000" 
  : (import.meta.env?.VITE_API_BASE_URL || NGROK_URL);

const CHART_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6"];
const FADE_UP = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DIRECTORY_GAME_SORT_OPTIONS = [
  { id: "activity", label: "Ad Activity" },
  { id: "installs", label: "Installs" },
  { id: "newest", label: "Newest" },
  { id: "rating", label: "Rating" },
  { id: "az", label: "A–Z" },
];

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

// Every API request supplies the session auth token
async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers = {
    ...options.headers,
    "ngrok-skip-browser-warning": "69420",
    ...(token ? { "x-atlas-token": token } : {})
  };

  const response = await fetch(url, { ...options, headers });

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

function hasRecentGame(games) {
  if (!games || games.length === 0) return false;
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  return games.some(g => {
    let isRecentRelease = false; let isRecentUpdate = false;
    if (g.released && g.released !== "Unknown") {
      const releaseTime = new Date(g.released).getTime();
      if (!isNaN(releaseTime) && releaseTime > sevenDaysAgo) isRecentRelease = true;
    }
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

function processHistoryData(rawHistory) {
  if (!rawHistory || rawHistory.length === 0) return { data: [], lines: [] };

  const datesMap = {};
  const competitorNames = new Set();

  rawHistory.forEach((row) => {
    const d = new Date(row.scan_date);
    const shortDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (!datesMap[shortDate]) {
      datesMap[shortDate] = { date: shortDate, _time: d.getTime(), raw: {} };
    }
    if (row.name) {
      datesMap[shortDate].raw[row.name] = Number(row.total_ads) || 0;
      competitorNames.add(row.name);
    }
  });

  const sortedDates = Object.values(datesMap).sort((a, b) => a._time - b._time);
  const lines = Array.from(competitorNames);
  const lastKnownValues = {};

  const normalizedData = sortedDates.map((entry) => {
    const point = { date: entry.date };
    lines.forEach((name) => {
      if (entry.raw[name] !== undefined) {
        lastKnownValues[name] = entry.raw[name];
        point[name] = entry.raw[name];
      } else if (lastKnownValues[name] !== undefined) {
        point[name] = lastKnownValues[name];
      } else {
        point[name] = 0;
      }
    });
    return point;
  });

  return { data: normalizedData, lines };
}

const DashboardTelemetry = memo(function DashboardTelemetry({ historyData, isDarkMode }) {
  return (
    <motion.section
      variants={FADE_UP}
      className="w-full bg-surface-solid border border-border-subtle rounded-[24px] shadow-sm p-4 md:p-6 h-[340px] md:h-[420px] flex flex-col overflow-hidden"
    >
      <div className="flex items-start justify-between gap-4 mb-4 md:mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-electric-blue text-[21px]">monitoring</span>
            <h2 className="text-sm md:text-base font-semibold text-text-main tracking-tight">Game Discovery Telemetry</h2>
          </div>
          <p className="text-[11px] md:text-xs text-text-muted mt-1 ml-0 md:ml-[29px]">Total unique games discovered per competitor over time</p>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-input-bg border border-border-subtle px-3 py-1.5 text-[10px] md:text-xs text-text-muted flex-shrink-0">
          <span className="w-2 h-2 rounded-full bg-electric-blue"></span>
          Live data
        </div>
      </div>

      <div className="flex-1 w-full min-h-0">
        {historyData.data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={historyData.data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
              <defs>
                {historyData.lines.map((competitorName, index) => (
                  <linearGradient key={competitorName} id={`color${index}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0.18}/>
                    <stop offset="95%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0}/>
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="2 5" vertical={false} stroke={isDarkMode ? '#3c4043' : '#e5e7eb'} />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={{ fill: isDarkMode ? '#9aa0a6' : '#6b7280', fontSize: 10, fontFamily: 'Inter, sans-serif' }}
                dy={10}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: isDarkMode ? '#9aa0a6' : '#6b7280', fontSize: 10, fontFamily: 'Inter, sans-serif' }}
              />
              <Tooltip
                itemSorter={(item) => -Number(item.value || 0)}
                cursor={{ stroke: isDarkMode ? '#5f6368' : '#d1d5db', strokeDasharray: '4 4' }}
                contentStyle={{
                  backgroundColor: isDarkMode ? '#303134' : '#ffffff',
                  border: `1px solid ${isDarkMode ? '#5f6368' : '#e5e7eb'}`,
                  borderRadius: '14px',
                  color: isDarkMode ? '#e8eaed' : '#202124',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                  padding: '10px 12px',
                }}
                itemStyle={{ fontSize: '12px', fontWeight: 600 }}
                labelStyle={{ color: isDarkMode ? '#bdc1c6' : '#5f6368', marginBottom: '6px', fontSize: '11px' }}
              />
              {historyData.lines.map((competitorName, index) => (
                <Area
                  key={competitorName}
                  connectNulls
                  type="monotone"
                  dataKey={competitorName}
                  stroke={CHART_COLORS[index % CHART_COLORS.length]}
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill={`url(#color${index})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: isDarkMode ? '#202124' : '#ffffff' }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-text-muted">
            <div className="w-12 h-12 rounded-full bg-input-bg flex items-center justify-center mb-3">
              <span className="material-symbols-outlined text-2xl">show_chart</span>
            </div>
            <p className="text-xs">Run scans to build telemetry.</p>
          </div>
        )}
      </div>
    </motion.section>
  );
});

const TrendingTargets = memo(function TrendingTargets({
  sortedTrending,
  trendingSort,
  onSort,
  onGameClick,
  viewMode,
  latestScanTargetName,
}) {
  return (
    <section className="xl:col-span-7 bg-surface-solid border border-border-subtle rounded-[24px] shadow-sm flex flex-col h-[500px] md:h-[600px] overflow-hidden">
      <div className="p-4 md:p-5 border-b border-border-subtle flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-electric-blue text-[21px]">trending_up</span>
            <h2 className="text-sm md:text-base font-semibold text-text-main tracking-tight">Trending Targets</h2>
          </div>
          <p className="text-[10px] md:text-xs text-text-muted mt-1 md:ml-[29px]">
            {viewMode === 'latest' && <span className="text-emerald-metric mr-2 font-semibold">● Latest</span>}
            Ranked by activity
          </p>
        </div>

        <div className="flex bg-input-bg rounded-full p-1 border border-border-subtle">
          {[{ id: 'ads', label: 'Ad push' }, { id: 'installs', label: 'Installs' }, { id: 'newest', label: 'Newest' }].map((btn) => (
            <button
              key={btn.id}
              onClick={() => onSort(btn.id)}
              className={cn(
                "px-3 md:px-4 py-1.5 rounded-full text-[10px] md:text-xs font-medium transition-colors",
                trendingSort === btn.id
                  ? "bg-primary-container text-on-primary-container shadow-sm"
                  : "text-text-muted hover:text-text-main hover:bg-surface-glass"
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      <motion.div layoutScroll className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border-subtle">
        {sortedTrending.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted p-6">
            <div className="w-12 h-12 rounded-full bg-input-bg flex items-center justify-center mb-3">
              <span className="material-symbols-outlined text-2xl">radar</span>
            </div>
            <span className="text-xs font-medium">
              {viewMode === 'latest'
                ? (latestScanTargetName ? `No ads found for "${latestScanTargetName}".` : "No active scan.")
                : "No data yet."}
            </span>
          </div>
        ) : (
          <LayoutGroup id="trending-targets">
            {sortedTrending.map((game) => {
              const gameKey = getGameIdentity(game);
              return (
                <motion.button
                  type="button"
                  key={gameKey}
                  layout="position"
                  transition={{ layout: { type: "spring", stiffness: 500, damping: 42, mass: 0.65 } }}
                  onClick={() => onGameClick(game)}
                  className="w-full flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 text-left hover:bg-input-bg/60 focus-visible:bg-input-bg/60 focus-visible:outline-none transition-colors group"
                >
                  <div className="w-11 h-11 md:w-12 md:h-12 rounded-xl overflow-hidden bg-input-bg border border-border-subtle flex items-center justify-center flex-shrink-0">
                    {game.icon ? (
                      <img loading="lazy" decoding="async" src={game.icon} alt={game.title} className="w-full h-full object-cover" />
                    ) : (
                      <span className="material-symbols-outlined text-text-muted">sports_esports</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="text-xs md:text-sm font-semibold text-text-main truncate group-hover:text-electric-blue transition-colors">{game.title}</h3>
                    <p className="text-[10px] md:text-xs text-text-muted truncate mt-0.5">{game.publisher_name}</p>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 ml-auto flex-shrink-0">
                    {game.ad_count >= 1 && (
                      <span className="rounded-full bg-electric-blue/10 text-electric-blue px-2.5 py-1 text-[9px] md:text-[10px] font-medium whitespace-nowrap border border-electric-blue/15">
                        {viewMode === "latest" ? `${game.ad_count} ads` : `${game.ad_count} detections`}
                      </span>
                    )}
                    <div className="flex items-center gap-1.5">
                      {game.installs && game.installs !== "0+" && (
                        <span className="text-[9px] md:text-[10px] font-semibold text-text-muted bg-input-bg px-2 py-0.5 rounded-full">{game.installs}</span>
                      )}
                      {game.released && game.released !== "Unknown" && (
                        <span className="text-[9px] md:text-[10px] text-text-muted bg-input-bg px-2 py-0.5 rounded-full">{getAgeText(game.released)}</span>
                      )}
                    </div>
                  </div>

                  <span className="material-symbols-outlined text-text-muted text-[18px] opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block">chevron_right</span>
                </motion.button>
              );
            })}
          </LayoutGroup>
        )}
      </motion.div>
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
  return (
    <section className="xl:col-span-5 bg-surface-solid border border-border-subtle rounded-[24px] shadow-sm flex flex-col h-[430px] md:h-[600px] overflow-hidden">
      <div className="p-4 md:p-5 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-electric-blue text-[21px]">folder_open</span>
          <h2 className="text-sm md:text-base font-semibold text-text-main tracking-tight">Live Directory</h2>
        </div>
        <p className="text-[10px] md:text-xs text-text-muted mt-1 md:ml-[29px]">
          {viewMode === 'latest' && <span className="text-emerald-metric mr-2 font-semibold">● Latest</span>}
          Hierarchy view
        </p>
      </div>

      <div className="flex-1 p-3 md:p-4 overflow-y-auto custom-scrollbar">
        {visibleCompetitorTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted p-6">
            <div className="w-12 h-12 rounded-full bg-input-bg flex items-center justify-center mb-3">
              <span className="material-symbols-outlined text-2xl">account_tree</span>
            </div>
            <span className="text-xs font-medium">No directory data.</span>
          </div>
        ) : visibleCompetitorTree.map((comp) => (
          <div key={comp.id} className="mb-2 text-xs">
            <div
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-2xl hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors cursor-pointer group"
              onClick={() => onToggleNode(`comp_${comp.id}`)}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="material-symbols-outlined text-text-muted text-[18px] transition-transform"
                  style={{ transform: expandedNodes[`comp_${comp.id}`] === false ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                >
                  expand_more
                </span>
                <div className="w-8 h-8 rounded-xl bg-input-bg flex items-center justify-center text-text-muted flex-shrink-0">
                  <span className="material-symbols-outlined text-[18px]">domain</span>
                </div>
                <span className="font-semibold text-text-main truncate">{comp.name}</span>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-[9px] px-2 py-1 rounded-full bg-input-bg text-text-muted font-medium">Group</span>
                {isAdmin && (
                  <button
                    onClick={(e) => onNukeCompetitorData(e, comp.id, comp.name)}
                    className="w-7 h-7 rounded-full text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                    title="Delete all group data"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                )}
              </div>
            </div>

            {expandedNodes[`comp_${comp.id}`] !== false && (
              <div className="ml-6 pl-3 border-l border-border-subtle space-y-1 py-1">
                {comp.accounts && comp.accounts.map((acc) => (
                  <div key={acc.id}>
                    <div
                      className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl hover:bg-black/[0.035] dark:hover:bg-white/[0.045] transition-colors cursor-pointer group/pub"
                      onClick={() => onToggleNode(`pub_${acc.id}`)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="material-symbols-outlined text-text-muted text-[16px] transition-transform"
                          style={{ transform: expandedNodes[`pub_${acc.id}`] === false ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                        >
                          expand_more
                        </span>
                        <span className="material-symbols-outlined text-text-muted text-[18px] flex-shrink-0">folder</span>
                        <span className="text-text-main text-[10px] md:text-xs font-medium truncate">{acc.publisher_name}</span>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[9px] px-2 py-1 rounded-full bg-input-bg text-text-muted font-medium">Pub</span>
                        {isAdmin && (
                          <button
                            onClick={(e) => onNukePublisherData(e, acc.id, acc.publisher_name)}
                            className="w-7 h-7 rounded-full text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 flex items-center justify-center opacity-0 group-hover/pub:opacity-100 focus:opacity-100 transition-all"
                            title="Delete publisher data"
                          >
                            <span className="material-symbols-outlined text-[15px]">delete</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {expandedNodes[`pub_${acc.id}`] !== false && (
                      <div className="ml-7 pl-3 border-l border-border-subtle space-y-0.5 py-1">
                        {acc.games && acc.games.map((game) => (
                          <div
                            key={getGameIdentity(game)}
                            onClick={() => onGameClick(game)}
                            className="group/game flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-black/[0.035] dark:hover:bg-white/[0.045] cursor-pointer transition-colors"
                          >
                            <span className="material-symbols-outlined text-text-muted text-[16px] flex-shrink-0">sports_esports</span>
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] md:text-[11px] font-medium text-text-main truncate">{game.title}</div>
                              <div className="text-[9px] text-text-muted truncate">{game.package_name}</div>
                            </div>
                            {isAdmin && (
                              <button
                                onClick={(e) => onDeleteGame(e, game)}
                                disabled={isScanning}
                                className="w-7 h-7 rounded-full text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 flex items-center justify-center opacity-0 group-hover/game:opacity-100 focus:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed transition-all"
                                title={isScanning ? "Wait for the active scan to finish" : "Delete game from Atlas"}
                                aria-label={`Delete ${game.title || game.package_name || "game"}`}
                              >
                                <span className="material-symbols-outlined text-[14px]">delete</span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
});

function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY)) || null; } catch { return null; }
  });
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");

  const isAdmin = currentUser?.role === "admin";

  const [activeTab, setActiveTab] = useState("dashboard"); 
  const [trendingSort, setTrendingSort] = useState("ads");
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [trending, setTrending] = useState([]);
  const [historyData, setHistoryData] = useState({ data: [], lines: [] });

  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryFilter, setDirectoryFilter] = useState("all"); 
  const [directoryGameSort, setDirectoryGameSort] = useState("activity");
  const [pubSort, setPubSort] = useState("installs"); 
  const [pubFilterNew, setPubFilterNew] = useState(false); 
  const [pubFilterComp, setPubFilterComp] = useState("all");

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
  const [isScanMinimized, setIsScanMinimized] = useState(false);
  const [isSaving, setIsSaving] = useState(false); 
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
  const [activeStatPanel, setActiveStatPanel] = useState(null);
  const [statPanelSearch, setStatPanelSearch] = useState("");
  const deferredStatPanelSearch = useDeferredValue(statPanelSearch);
  const [scanProgress, setScanProgress] = useState({ target: "", currentAd: 0, totalAds: 0, timeRemaining: "Calculating...", logs: [] });
  const lastHandledTerminalRef = useRef(null);
  const scanLaunchPendingRef = useRef(false);

  const [targetLists, setTargetLists] = useState([]);
  const [savedCompetitors, setSavedCompetitors] = useState([]);
  const [emailLists, setEmailLists] = useState([]); 
  
  const [newListName, setNewListName] = useState("");
  const [newListTargets, setNewListTargets] = useState("");
  const [newCompName, setNewCompName] = useState("");
  const [newCompAdsId, setNewCompAdsId] = useState("");
  const [newEmailName, setNewEmailName] = useState(""); 
  const [newEmailTargets, setNewEmailTargets] = useState(""); 

  const [isNodeOnline, setIsNodeOnline] = useState(true);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("atlas_theme");
    return saved ? saved === "dark" : true; 
  });

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

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) { root.classList.add("dark"); localStorage.setItem("atlas_theme", "dark"); } 
    else { root.classList.remove("dark"); localStorage.setItem("atlas_theme", "light"); }
  }, [isDarkMode]);

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

  const loadAllData = useCallback(async () => {
    if (!authToken || !currentUser) return;
    try {
      await fetchJson(`${API_BASE}/api/health`);
      setIsNodeOnline(true);
    } catch {
      setIsNodeOnline(false);
      return;
    }
    const requests = [
      fetchJson(`${API_BASE}/api/stats`).then(data => setStats(data?.error ? { competitors: 0, accounts: 0, games: 0 } : data)),
      fetchJson(`${API_BASE}/api/competitors`).then(data => setCompetitorTree(Array.isArray(data) ? data : [])),
      fetchJson(`${API_BASE}/api/trending`).then(data => setTrending(Array.isArray(data) ? data : [])),
      fetchJson(`${API_BASE}/api/lists`).then(data => setTargetLists(Array.isArray(data) ? data : [])),
      fetchJson(`${API_BASE}/api/saved-competitors`).then(data => setSavedCompetitors(Array.isArray(data) ? data : [])),
      fetchJson(`${API_BASE}/api/emails`).then(data => setEmailLists(Array.isArray(data) ? data : [])),
      fetchJson(`${API_BASE}/api/competitor-history`).then(data => setHistoryData(processHistoryData(Array.isArray(data) ? data : []))),
      fetchJson(`${API_BASE}/api/settings`).then(data => { if (data && !data.error) setSettings(prev => ({ ...prev, ...data })); }),
    ];
    const results = await Promise.allSettled(requests);
    results.filter(result => result.status === "rejected").forEach(result => console.error("Atlas data load failed:", result.reason));
  }, [authToken, currentUser]);

  useEffect(() => { 
    if (authToken && currentUser) {
      loadAllData(); 
      const heartbeat = setInterval(async () => {
        try { await fetchJson(`${API_BASE}/api/health`); setIsNodeOnline(true); } 
        catch { setIsNodeOnline(false); }
      }, 30000);
      return () => clearInterval(heartbeat);
    }
  }, [authToken, currentUser, loadAllData]);

  const applyScanStatus = useCallback((status) => {
    if (!status || typeof status !== "object") return;

    const state = status.state || (status.running ? "running" : "idle");

    // "idle" is the normal backend state when no scan has been started since
    // the Node process booted. Ignore it while a new POST /api/scan is still
    // travelling to the backend so the UI cannot flicker back to idle.
    if (state === "idle") {
      if (!scanLaunchPendingRef.current) {
        setIsScanning(false);
      }
      return;
    }

    setScanProgress(prev => ({
      ...prev,
      target: status.target || prev.target,
      targetIndex: status.targetIndex ?? prev.targetIndex,
      totalTargets: status.totalTargets ?? prev.totalTargets,
      currentAd: status.currentAd ?? prev.currentAd,
      totalAds: status.totalAds ?? prev.totalAds,
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
      setViewMode("latest");
      return;
    }

    const terminalKey = `${status.scanId || "scan"}:${state}:${status.finishedAt || status.updatedAt || ""}`;
    const isNewTerminalState = lastHandledTerminalRef.current !== terminalKey;

    if (state === "complete" || status.isComplete) {
      if (Array.isArray(status.packages)) {
        setLatestScanPackages(status.packages);
        localStorage.setItem("atlas_latest_packages", JSON.stringify(status.packages));
      }

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
        void loadAllData();
      }

      setIsScanning(false);
      return;
    }

    if (state === "cancelled" || status.isCancelled || state === "error" || status.isError || status.fatalError) {
      if (isNewTerminalState) {
        lastHandledTerminalRef.current = terminalKey;
        void loadAllData();
      }

      setIsScanning(false);
    }
  }, [loadAllData]);

  // Durable scan progress: use normal authenticated HTTP polling instead of a
  // long-lived SSE connection. This survives ngrok/proxy stream disconnects
  // and can recover the live scan UI after a browser refresh.
  useEffect(() => {
    if (!authToken || !currentUser) return;

    let disposed = false;
    let requestInFlight = false;

    const pollScanStatus = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const status = await fetchJson(`${API_BASE}/api/scan-status`);
        if (!disposed) applyScanStatus(status);
      } catch (err) {
        if (!disposed && err?.message && !err.message.includes("Unauthorized")) {
          console.warn("Scan status poll failed:", err.message);
        }
      } finally {
        requestInFlight = false;
      }
    };

    void pollScanStatus();
    const poller = setInterval(pollScanStatus, 1500);

    return () => {
      disposed = true;
      clearInterval(poller);
    };
  }, [authToken, currentUser, applyScanStatus]);

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    const user = usernameInput.trim();
    const pass = passwordInput.trim();
    if (!user || !pass) return;

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
      setUsernameInput("");
      setPasswordInput("");
    } catch (err) {
      setLoginError(err.message || "Invalid credentials.");
    }
  };

  const toggleNode = useCallback((nodeId) => {
    setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }, []);

  const handleNukeCompetitorData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (!isAdmin) return;
    if (window.confirm(`Are you sure you want to permanently delete all data for ${name}, including associated games and publishers? This cannot be undone.`)) {
      try {
        await fetchJson(`${API_BASE}/api/competitors/${id}/data`, { method: "DELETE" });
        loadAllData();
      } catch { alert("Failed to delete competitor."); }
    }
  }, [isAdmin, loadAllData]);

  const handleNukePublisherData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (!isAdmin) return;
    if (window.confirm(`Are you sure you want to permanently delete all data for publisher ${name}?`)) {
      try {
        await fetchJson(`${API_BASE}/api/publishers/${id}/data`, { method: "DELETE" });
        loadAllData();
      } catch { alert("Failed to delete publisher."); }
    }
  }, [isAdmin, loadAllData]);

  const handleDeleteGame = useCallback(async (e, game) => {
    e?.stopPropagation?.();
    if (!isAdmin || !game?.id) return;

    if (isScanning) {
      alert("Wait for the active scan to finish before deleting a game.");
      return;
    }

    const gameLabel = game.title || game.package_name || "this game";
    if (!window.confirm(`Permanently delete ${gameLabel} from Atlas?\n\nThis removes the game, its publisher links, and its stored ad history. The publisher and competitor themselves will remain.`)) {
      return;
    }

    try {
      const deleted = await fetchJson(`${API_BASE}/api/games/${game.id}/data`, { method: "DELETE" });
      const packageName = deleted?.package_name || game.package_name;

      if (packageName) {
        setLatestScanPackages(prev => {
          const next = (prev || []).filter(pkg => pkg !== packageName);
          localStorage.setItem("atlas_latest_packages", JSON.stringify(next));
          return next;
        });

        setLatestScanAdCounts(prev => {
          const next = { ...(prev || {}) };
          delete next[packageName];
          localStorage.setItem("atlas_latest_ad_counts", JSON.stringify(next));
          return next;
        });

        setLatestScanAdCountsByCompetitor(prev => {
          const next = {};
          for (const [competitorId, counts] of Object.entries(prev || {})) {
            const nextCounts = { ...(counts || {}) };
            delete nextCounts[packageName];
            if (Object.keys(nextCounts).length > 0) next[competitorId] = nextCounts;
          }
          localStorage.setItem("atlas_latest_ad_counts_by_competitor", JSON.stringify(next));
          return next;
        });
      }

      setSelectedGame(prev => {
        const sameGame = prev && (prev.id === game.id || (packageName && prev.package_name === packageName));
        if (sameGame) {
          setIsDrawerOpen(false);
          return null;
        }
        return prev;
      });

      await loadAllData();
    } catch (err) {
      alert(err?.message || "Failed to delete game.");
    }
  }, [isAdmin, isScanning, loadAllData]);

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
    if (!hasLatestScan) return false;

    const competitorKey = game?.competitor_id !== undefined && game?.competitor_id !== null
      ? String(game.competitor_id)
      : null;

    if (competitorKey && latestScanAdCountsByCompetitor?.[competitorKey]) {
      return Number(latestScanAdCountsByCompetitor[competitorKey]?.[game.package_name]) > 0;
    }

    if (latestScanPackages && latestScanPackages.length > 0) {
      return latestScanPackages.includes(game.package_name);
    }

    if (latestScanCompId) {
      const comp = competitorTree.find(c => c.id.toString() === latestScanCompId.toString());
      if (comp && comp.accounts) {
        return comp.accounts.some(acc => (acc.games || []).some(g => g.package_name === game.package_name));
      }
    }

    if (latestScanTargetName) {
      const targetLower = latestScanTargetName.toLowerCase();
      const pubMatch = (game.publisher_name || "").toLowerCase().includes(targetLower);
      const compMatch = (game.competitor_name || "").toLowerCase().includes(targetLower);
      const pkgMatch = (game.package_name || "").toLowerCase().includes(targetLower);
      return pubMatch || compMatch || pkgMatch;
    }

    return false;
  };

  const visibleTrending = useMemo(() => {
    const visibleGames = trending
      .filter(isFromLatestScan)
      .map(withLatestScanAdCount);

    // Keep the UI resilient even if a future backend join or stale payload
    // returns the same package more than once.
    return dedupeGames(visibleGames);
  }, [trending, viewMode, hasLatestScan, latestScanPackages, latestScanCompId, latestScanTargetName, latestScanAdCountsByCompetitor, withLatestScanAdCount]);

  const visibleCompetitorTree = useMemo(() => {
    return competitorTree.map(comp => {
      if (viewMode === "all") return comp;

      const isTargetComp = latestScanCompId
        ? comp.id.toString() === latestScanCompId.toString()
        : (latestScanTargetName ? comp.name.toLowerCase().includes(latestScanTargetName.toLowerCase()) : false);

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
      }).filter(acc => acc.games.length > 0 || isTargetComp);

      return { ...comp, accounts: visibleAccounts };
    }).filter(comp => {
      if (viewMode === "all") return true;

      // When exact per-competitor counts are available (the new scan model),
      // keep every competitor that actually contributed at least one package.
      if (latestScanAdCountsByCompetitor?.[String(comp.id)]) {
        return Object.keys(latestScanAdCountsByCompetitor[String(comp.id)] || {}).length > 0;
      }

      if (latestScanCompId) return comp.id.toString() === latestScanCompId.toString();
      if (latestScanTargetName) return comp.name.toLowerCase().includes(latestScanTargetName.toLowerCase());
      return comp.accounts.length > 0;
    });
  }, [competitorTree, viewMode, latestScanCompId, latestScanTargetName, hasLatestScan, latestScanPackages, latestScanAdCountsByCompetitor, withLatestScanAdCount]);

  const displayStats = useMemo(() => {
    return viewMode === "all" ? stats : {
      competitors: visibleCompetitorTree.length,
      accounts: visibleCompetitorTree.reduce((sum, comp) => sum + (comp.accounts?.length || 0), 0),
      games: visibleTrending.length
    };
  }, [stats, viewMode, visibleCompetitorTree, visibleTrending]);

  const statCompetitors = useMemo(() => {
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
  }, [visibleCompetitorTree]);

  const statPublishers = useMemo(() => {
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
  }, [visibleCompetitorTree]);

  const statGames = useMemo(() => {
    const uniqueGames = new Map();

    visibleTrending.forEach((game) => {
      const key = getGameIdentity(game);
      const existing = uniqueGames.get(key);

      if (!existing) {
        uniqueGames.set(key, game);
        return;
      }

      const existingInstalls = getInstallCount(existing);
      const incomingInstalls = getInstallCount(game);

      uniqueGames.set(key, {
        ...existing,
        ...game,
        ad_count: Math.max(Number(existing.ad_count) || 0, Number(game.ad_count) || 0),
        min_installs: Math.max(existingInstalls, incomingInstalls),
        installs: incomingInstalls >= existingInstalls ? game.installs : existing.installs,
      });
    });

    return Array.from(uniqueGames.values()).sort((a, b) =>
      (a.title || "").localeCompare(b.title || "")
    );
  }, [visibleTrending]);

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
    const query = directorySearch.trim().toLowerCase();
    if (query.length < 2) return { games: [], publishers: [], competitors: [] };

    const games = statGames.filter((game) =>
      (game.title || "").toLowerCase().includes(query) ||
      (game.publisher_name || "").toLowerCase().includes(query) ||
      (game.package_name || "").toLowerCase().includes(query)
    ).slice(0, 5);

    const publishers = statPublishers.filter((publisher) =>
      (publisher.publisher_name || "").toLowerCase().includes(query) ||
      (publisher.competitorName || "").toLowerCase().includes(query)
    ).slice(0, 4);

    const competitors = statCompetitors.filter((competitor) =>
      (competitor.name || "").toLowerCase().includes(query) ||
      (competitor.ads_id || "").toLowerCase().includes(query)
    ).slice(0, 4);

    return { games, publishers, competitors };
  }, [directorySearch, statGames, statPublishers, statCompetitors]);

  const globalSearchResultCount =
    globalSearchResults.games.length +
    globalSearchResults.publishers.length +
    globalSearchResults.competitors.length;

  const sortedTrending = useMemo(() => {
    const uniqueGames = new Map();

    visibleTrending.forEach((game) => {
      const key = getGameIdentity(game);
      const existing = uniqueGames.get(key);

      if (!existing) {
        uniqueGames.set(key, game);
        return;
      }

      const existingInstalls = getInstallCount(existing);
      const incomingInstalls = getInstallCount(game);

      uniqueGames.set(key, {
        ...existing,
        ...game,
        ad_count: Math.max(Number(existing.ad_count) || 0, Number(game.ad_count) || 0),
        min_installs: Math.max(existingInstalls, incomingInstalls),
        installs: incomingInstalls >= existingInstalls ? game.installs : existing.installs,
      });
    });

    const games = Array.from(uniqueGames.values());

    return games.sort((a, b) => {
      let difference = 0;

      if (trendingSort === "ads") {
        difference = (Number(b.ad_count) || 0) - (Number(a.ad_count) || 0);
      } else if (trendingSort === "newest") {
        const parsedA = a.released && a.released !== "Unknown" ? new Date(a.released).getTime() : 0;
        const parsedB = b.released && b.released !== "Unknown" ? new Date(b.released).getTime() : 0;
        const timeA = Number.isFinite(parsedA) ? parsedA : 0;
        const timeB = Number.isFinite(parsedB) ? parsedB : 0;
        difference = timeB - timeA;
      } else {
        difference = getInstallCount(b) - getInstallCount(a);
      }

      if (difference !== 0) return difference;
      return getGameIdentity(a).localeCompare(getGameIdentity(b));
    });
  }, [visibleTrending, trendingSort]);

  const searchLower = directorySearch.toLowerCase();

  const filteredGames = useMemo(() => {
    return visibleTrending.filter(g => 
      (g.title || "").toLowerCase().includes(searchLower) || (g.publisher_name || "").toLowerCase().includes(searchLower) || (g.package_name || "").toLowerCase().includes(searchLower)
    );
  }, [visibleTrending, searchLower]);

  const sortedDirectoryGames = useMemo(() => {
    const games = [...filteredGames];

    const getReleaseTime = (game) => {
      if (!game?.released || game.released === "Unknown") return 0;
      const parsed = new Date(game.released).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };

    games.sort((a, b) => {
      let difference = 0;

      if (directoryGameSort === "activity") {
        // In Latest Scan mode ad_count has already been replaced with the exact
        // per-scan count. In All Time mode it is the historical detection count.
        difference = (Number(b.ad_count) || 0) - (Number(a.ad_count) || 0);
      } else if (directoryGameSort === "installs") {
        difference = getInstallCount(b) - getInstallCount(a);
      } else if (directoryGameSort === "newest") {
        difference = getReleaseTime(b) - getReleaseTime(a);
      } else if (directoryGameSort === "rating") {
        difference = (Number(b.rating) || 0) - (Number(a.rating) || 0);
      } else if (directoryGameSort === "az") {
        return (a.title || a.package_name || "").localeCompare(b.title || b.package_name || "");
      }

      if (difference !== 0) return difference;
      return (a.title || a.package_name || "").localeCompare(b.title || b.package_name || "");
    });

    return games;
  }, [filteredGames, directoryGameSort]);

  const filteredCompetitors = useMemo(() => {
    return visibleCompetitorTree.filter(c => 
      (c.name || "").toLowerCase().includes(searchLower) || (c.ads_id || "").toLowerCase().includes(searchLower)
    );
  }, [visibleCompetitorTree, searchLower]);

  const processedAccounts = useMemo(() => {
    const accounts = [];
    visibleCompetitorTree.forEach(comp => {
      (comp.accounts || []).forEach(acc => {
        if ((acc.publisher_name || "").toLowerCase().includes(searchLower) || (comp.name || "").toLowerCase().includes(searchLower)) {
          let totalGames = acc.games ? acc.games.length : 0;
          let totalInstalls = (acc.games || []).reduce((sum, g) => sum + parseInstalls(g.installs), 0);
          let recentGame = hasRecentGame(acc.games);
          accounts.push({ ...acc, competitorName: comp.name, competitorId: comp.id, totalGames, totalInstalls, recentGame });
        }
      });
    });

    return accounts.filter(acc => {
      if (pubFilterNew && !acc.recentGame) return false;
      if (pubFilterComp !== 'all' && acc.competitorId.toString() !== pubFilterComp.toString()) return false;
      return true;
    }).sort((a, b) => {
      if (pubSort === 'games') return b.totalGames - a.totalGames;
      if (pubSort === 'installs') return b.totalInstalls - a.totalInstalls;
      return a.publisher_name.localeCompare(b.publisher_name); 
    });
  }, [visibleCompetitorTree, searchLower, pubFilterNew, pubFilterComp, pubSort]);

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
    if (!isAdmin || !newListName || !newListTargets || isSaving) return;
    setIsSaving(true);
    try {
      await fetchJson(`${API_BASE}/api/lists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newListName,
          targets: newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(Boolean)
        })
      });
      setNewListName("");
      setNewListTargets("");
      loadAllData();
    } catch (err) {
      console.error("List creation error:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCompetitor = async (e) => {
    e.preventDefault();
    if (!isAdmin || !newCompName || !newCompAdsId || isSaving) return;
    setIsSaving(true);
    try {
      await fetchJson(`${API_BASE}/api/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCompName, adsId: newCompAdsId, country: "Any" })
      });
      setNewCompName("");
      setNewCompAdsId("");
      loadAllData();
    } catch (err) {
      console.error("Competitor save error:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveEmailList = async (e) => {
    e.preventDefault();
    if (!isAdmin || !newEmailName || !newEmailTargets || isSaving) return;
    setIsSaving(true);
    try {
      await fetchJson(`${API_BASE}/api/emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newEmailName,
          emails: newEmailTargets.split(/[\n,]+/).map(t => t.trim()).filter(Boolean)
        })
      });
      setNewEmailName("");
      setNewEmailTargets("");
      loadAllData();
    } catch (err) {
      console.error("Email list save error:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteList = async (id) => {
    if (!isAdmin) return;
    if (window.confirm("Delete this target list?")) {
      try {
        await fetchJson(`${API_BASE}/api/lists/${id}`, { method: "DELETE" });
        loadAllData();
      } catch (err) {
        console.error("List delete error:", err);
      }
    }
  };

  const handleDeleteCompetitor = async (id) => {
    if (!isAdmin) return;
    if (window.confirm("Delete this saved competitor?")) {
      try {
        await fetchJson(`${API_BASE}/api/saved-competitors/${id}`, { method: "DELETE" });
        loadAllData();
      } catch (err) {
        console.error("Competitor delete error:", err);
      }
    }
  };

  const handleDeleteEmail = async (id) => {
    if (!isAdmin) return;
    if (window.confirm("Delete this email target?")) {
      try {
        await fetchJson(`${API_BASE}/api/emails/${id}`, { method: "DELETE" });
        loadAllData();
      } catch (err) {
        console.error("Email delete error:", err);
      }
    }
  };
  
  const handleCancelScan = async () => {
    if (!isAdmin) return;
    if (!window.confirm("Abort the current scan? Any targets already processed will be saved safely.")) return;
    try {
      await fetchJson(`${API_BASE}/api/cancel-scan`, { method: "POST" });
      setScanProgress(prev => ({ ...prev, logs: [...prev.logs, "> Sending cancel request to backend..."] }));
    } catch (err) {
      console.error("Scan cancel error:", err);
    }
  };

  const handleRunScan = async () => {
    if (!isAdmin) return alert("Only administrators can initiate scans.");
    if (selectedSource === "manual" && !scanQuery) return alert("Please enter a competitor name or AR ID!");

    const directReportEmail = customReportEmail.trim();
    if (selectedEmailList === "custom" && !EMAIL_REGEX.test(directReportEmail)) {
      return alert("Please enter a valid email address for the report.");
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

    setViewMode("latest");
    setIsScanning(true);
    setIsScanMinimized(false);

    const finalLimit = isMaxAds ? 999999 : Math.max(1, Number(scanLimit) || 1);
    setScanProgress({
      target: "Initializing...",
      targetIndex: 1,
      totalTargets: 1,
      currentAd: 0,
      totalAds: finalLimit,
      timeRemaining: "Calculating...",
      logs: ["> Booting Intelligence Node..."]
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

      // Pull the freshly-created backend state immediately instead of waiting
      // for the next 1.5s polling tick.
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
    }
  };

  const handleReset = () => {
    if (!window.confirm("Clear the 'Latest Scan' view? This empties the screen until your next scan. (All-time database records remain safe).")) return;
    setLatestScanPackages([]);
    setLatestScanAdCounts({});
    setLatestScanAdCountsByCompetitor({});
    setLatestScanTargetName("");
    setLatestScanCompId(null);
    setHasLatestScan(false);
    localStorage.removeItem("atlas_latest_packages");
    localStorage.removeItem("atlas_latest_ad_counts");
    localStorage.removeItem("atlas_latest_ad_counts_by_competitor");
    localStorage.removeItem("atlas_has_latest_scan");
    localStorage.removeItem("atlas_latest_target_name");
    localStorage.removeItem("atlas_latest_comp_id");
  };

  const handleGameClick = useCallback((game) => {
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
    setSelectedGame(game);
    setIsDrawerOpen(true);
  }, []);

  const openDirectoryFromSearch = useCallback((filter, value) => {
    if (value) setDirectorySearch(value);
    setDirectoryFilter(filter);
    setActiveTab("directory");
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
  const scanPercentage = Math.min(100, (scanProgress.currentAd / Math.max(1, scanProgress.totalAds)) * 100).toFixed(0);

  // FULL-SCREEN SECURITY GATE FOR UNAUTHENTICATED USERS
  if (!authToken || !currentUser) {
    return (
      <div className="min-h-screen bg-[#f8fafd] dark:bg-[#202124] text-[#202124] dark:text-[#e8eaed] flex items-center justify-center p-5">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-[420px] bg-white dark:bg-[#292a2d] border border-[#e0e3e7] dark:border-[#3c4043] rounded-[24px] px-7 py-8 sm:px-9 sm:py-10 shadow-sm"
        >
          <div className="flex items-center gap-3 mb-8">
            <img src="/atlas-logo.png" alt="Atlas" className="h-10 w-10 object-contain rounded-xl" />
            <div>
              <div className="text-xl font-semibold tracking-tight">Atlas</div>
              <div className="text-xs text-[#5f6368] dark:text-[#9aa0a6]">Competitive intelligence workspace</div>
            </div>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-medium tracking-tight">Sign in to Atlas</h1>
            <p className="text-sm text-[#5f6368] dark:text-[#9aa0a6] mt-1.5">Use your workspace credentials to continue.</p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#5f6368] dark:text-[#bdc1c6]">Username</label>
              <input
                type="text"
                autoFocus
                autoComplete="username"
                value={usernameInput}
                onChange={(e) => { setUsernameInput(e.target.value); setLoginError(""); }}
                className="w-full h-12 bg-transparent border border-[#c7cacf] dark:border-[#5f6368] rounded-xl px-3.5 text-sm outline-none focus:border-[#1a73e8] focus:ring-1 focus:ring-[#1a73e8] transition-colors"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#5f6368] dark:text-[#bdc1c6]">Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={passwordInput}
                onChange={(e) => { setPasswordInput(e.target.value); setLoginError(""); }}
                className="w-full h-12 bg-transparent border border-[#c7cacf] dark:border-[#5f6368] rounded-xl px-3.5 text-sm outline-none focus:border-[#1a73e8] focus:ring-1 focus:ring-[#1a73e8] transition-colors"
              />
            </div>

            {loginError && (
              <div className="flex items-start gap-2 text-[#d93025] dark:text-[#f28b82] text-xs bg-[#fce8e6] dark:bg-[#5c2b29]/40 rounded-xl px-3 py-2.5">
                <span className="material-symbols-outlined text-[17px] flex-shrink-0">error</span>
                <span>{loginError}</span>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                className="h-10 px-6 rounded-full bg-[#1a73e8] hover:bg-[#1765cc] text-white text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8]/40"
              >
                Sign in
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="atlas-google-shell bg-bg-base text-text-main min-h-screen relative transition-colors duration-300 overflow-x-hidden pb-24 md:pb-0">
      <style>{`
        .atlas-google-shell {
          font-family: Roboto, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #f8fafd;
          color-scheme: light;
        }
        .atlas-google-shell button,
        .atlas-google-shell input,
        .atlas-google-shell textarea { font: inherit; }
        html:not(.dark) .atlas-google-shell .bg-surface-solid { background-color: #ffffff; }
        html:not(.dark) .atlas-google-shell .bg-surface-glass { background-color: rgba(255,255,255,.96); }
        html:not(.dark) .atlas-google-shell .bg-input-bg { background-color: #f1f3f4; }
        html:not(.dark) .atlas-google-shell .border-border-subtle { border-color: #e0e3e7; }
        html:not(.dark) .atlas-google-shell .text-text-main { color: #202124; }
        html:not(.dark) .atlas-google-shell .text-text-muted { color: #5f6368; }

        .dark .atlas-google-shell { background: #1f1f1f; color-scheme: dark; }
        .dark .atlas-google-shell .bg-bg-base { background-color: #1f1f1f; }
        .dark .atlas-google-shell .bg-surface-solid { background-color: #252525; }
        .dark .atlas-google-shell .bg-surface-glass { background-color: rgba(37,37,37,.96); }
        .dark .atlas-google-shell .bg-input-bg { background-color: #2b2b2b; }
        .dark .atlas-google-shell .border-border-subtle { border-color: #383838; }
        .dark .atlas-google-shell .text-text-main { color: #f1f3f4; }
        .dark .atlas-google-shell .text-text-muted { color: #a8aaad; }
        .dark .atlas-google-shell .bg-primary-container { background-color: #334155; }
        .dark .atlas-google-shell .text-on-primary-container { color: #dbe7ff; }
        .dark .atlas-google-shell input::placeholder,
        .dark .atlas-google-shell textarea::placeholder { color: #80868b; }

        .atlas-google-shell ::selection { background: rgba(26,115,232,.22); }
      `}</style>

      {/* GOOGLE-INSPIRED APP BAR */}
      <header className="fixed top-0 left-0 right-0 h-16 z-50 bg-bg-base/95 backdrop-blur-xl border-b border-border-subtle flex items-center px-3 sm:px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 sm:w-[180px]">
          <button
            type="button"
            onClick={() => { setActiveTab("dashboard"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className="flex items-center gap-2.5 min-w-0 group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue/30"
            title="Return to Dashboard"
          >
            <img src="/atlas-logo.png" alt="Atlas Logo" className="h-8 w-8 object-contain rounded-lg" />
            <span className="text-xl font-medium tracking-tight text-text-main hidden sm:block">Atlas</span>
          </button>
        </div>

        <div className="flex-1 flex justify-center min-w-0">
          <div className="hidden sm:block relative w-full max-w-[640px]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center h-11 rounded-full bg-input-bg border border-transparent focus-within:border-electric-blue/30 focus-within:bg-surface-solid transition-colors px-4 gap-3">
              <span className="material-symbols-outlined text-text-muted text-[20px]">search</span>
              <input
                value={directorySearch}
                onFocus={() => { if (directorySearch.trim().length >= 2) setActiveDropdown("globalSearch"); }}
                onChange={(e) => {
                  const value = e.target.value;
                  setDirectorySearch(value);
                  setActiveDropdown(value.trim().length >= 2 ? "globalSearch" : null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setActiveTab('directory');
                    setDirectoryFilter('all');
                    setActiveDropdown(null);
                  }
                  if (e.key === 'Escape') setActiveDropdown(null);
                }}
                placeholder="Search games, publishers, competitors, packages..."
                className="flex-1 min-w-0 bg-transparent outline-none text-sm text-text-main placeholder:text-text-muted/80"
              />
              {directorySearch ? (
                <button type="button" onClick={() => { setDirectorySearch(""); setActiveDropdown(null); }} className="w-7 h-7 rounded-full hover:bg-surface-glass flex items-center justify-center text-text-muted" aria-label="Clear search">
                  <span className="material-symbols-outlined text-[17px]">close</span>
                </button>
              ) : (
                <span className="hidden lg:inline-flex items-center rounded-md border border-border-subtle px-1.5 py-0.5 text-[9px] text-text-muted font-mono">Enter</span>
              )}
            </div>

            <AnimatePresence>
              {activeDropdown === "globalSearch" && directorySearch.trim().length >= 2 && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-[52px] left-0 right-0 bg-surface-solid border border-border-subtle rounded-[20px] shadow-xl overflow-hidden z-[70]"
                >
                  {globalSearchResultCount === 0 ? (
                    <div className="px-5 py-8 text-center text-sm text-text-muted">No Atlas results for “{directorySearch.trim()}”.</div>
                  ) : (
                    <div className="max-h-[430px] overflow-y-auto custom-scrollbar py-2">
                      {globalSearchResults.games.length > 0 && (
                        <div className="py-1">
                          <div className="px-4 py-1.5 text-[10px] font-medium text-text-muted">Games</div>
                          {globalSearchResults.games.map((game) => (
                            <button
                              type="button"
                              key={`search-game-${getGameIdentity(game)}`}
                              onClick={() => { setActiveDropdown(null); handleGameClick(game); }}
                              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-input-bg transition-colors"
                            >
                              <div className="w-9 h-9 rounded-xl overflow-hidden bg-input-bg border border-border-subtle flex-shrink-0 flex items-center justify-center">
                                {game.icon ? <img src={game.icon} alt="" className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted text-[18px]">sports_esports</span>}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-text-main truncate">{game.title || game.package_name}</div>
                                <div className="text-[10px] text-text-muted truncate">{game.publisher_name || game.package_name}</div>
                              </div>
                              <span className="material-symbols-outlined text-text-muted text-[18px]">chevron_right</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {globalSearchResults.publishers.length > 0 && (
                        <div className="py-1 border-t border-border-subtle">
                          <div className="px-4 py-1.5 text-[10px] font-medium text-text-muted">Publishers</div>
                          {globalSearchResults.publishers.map((publisher, index) => (
                            <button
                              type="button"
                              key={`search-pub-${publisher.competitorId}-${publisher.id ?? publisher.publisher_name}-${index}`}
                              onClick={() => openDirectoryFromSearch("publishers", publisher.publisher_name)}
                              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-input-bg transition-colors"
                            >
                              <span className="material-symbols-outlined text-text-muted text-[20px]">business</span>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-text-main truncate">{publisher.publisher_name}</div>
                                <div className="text-[10px] text-text-muted truncate">{publisher.competitorName || "Publisher"}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                      {globalSearchResults.competitors.length > 0 && (
                        <div className="py-1 border-t border-border-subtle">
                          <div className="px-4 py-1.5 text-[10px] font-medium text-text-muted">Competitors</div>
                          {globalSearchResults.competitors.map((competitor) => (
                            <button
                              type="button"
                              key={`search-comp-${competitor.id ?? competitor.name}`}
                              onClick={() => openDirectoryFromSearch("competitors", competitor.name)}
                              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-input-bg transition-colors"
                            >
                              <span className="material-symbols-outlined text-text-muted text-[20px]">domain</span>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-text-main truncate">{competitor.name}</div>
                                <div className="text-[10px] text-text-muted truncate">{competitor.ads_id || "Competitor"}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => openDirectoryFromSearch("all", directorySearch.trim())}
                        className="w-full border-t border-border-subtle px-4 py-3 text-left text-xs font-medium text-electric-blue hover:bg-input-bg transition-colors flex items-center justify-between"
                      >
                        View all results in Directory
                        <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                      </button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="relative flex items-center justify-end gap-1 sm:gap-2 sm:w-[330px]" onClick={(e) => e.stopPropagation()}>
          <div className="hidden lg:flex items-center bg-input-bg rounded-full p-1 border border-border-subtle">
            <button type="button" onClick={() => setViewMode("all")} className={cn("px-3.5 py-1.5 rounded-full text-[10px] font-medium transition-colors", viewMode === "all" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main")}>All time</button>
            <button type="button" onClick={() => setViewMode("latest")} className={cn("px-3.5 py-1.5 rounded-full text-[10px] font-medium transition-colors flex items-center gap-1.5", viewMode === "latest" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted hover:text-text-main")}>
              <span className={cn("w-1.5 h-1.5 rounded-full", viewMode === "latest" ? "bg-emerald-metric" : "bg-text-muted/50")}></span>Latest
            </button>
          </div>

          <button type="button" onClick={() => setIsGuideOpen(true)} className="w-10 h-10 rounded-full hover:bg-input-bg flex items-center justify-center text-text-muted hover:text-text-main transition-colors" title="How Atlas works">
            <span className="material-symbols-outlined text-[20px]">help</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveDropdown(activeDropdown === "account" ? null : "account")}
            className="w-9 h-9 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center text-sm font-semibold ml-1 ring-1 ring-transparent focus-visible:ring-electric-blue/40"
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
                className="absolute top-12 right-0 w-64 bg-surface-solid border border-border-subtle rounded-[20px] shadow-xl overflow-hidden z-[70]"
              >
                <div className="px-4 py-4 border-b border-border-subtle">
                  <div className="text-sm font-medium text-text-main truncate">{currentUser?.username || "Atlas user"}</div>
                  <div className="text-[11px] text-text-muted mt-0.5">{isAdmin ? "Administrator" : "View-only access"}</div>
                </div>
                <div className="p-2">
                  <button type="button" onClick={() => { setIsDarkMode(!isDarkMode); setActiveDropdown(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-input-bg text-left transition-colors">
                    <span className="material-symbols-outlined text-text-muted text-[19px]">{isDarkMode ? "light_mode" : "dark_mode"}</span>
                    <span className="text-sm text-text-main">{isDarkMode ? "Light theme" : "Dark theme"}</span>
                  </button>
                  {isAdmin && (
                    <button type="button" onClick={() => { setActiveTab("settings"); setActiveDropdown(null); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-input-bg text-left transition-colors">
                      <span className="material-symbols-outlined text-text-muted text-[19px]">settings</span>
                      <span className="text-sm text-text-main">Settings</span>
                    </button>
                  )}
                  <button type="button" onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-input-bg text-left transition-colors">
                    <span className="material-symbols-outlined text-text-muted text-[19px]">logout</span>
                    <span className="text-sm text-text-main">Sign out</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* MATERIAL NAVIGATION RAIL */}
      <aside className="hidden md:flex fixed left-0 top-16 bottom-0 z-40 w-[88px] bg-bg-base border-r border-border-subtle flex-col items-center py-3">
        <nav className="w-full flex flex-col items-center gap-1 px-2">
          {[
            { id: "dashboard", icon: "dashboard", label: "Dashboard" },
            { id: "directory", icon: "dataset", label: "Directory" },
            { id: "automated", icon: "track_changes", label: "Targets" },
            ...(isAdmin ? [{ id: "settings", icon: "settings", label: "Settings" }] : [])
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="w-full flex flex-col items-center gap-1 py-2.5 group"
            >
              <span className={cn(
                "w-14 h-8 rounded-full flex items-center justify-center transition-colors",
                activeTab === tab.id ? "bg-primary-container text-on-primary-container" : "text-text-muted group-hover:bg-input-bg group-hover:text-text-main"
              )}>
                <span className="material-symbols-outlined text-[21px]">{tab.icon}</span>
              </span>
              <span className={cn("text-[9px] font-medium", activeTab === tab.id ? "text-text-main" : "text-text-muted")}>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-auto w-full px-2 pb-2">
          <div className="flex flex-col items-center gap-1.5 py-2 rounded-2xl text-center">
            <span className={cn("w-2 h-2 rounded-full", isNodeOnline ? "bg-emerald-metric" : "bg-urgent-red")}></span>
            <span className="text-[8px] text-text-muted leading-tight">{isNodeOnline ? "System online" : "System offline"}</span>
          </div>
        </div>
      </aside>

      <div className="relative z-10 w-full md:pl-[88px]">
        <main className="relative min-h-screen px-3 sm:px-5 lg:px-7 pt-24 md:pt-24 pb-32 w-full max-w-[1500px] mx-auto">
          
          {!isNodeOnline && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 w-full bg-amber-500/10 border border-amber-500/25 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-center gap-2 text-amber-500 text-[11px] md:text-xs z-40 relative">
              <span className="flex items-center gap-2 font-medium"><span className="w-2 h-2 rounded-full bg-amber-500"></span> Server offline</span>
              <span className="hidden sm:block text-amber-500/50">|</span>
              <span className="text-center sm:text-left">Workstation server is unreachable. Active tracking hours: 9:00 AM – 6:00 PM.</span>
            </motion.div>
          )}

          {activeTab === "dashboard" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }} className="flex flex-col w-full gap-5 md:gap-6">
              <motion.div variants={FADE_UP} className="flex items-end justify-between gap-4 px-1">
                <div>
                  <h1 className="text-xl md:text-2xl font-medium text-text-main tracking-tight">Dashboard</h1>
                  <p className="text-xs md:text-sm text-text-muted mt-1">Competitive game intelligence at a glance.</p>
                </div>
                <div className="lg:hidden flex items-center bg-input-bg rounded-full p-1 border border-border-subtle">
                  <button type="button" onClick={() => setViewMode("all")} className={cn("px-3 py-1.5 rounded-full text-[10px] font-medium", viewMode === "all" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted")}>All time</button>
                  <button type="button" onClick={() => setViewMode("latest")} className={cn("px-3 py-1.5 rounded-full text-[10px] font-medium", viewMode === "latest" ? "bg-surface-solid text-text-main shadow-sm" : "text-text-muted")}>Latest</button>
                </div>
              </motion.div>

              <motion.div variants={FADE_UP} className={cn("w-full bg-surface-solid rounded-[24px] p-3 md:p-4 shadow-sm border border-border-subtle z-40 transition-all", isScanning && "ring-1 ring-electric-blue/40 opacity-80")}>
                <div className="flex flex-col md:flex-row flex-wrap items-end gap-3 md:gap-4 w-full">
                  <div className="flex-[2] min-w-full md:min-w-[200px] space-y-1.5 md:space-y-2">
                    <label className="text-[10px] md:text-[11px] text-text-muted font-medium pl-2 block">Target competitor / ID</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">my_location</span>
                      <input 
                        value={selectedSource === "manual" ? scanQuery : "Auto-Target Selected"} 
                        onChange={(e) => setScanQuery(e.target.value)} 
                        disabled={!isAdmin || selectedSource !== "manual" || isScanning}
                        className="w-full h-[48px] bg-input-bg text-text-main border border-border-subtle font-medium rounded-full py-3 pl-10 pr-4 outline-none transition-all focus:ring-2 focus:ring-electric-blue/30 disabled:opacity-50" 
                        placeholder={isAdmin ? "e.g. Voodoo or ID: 12345" : "Scan input restricted to Admin"} 
                        type="text" 
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:flex flex-[3] gap-4 w-full">
                    {/* DUAL COLUMN SEARCHABLE DROPDOWN */}
                    <div className="flex-[1.5] min-w-[140px] space-y-2 relative">
                      <label className="text-[10px] md:text-[11px] text-text-muted font-medium pl-2 block truncate">Target source</label>
                      <div onClick={(e) => { 
                            if(!isScanning && isAdmin) { 
                              e.stopPropagation(); 
                              if (activeDropdown !== 'source') setSourceSearch("");
                              setActiveDropdown(activeDropdown === 'source' ? null : 'source'); 
                            } 
                          }}
                        className={cn("w-full h-[48px] bg-input-bg text-text-main border border-border-subtle rounded-full py-3 px-3 md:pl-10 md:pr-4 outline-none transition-all cursor-pointer flex items-center justify-between select-none hover:border-text-muted/50", activeDropdown === 'source' && 'ring-2 ring-electric-blue/20', (!isAdmin || isScanning) && "opacity-50 cursor-not-allowed")}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px] hidden md:block">list_alt</span>
                        <span className="truncate font-medium text-xs md:text-sm">{getTargetSourceName()}</span>
                        <span className="material-symbols-outlined text-text-muted text-[18px] transition-transform" style={{ transform: activeDropdown === 'source' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                      </div>
                      <AnimatePresence>
                        {activeDropdown === 'source' && isAdmin && (
                          <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 w-full md:w-[520px] mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl p-2 z-50">
                            <div className="flex items-center gap-2 bg-input-bg border border-border-subtle rounded-lg px-3 py-2 mb-2">
                              <span className="material-symbols-outlined text-text-muted text-[18px]">search</span>
                              <input
                                autoFocus
                                value={sourceSearch}
                                onChange={(e) => setSourceSearch(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                className="w-full bg-transparent text-text-main text-sm outline-none placeholder:text-text-muted"
                                placeholder="Search competitors or lists..."
                              />
                              {sourceSearch && (
                                <button onClick={() => setSourceSearch("")} className="text-text-muted hover:text-text-main">
                                  <span className="material-symbols-outlined text-[16px]">close</span>
                                </button>
                              )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto custom-scrollbar">
                              <div className="min-w-0">
                                <div onClick={() => { setSelectedSource("manual"); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-medium transition-colors flex items-center gap-2.5">
                                  <span className="material-symbols-outlined text-text-muted text-[18px]">edit_note</span>
                                  <span>Manual entry</span>
                                </div>
                                <div className="px-3 py-1.5 mt-2 text-[10px] font-medium text-text-muted border-b border-border-subtle mb-1">Saved competitors</div>
                                {savedCompetitors
                                  .filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                  .map(c => (
                                    <div key={`comp_${c.id}`} onClick={() => { setSelectedSource(`comp_${c.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-medium transition-colors flex items-center gap-2.5 min-w-0">
                                      <span className="material-symbols-outlined text-text-muted text-[18px] flex-shrink-0">domain</span>
                                      <span className="truncate">{c.name}</span>
                                    </div>
                                  ))}
                                {savedCompetitors.length > 0 && savedCompetitors.filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-3 text-xs text-text-muted italic">No competitors found.</div>
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="px-3 py-1.5 text-[10px] font-medium text-text-muted border-b border-border-subtle mb-1">Target lists</div>
                                {targetLists
                                  .filter(l => (l.name || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                  .map(l => (
                                    <div key={`list_${l.id}`} onClick={() => { setSelectedSource(`list_${l.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-medium transition-colors flex items-center gap-2.5 min-w-0">
                                      <span className="material-symbols-outlined text-text-muted text-[18px] flex-shrink-0">list_alt</span>
                                      <span className="truncate">{l.name}</span>
                                    </div>
                                  ))}
                                {targetLists.length > 0 && targetLists.filter(l => (l.name || "").toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-3 text-xs text-text-muted italic">No lists found.</div>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <div className="flex-[1.5] min-w-[180px] space-y-2 relative">
                      <label className="text-[10px] md:text-[11px] text-text-muted font-medium pl-2 block truncate">Email report</label>
                      <motion.div
                        layout
                        transition={{ type: "spring", stiffness: 320, damping: 30 }}
                        onClick={(e) => {
                          if (!isScanning && isAdmin) {
                            e.stopPropagation();
                            setActiveDropdown(activeDropdown === 'email' ? null : 'email');
                          }
                        }}
                        className={cn(
                          "w-full h-[48px] bg-input-bg text-text-main border border-border-subtle rounded-full px-3 md:pl-10 md:pr-3 outline-none cursor-pointer flex items-center gap-2 select-none transition-[border-color,box-shadow,opacity]",
                          activeDropdown === 'email' && 'ring-2 ring-electric-blue/20',
                          selectedEmailList === 'custom' && EMAIL_REGEX.test(customReportEmail.trim()) && 'border-emerald-metric/40',
                          (!isAdmin || isScanning) && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px] hidden md:block">mail</span>

                        <div className="flex-1 min-w-0">
                          <AnimatePresence mode="wait" initial={false}>
                            {selectedEmailList === 'custom' && isAdmin ? (
                              <motion.input
                                key="custom-report-email"
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: 6 }}
                                transition={{ duration: 0.15 }}
                                autoFocus
                                type="email"
                                inputMode="email"
                                autoComplete="email"
                                value={customReportEmail}
                                onChange={(e) => setCustomReportEmail(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setSelectedEmailList('none');
                                    setCustomReportEmail('');
                                    e.currentTarget.blur();
                                  }
                                }}
                                disabled={isScanning}
                                placeholder="recipient@email.com"
                                className="w-full bg-transparent text-text-main placeholder:text-text-muted/70 text-xs md:text-sm font-medium outline-none disabled:cursor-not-allowed"
                              />
                            ) : (
                              <motion.span
                                key="saved-email-selection"
                                initial={{ opacity: 0, x: 8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -6 }}
                                transition={{ duration: 0.15 }}
                                className="block truncate font-medium text-xs md:text-sm"
                              >
                                {getEmailListName()}
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </div>

                        {selectedEmailList === 'custom' && customReportEmail.trim() && (
                          <span
                            className={cn(
                              "material-symbols-outlined text-[17px] flex-shrink-0",
                              EMAIL_REGEX.test(customReportEmail.trim()) ? "text-emerald-metric" : "text-urgent-red"
                            )}
                            title={EMAIL_REGEX.test(customReportEmail.trim()) ? "Valid email" : "Enter a valid email"}
                          >
                            {EMAIL_REGEX.test(customReportEmail.trim()) ? 'check_circle' : 'error'}
                          </span>
                        )}

                        <span
                          className="material-symbols-outlined text-text-muted text-[18px] transition-transform flex-shrink-0"
                          style={{ transform: activeDropdown === 'email' ? 'rotate(180deg)' : 'rotate(0deg)' }}
                        >
                          expand_more
                        </span>
                      </motion.div>

                      <AnimatePresence>
                        {activeDropdown === 'email' && isAdmin && (
                          <motion.div
                            variants={dropDownAnim}
                            initial="hidden"
                            animate="show"
                            exit="exit"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-full left-0 w-full mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl max-h-[320px] overflow-y-auto custom-scrollbar p-2 z-50"
                          >
                            <div
                              onClick={() => { setSelectedEmailList("none"); setActiveDropdown(null); }}
                              className={cn(
                                "px-3 py-2.5 rounded-lg hover:bg-input-bg text-text-main cursor-pointer text-sm font-medium transition-colors flex items-center gap-2",
                                selectedEmailList === 'none' && 'bg-input-bg'
                              )}
                            >
                              <span className="material-symbols-outlined text-[17px] text-text-muted">mail_off</span> Don't send
                            </div>

                            <div
                              onClick={() => { setSelectedEmailList("custom"); setActiveDropdown(null); }}
                              className={cn(
                                "px-3 py-2.5 mt-1 rounded-lg hover:bg-electric-blue/10 text-text-main cursor-pointer text-sm font-medium transition-colors flex items-center gap-2",
                                selectedEmailList === 'custom' && 'bg-electric-blue/10 text-electric-blue'
                              )}
                            >
                              <span className="material-symbols-outlined text-[17px] text-electric-blue">alternate_email</span>
                              <div className="min-w-0">
                                <div>Custom email</div>
                                <div className="text-[10px] font-normal text-text-muted truncate">Type a one-time recipient</div>
                              </div>
                            </div>

                            {emailLists.length > 0 && (
                              <>
                                <div className="px-3 py-1.5 mt-2 text-[10px] font-medium text-text-muted border-b border-border-subtle mb-1">Saved contacts</div>
                                {emailLists.map((emailList) => (
                                  <div
                                    key={emailList.id}
                                    onClick={() => { setSelectedEmailList(emailList.id); setActiveDropdown(null); }}
                                    className={cn(
                                      "px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-semibold transition-colors truncate flex items-center gap-2",
                                      selectedEmailList?.toString() === emailList.id.toString() && 'bg-input-bg text-electric-blue'
                                    )}
                                  >
                                    <span className="material-symbols-outlined text-[17px]">group</span>
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
                  
                  <div className="flex-1 min-w-full md:min-w-[120px] space-y-1.5 md:space-y-2 relative">
                    <label className="text-[10px] md:text-[11px] text-text-muted font-medium pl-2 block">Ad limit</label>
                    <div className={cn("flex items-center bg-input-bg border border-border-subtle rounded-full transition-all h-[48px]", (!isAdmin || isMaxAds || isScanning) && 'opacity-50 cursor-not-allowed', activeDropdown === 'limit' && 'ring-2 ring-electric-blue/20')}>
                      <button disabled={!isAdmin || isMaxAds || isScanning} onClick={() => setScanLimit(Math.max(1, scanLimit - 10))} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">remove</span></button>
                      <input disabled={!isAdmin || isMaxAds || isScanning} value={isMaxAds ? "ALL" : scanLimit} onChange={(e) => { const val = e.target.value.replace(/\D/g, ''); setScanLimit(val === '' ? '' : Number(val)); }} onBlur={() => { if (!scanLimit || scanLimit < 1) setScanLimit(1); }} className="w-full h-full bg-transparent text-text-main text-center font-medium tabular-nums outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed" type="text" />
                      <button disabled={!isAdmin || isMaxAds || isScanning} onClick={() => setScanLimit((scanLimit || 0) + 10)} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">add</span></button>
                      <div className="w-px h-full bg-border-subtle"></div>
                      <button disabled={!isAdmin || isMaxAds || isScanning} onClick={(e) => { e.stopPropagation(); if(isAdmin && !isMaxAds && !isScanning) setActiveDropdown(activeDropdown === 'limit' ? null : 'limit'); }} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-r-full transition-colors disabled:opacity-50 flex items-center justify-center"><span className="material-symbols-outlined text-[18px]">arrow_drop_down</span></button>
                    </div>
                    <AnimatePresence>
                      {activeDropdown === 'limit' && isAdmin && !isMaxAds && (
                        <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 w-full md:w-28 mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl overflow-hidden p-2 z-50 grid grid-cols-3 md:grid-cols-1 gap-1">
                          {[10, 20, 50, 100, 250, 500].map(val => <div key={val} onClick={() => { setScanLimit(val); setActiveDropdown(null); }} className="px-3 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-medium tabular-nums text-center transition-colors border border-border-subtle md:border-none">{val}</div>)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex gap-2 items-center flex-shrink-0 w-full xl:w-auto mt-2 xl:mt-0">
                    {isAdmin ? (
                      <>
                        <button onClick={() => setIsMaxAds(!isMaxAds)} disabled={isScanning} className={cn("h-[48px] px-4 rounded-full font-medium text-sm transition-all flex items-center justify-center gap-2 border border-border-subtle disabled:opacity-50 disabled:cursor-not-allowed", isMaxAds ? 'bg-primary-container text-on-primary-container border-transparent' : 'bg-surface-solid text-text-main')} title="Scan every single ad. No limits."><span className="material-symbols-outlined text-[18px] hidden md:block">all_inclusive</span> Max</button>
                        
                        {isScanning ? (
                          <button onClick={handleCancelScan} className="h-[48px] flex-1 md:flex-none bg-urgent-red/10 text-urgent-red hover:bg-urgent-red hover:text-white font-medium px-6 rounded-full border border-urgent-red/20 flex justify-center items-center gap-2 transition-all active:scale-[0.98]">
                            <span className="material-symbols-outlined text-[20px]">cancel</span> Cancel
                          </button>
                        ) : (
                          <button onClick={handleRunScan} className="h-[48px] flex-1 md:flex-none bg-[#8ab4f8] text-[#202124] font-medium px-7 rounded-full shadow-sm hover:shadow-md transition-all flex justify-center items-center gap-2 active:scale-[0.98]">
                            <span className="material-symbols-outlined text-[20px]">data_usage</span> Scan
                          </button>
                        )}

                        <button onClick={handleReset} disabled={isScanning} title="Clear latest scan view" className="h-[48px] w-[48px] bg-input-bg text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 border border-border-subtle rounded-full transition-all flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed">
                          <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
                        </button>
                      </>
                    ) : (
                      <div className="h-[46px] md:h-[50px] px-5 rounded-full bg-input-bg border border-border-subtle text-text-muted text-xs flex items-center gap-2 font-medium select-none cursor-not-allowed">
                        <span className="material-symbols-outlined text-[17px]">lock</span> Read-only view
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
                {[
                  { label: "Last scan", value: lastScanTime, icon: "schedule", tone: "text-text-muted", iconBg: "bg-input-bg", note: "Most recent run" },
                  { id: "competitors", label: "Competitors", value: displayStats.competitors, icon: "groups", tone: "text-electric-blue", iconBg: "bg-electric-blue/10", note: viewMode === "latest" ? "In latest scan" : "Tracked groups" },
                  { id: "publishers", label: "Publishers", value: displayStats.accounts, icon: "business_center", tone: "text-electric-blue", iconBg: "bg-electric-blue/10", note: viewMode === "latest" ? "In latest scan" : "Discovered accounts" },
                  { id: "games", label: "Games", value: displayStats.games, icon: "sports_esports", tone: "text-electric-blue", iconBg: "bg-electric-blue/10", note: viewMode === "latest" ? "In latest scan" : "Unique titles" }
                ].map((stat) => {
                  const isExpandable = Boolean(stat.id);

                  return (
                    <motion.button
                      type="button"
                      key={stat.label}
                      variants={FADE_UP}
                      whileTap={isExpandable ? { scale: 0.99 } : undefined}
                      onClick={() => isExpandable && openStatPanel(stat.id)}
                      disabled={!isExpandable}
                      className={cn(
                        "bg-surface-solid rounded-[24px] p-4 md:p-5 border border-border-subtle text-left min-h-[130px] md:min-h-[150px] flex flex-col justify-between transition-colors outline-none",
                        isExpandable ? "cursor-pointer hover:bg-input-bg/45 focus-visible:ring-2 focus-visible:ring-electric-blue/40" : "cursor-default"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className={cn("w-9 h-9 rounded-full flex items-center justify-center", stat.iconBg, stat.tone)}>
                          <span className="material-symbols-outlined text-[20px]">{stat.icon}</span>
                        </div>
                        {isExpandable && <span className="material-symbols-outlined text-[18px] text-text-muted">chevron_right</span>}
                      </div>

                      <div className="mt-5">
                        <p className="text-[10px] md:text-[11px] text-text-muted font-medium">{stat.label}</p>
                        <div className="flex items-end justify-between gap-2 mt-1">
                          <span className="text-2xl md:text-3xl font-medium text-text-main tracking-tight">{stat.value}</span>
                          <span className="text-[9px] md:text-[10px] text-text-muted text-right hidden sm:block">{stat.note}</span>
                        </div>
                      </div>
                    </motion.button>
                  );
                })}
              </div>

              <DashboardTelemetry historyData={historyData} isDarkMode={isDarkMode} />

              <motion.div variants={FADE_UP} className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-5">
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
              </motion.div>
            </motion.div>
          )}

          {/* DIRECTORY SEARCH TAB */}
          {activeTab === "directory" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }} className="flex flex-col w-full gap-6 md:gap-8">
              {/* Page Title (Scrolls away naturally) */}
              <div>
                <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">
                  Master Directory {viewMode === 'latest' && <span className="inline-flex items-center align-middle text-emerald-metric text-xs ml-2 font-medium bg-emerald-metric/10 px-2.5 py-1 rounded-full border border-emerald-metric/15">● Latest</span>}
                </h1>
                <p className="font-body-sm md:font-body-md text-text-muted mt-1">
                  Full database index of all intercepted competitors, publishers, and games.
                </p>
              </div>

              {/* FROZEN / STICKY BAR: Docks right underneath the fixed top header on scroll */}
              <div className="sticky top-16 md:top-20 z-20 bg-bg-base/95 backdrop-blur-xl py-3 -mx-3 sm:-mx-6 lg:-mx-8 px-3 sm:px-6 lg:px-8 border-b border-border-subtle flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-sm transition-colors">
                
                {/* Filter Category Pills */}
                <div className="flex overflow-x-auto items-center gap-2 custom-scrollbar flex-1 min-w-0">
                  {[
                    { id: "all", label: `All (${filteredGames.length + processedAccounts.length + filteredCompetitors.length})` },
                    { id: "games", label: `Games (${filteredGames.length})` },
                    { id: "publishers", label: `Publishers (${processedAccounts.length})` },
                    { id: "competitors", label: `Competitors (${filteredCompetitors.length})` }
                  ].map(tab => (
                    <button 
                      key={tab.id} 
                      onClick={() => setDirectoryFilter(tab.id)} 
                      className={cn(
                        "px-4 py-2 rounded-xl text-xs  font-bold transition-all whitespace-nowrap flex-shrink-0", 
                        directoryFilter === tab.id ? "bg-electric-blue text-white" : "bg-surface-glass text-text-muted hover:text-text-main border border-border-subtle shadow-sm"
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Pinned Search Input */}
                <div className="relative w-full md:w-80 flex-shrink-0">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">search</span>
                  <input 
                    value={directorySearch} 
                    onChange={(e) => setDirectorySearch(e.target.value)} 
                    placeholder="Search games, packages..." 
                    className="w-full bg-surface-solid border border-border-subtle rounded-xl py-2.5 pl-10 pr-9 outline-none focus:ring-2 focus:ring-electric-blue/50 text-text-main shadow-sm font-body-sm transition-shadow text-xs md:text-sm" 
                  />
                  {directorySearch && (
                    <button onClick={() => setDirectorySearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  )}
                </div>

              </div>

              {(directoryFilter === "all" || directoryFilter === "games") && filteredGames.length > 0 && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
                    <h3 className="text-xs text-text-muted font-medium flex items-center gap-2">
                      <span className="material-symbols-outlined text-electric-blue text-[18px]">sports_esports</span> Mobile Games
                    </h3>

                    <div className="relative self-start sm:self-auto">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveDropdown(activeDropdown === "gameSort" ? null : "gameSort");
                        }}
                        className="h-9 px-3 rounded-xl bg-surface-solid border border-border-subtle text-text-main hover:bg-input-bg transition-colors flex items-center gap-2 text-[10px] md:text-xs font-medium min-w-[138px] justify-between"
                        title="Sort directory games"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="material-symbols-outlined text-[15px] text-electric-blue">sort</span>
                          <span className="truncate">{DIRECTORY_GAME_SORT_OPTIONS.find(option => option.id === directoryGameSort)?.label || "Ad Activity"}</span>
                        </span>
                        <span className="material-symbols-outlined text-[15px] text-text-muted">expand_more</span>
                      </button>

                      <AnimatePresence>
                        {activeDropdown === "gameSort" && (
                          <motion.div
                            variants={dropDownAnim}
                            initial="hidden"
                            animate="show"
                            exit="exit"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-full right-0 mt-1 w-44 bg-surface-solid border border-border-subtle rounded-lg shadow-xl overflow-hidden z-50 py-1"
                          >
                            {DIRECTORY_GAME_SORT_OPTIONS.map(option => (
                              <button
                                key={option.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDirectoryGameSort(option.id);
                                  setActiveDropdown(null);
                                }}
                                className={cn(
                                  "w-full text-left px-3 py-2 text-xs font-medium transition-colors",
                                  directoryGameSort === option.id
                                    ? "bg-electric-blue/10 text-electric-blue"
                                    : "text-text-muted hover:text-text-main hover:bg-input-bg"
                                )}
                              >
                                {option.label}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6">
                    {sortedDirectoryGames.map(game => (
                      <motion.div whileHover={{ y: -1 }} key={game.id} onClick={() => handleGameClick(game)} className="bg-surface-glass backdrop-blur-xl rounded-2xl border border-border-subtle overflow-hidden shadow-sm hover:border-electric-blue/25 transition-colors cursor-pointer group flex flex-col relative">
                        {isAdmin && (
                          <button
                            onClick={(e) => handleDeleteGame(e, game)}
                            disabled={isScanning}
                            className="absolute top-3 right-3 z-20 w-8 h-8 rounded-lg bg-surface-solid/90 backdrop-blur-md border border-border-subtle text-text-muted hover:text-urgent-red hover:border-urgent-red/30 hover:bg-urgent-red/10 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
                            title={isScanning ? "Wait for the active scan to finish" : "Delete game from Atlas"}
                            aria-label={`Delete ${game.title || game.package_name || "game"}`}
                          >
                            <span className="material-symbols-outlined text-[17px]">delete</span>
                          </button>
                        )}
                        {game.header_image && (
                          <div className="h-24 md:h-32 w-full overflow-hidden bg-input-bg relative">
                            <img src={game.header_image} alt={game.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                            {game.video && <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded-md text-[9px] md:text-[10px] text-white flex items-center gap-1"><span className="material-symbols-outlined text-[12px] text-white/80">play_arrow</span> Trailer</div>}
                          </div>
                        )}
                        <div className="p-4 md:p-5 flex-1 flex flex-col justify-between relative z-10">
                          <div className="flex gap-3 md:gap-4 items-start">
                            <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-surface-solid border border-border-subtle overflow-hidden flex-shrink-0 shadow-sm">
                              {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted flex h-full items-center justify-center">sports_esports</span>}
                            </div>
                            <div className="min-w-0 flex-1 pr-8">
                              <h4 className="font-body-sm md:font-body-md font-semibold text-text-main truncate group-hover:text-electric-blue transition-colors">{game.title}</h4>
                              <p className="font-body-xs text-[10px] md:text-sm text-text-muted truncate">{game.publisher_name}</p>
                              <p className="font-mono text-[9px] md:text-[10px] text-text-muted/70 truncate mt-0.5">{game.package_name}</p>
                            </div>
                          </div>
                          
                          <div className="mt-3 md:mt-4 pt-3 md:pt-4 border-t border-border-subtle/50 flex items-center justify-between">
                            <span className="text-[10px] md:text-xs font-medium text-electric-blue">{viewMode === "latest" ? `${game.ad_count || 0} Ads Seen` : `${game.ad_count || 0} Detections`}</span>
                            <div className="flex items-center gap-2">
                              {game.installs && <span className="text-[9px] md:text-[10px] font-medium bg-input-bg text-text-muted px-1.5 md:px-2 py-0.5 rounded-full">{game.installs}</span>}
                              {Number(game.rating) > 0 && <span className="text-[9px] md:text-[10px] font-medium bg-input-bg text-text-muted px-1.5 md:px-2 py-0.5 rounded-full flex items-center gap-1"><span className="material-symbols-outlined text-[12px]">star</span>{Number(game.rating).toFixed(1)}</span>}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {(directoryFilter === "all" || directoryFilter === "publishers") && processedAccounts.length > 0 && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 md:gap-4">
                    <h3 className="text-xs text-text-muted font-medium flex items-center gap-2">
                      <span className="material-symbols-outlined text-electric-blue text-[18px]">folder</span> Publisher accounts
                    </h3>
                    
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <div onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === 'pubGroup' ? null : 'pubGroup'); }}
                             className="bg-surface-glass backdrop-blur-xl text-text-main border border-border-subtle text-[9px] md:text-[10px] font-bold rounded-lg px-2 md:px-3 py-1.5 outline-none shadow-sm cursor-pointer flex items-center justify-between gap-2 w-[120px] md:min-w-[140px] hover:border-text-muted transition-colors">
                          <span className="truncate">{pubFilterComp === 'all' ? 'All Groups' : competitorTree.find(c => c.id.toString() === pubFilterComp.toString())?.name || 'All Groups'}</span>
                          <span className="material-symbols-outlined text-[14px]">expand_more</span>
                        </div>
                        <AnimatePresence>
                          {activeDropdown === 'pubGroup' && (
                            <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" className="absolute top-full right-0 md:left-0 mt-1 w-48 bg-surface-solid border border-border-subtle rounded-lg shadow-xl max-h-48 overflow-y-auto custom-scrollbar z-50 py-1">
                               <div onClick={() => { setPubFilterComp('all'); setActiveDropdown(null); }} className="px-3 py-2 text-[10px] font-medium hover:bg-input-bg cursor-pointer">All Groups</div>
                               {competitorTree.map(c => (
                                 <div key={c.id} onClick={() => { setPubFilterComp(c.id); setActiveDropdown(null); }} className="px-3 py-2 text-[10px] font-medium hover:bg-input-bg cursor-pointer truncate">
                                   {c.name}
                                 </div>
                               ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <button onClick={() => setPubFilterNew(!pubFilterNew)} className={cn("px-2 py-1.5 rounded-lg text-[9px] md:text-[10px] font-medium border transition-colors shadow-sm flex items-center gap-1", pubFilterNew ? "bg-electric-blue/10 text-electric-blue border-electric-blue/20" : "bg-surface-solid text-text-muted border-border-subtle hover:text-text-main")}>
                        <span className="material-symbols-outlined text-[12px] md:text-[14px]">local_fire_department</span> 7d
                      </button>
                      <div className="flex bg-surface-glass backdrop-blur-xl rounded-lg border border-border-subtle p-0.5 shadow-sm">
                        {[ { id: 'name', label: 'A-Z' }, { id: 'games', label: 'Games' }].map(btn => (
                          <button key={btn.id} onClick={() => setPubSort(btn.id)} className={cn("px-2 py-1 text-[9px] md:text-[10px] font-medium rounded-md transition-all", pubSort === btn.id ? "bg-primary-container text-on-primary-container" : "text-text-muted hover:text-text-main")}>{btn.label}</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
                    {processedAccounts.map(acc => {
                      const encoded = encodeURIComponent(acc.publisher_name).replace(/%20/g, '+');
                      return (
                        <motion.div whileHover={{ y: -2 }} key={acc.id} className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-xl p-3 md:p-4 shadow-sm flex flex-col justify-between hover:shadow-lg transition-all gap-3 relative overflow-hidden group">
                          
                          <div className="flex justify-between items-start min-w-0 relative z-10">
                            <div className="min-w-0 pr-2">
                              <h5 className="font-body-sm md:font-body-md font-semibold text-text-main truncate">{acc.publisher_name}</h5>
                              <p className="font-body-xs text-[10px] md:text-sm text-text-muted truncate">Group: <span className="text-text-main">{acc.competitorName}</span></p>
                            </div>
                            <div className="flex items-center gap-1">
                              {isAdmin && (
                                <button onClick={(e) => handleNukePublisherData(e, acc.id, acc.publisher_name)} className="text-text-muted hover:text-urgent-red p-1 md:p-1.5 hover:bg-surface-solid rounded-lg transition-colors flex-shrink-0 border border-transparent hover:border-border-subtle shadow-sm" title="Delete publisher data"><span className="material-symbols-outlined text-[16px] md:text-[18px]">delete</span></button>
                              )}
                              <a href={`https://play.google.com/store/apps/developer?id=${encoded}`} target="_blank" rel="noreferrer" className="text-text-muted hover:text-electric-blue p-1 md:p-1.5 hover:bg-surface-solid rounded-lg transition-colors flex-shrink-0 border border-transparent hover:border-border-subtle shadow-sm"><span className="material-symbols-outlined text-[16px] md:text-[18px]">open_in_new</span></a>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 border-t border-border-subtle/50 pt-2 md:pt-3 relative z-10">
                            <span className="text-[9px] md:text-[10px] font-medium bg-input-bg text-text-muted border border-border-subtle px-1.5 md:px-2 py-0.5 rounded-full">{acc.totalGames} Games</span>
                            <span className="text-[9px] md:text-[10px] font-medium bg-input-bg text-text-muted border border-border-subtle px-1.5 md:px-2 py-0.5 rounded-full">{formatInstalls(acc.totalInstalls)} Installs</span>
                            {acc.recentGame && <span className="text-[9px] md:text-[10px] font-medium bg-electric-blue/10 text-electric-blue px-1.5 md:px-2 py-0.5 rounded-full ml-auto flex items-center gap-1"><span className="material-symbols-outlined text-[12px]">schedule</span>Recent</span>}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(directoryFilter === "all" || directoryFilter === "competitors") && filteredCompetitors.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-xs text-text-muted font-medium flex items-center gap-2"><span className="material-symbols-outlined text-primary text-[18px]">corporate_fare</span> Competitor Entities</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                    {filteredCompetitors.map(comp => (
                      <motion.div whileHover={{ y: -2 }} key={comp.id} className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-xl p-4 md:p-5 shadow-sm flex items-center justify-between hover:shadow-md transition-all group">
                        <div className="min-w-0 pr-4">
                          <h4 className="font-body-sm md:font-body-md font-semibold text-text-main truncate">{comp.name}</h4>
                          <p className="font-mono text-[10px] md:text-xs text-text-muted mt-0.5 md:mt-1 truncate">{comp.ads_id || "Direct Target"}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {isAdmin && (
                            <button onClick={(e) => handleNukeCompetitorData(e, comp.id, comp.name)} className="text-text-muted hover:text-urgent-red p-1.5 rounded-lg transition-colors border border-transparent hover:border-border-subtle hover:bg-surface-solid opacity-0 group-hover:opacity-100" title="Delete group data"><span className="material-symbols-outlined text-[16px] md:text-[18px]">delete</span></button>
                          )}
                          {isAdmin && (
                            <button onClick={() => { setSelectedSource(`comp_${comp.id}`); setActiveTab("dashboard"); window.scrollTo(0,0); }} className="bg-surface-solid hover:bg-electric-blue hover:text-white border border-border-subtle px-3 py-1.5 md:px-4 md:py-2 rounded-lg md:rounded-xl text-[10px] md:text-xs  font-bold transition-all shadow-sm">Target</button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* DATABASE TARGETS TAB */}
          {activeTab === "automated" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-6 md:gap-8 max-w-7xl mx-auto">
              <motion.div variants={FADE_UP} className="flex justify-between items-end mb-4">
                <div>
                  <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">Targets</h1>
                  <p className="text-sm text-text-muted mt-2">
                    {isAdmin ? "Manage saved competitors, batch lists, and email reporting targets." : "View saved competitor targets and active batch lists."}
                  </p>
                </div>
              </motion.div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">
                {/* FORMS (ADMIN ONLY) */}
                {isAdmin && (
                  <motion.div variants={FADE_UP} className="lg:col-span-4 space-y-6 md:space-y-8">
                    <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-sm">
                      <h2 className="text-base font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-[22px]">person_add</span> Save Competitor</h2>
                      <form onSubmit={handleSaveCompetitor} className="space-y-4">
                        <input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Playmax" type="text" />
                        <input value={newCompAdsId} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="AR123456789012345" type="text" />
                        <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-electric-blue/40 hover:text-electric-blue font-medium py-3.5 px-6 rounded-xl transition-all disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save Entity"}</button>
                      </form>
                    </div>
                    
                    <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-sm">
                      <h2 className="text-base font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-[22px]">format_list_bulleted_add</span> Create Batch List</h2>
                      <form onSubmit={handleCreateList} className="space-y-4">
                        <input value={newListName} onChange={(e) => setNewListName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Tier 1 Tracking" type="text" />
                        <textarea value={newListTargets} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm resize-none" placeholder="AR123...&#10;AR456..." />
                        <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-electric-blue/40 hover:text-electric-blue font-medium py-3.5 px-6 rounded-xl transition-all disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save List"}</button>
                      </form>
                    </div>

                    <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-sm">
                      <h2 className="text-base font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-[22px]">contact_mail</span> Add Recipient</h2>
                      <form onSubmit={handleSaveEmailList} className="space-y-4">
                        <input value={newEmailName} onChange={(e) => setNewEmailName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-sm md:font-body-md rounded-xl py-2.5 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Marketing Team" type="text" />
                        <textarea value={newEmailTargets} onChange={(e) => setNewEmailTargets(e.target.value)} className="w-full h-16 md:h-20 bg-input-bg text-text-main border border-border-subtle text-xs md:text-sm rounded-xl py-2.5 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm resize-none" placeholder="hello@gmail.com, team@..." />
                        <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-electric-blue/40 hover:text-electric-blue font-medium py-2.5 px-6 rounded-xl transition-all disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save Contact"}</button>
                      </form>
                    </div>
                  </motion.div>
                )}

                {/* LISTS */}
                <motion.div variants={FADE_UP} className={cn("space-y-6 md:space-y-8", isAdmin ? "lg:col-span-8" : "lg:col-span-12")}>
                  <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 min-h-[250px] shadow-sm">
                    <h2 className="text-sm font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">person</span> Saved competitors</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {savedCompetitors.map((comp) => (
                        <motion.div whileHover={{ y: -2 }} key={comp.id} className="bg-surface-solid border border-border-subtle rounded-xl p-4 flex items-center justify-between transition-all group shadow-sm">
                          <div className="min-w-0 pr-4"><h3 className="text-sm font-semibold text-text-main truncate">{comp.name}</h3><p className="font-mono text-xs text-text-muted mt-1 truncate">{comp.ads_id}</p></div>
                          {isAdmin && (
                            <button onClick={() => handleDeleteCompetitor(comp.id)} className="bg-surface-glass text-urgent-red border border-border-subtle p-2.5 rounded-lg hover:bg-urgent-red hover:text-white shadow-sm transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"><span className="material-symbols-outlined text-[20px]">delete</span></button>
                          )}
                        </motion.div>
                      ))}
                      {savedCompetitors.length === 0 && <div className="col-span-full text-sm text-text-muted py-6 text-center italic border-2 border-dashed border-border-subtle rounded-xl">No competitors saved.</div>}
                    </div>
                  </div>

                  <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-5 md:p-6 min-h-[250px] shadow-sm">
                    <div className="flex items-center gap-2 mb-5">
                      <span className="material-symbols-outlined text-electric-blue text-[20px]">view_list</span>
                      <div>
                        <h2 className="text-sm md:text-base font-semibold text-text-main tracking-tight">Batch lists</h2>
                        <p className="text-[10px] md:text-xs text-text-muted mt-0.5">Reusable groups of advertiser IDs for multi-target scans.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {targetLists.map((list) => (
                        <motion.div
                          key={list.id}
                          className="group bg-surface-solid border border-border-subtle rounded-2xl p-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                        >
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-text-main truncate">{list.name}</h3>
                              <p className="text-[10px] text-text-muted mt-0.5">
                                {(list.targets?.length || 0)} {(list.targets?.length || 0) === 1 ? "target" : "targets"}
                              </p>
                            </div>

                            {isAdmin && (
                              <button
                                onClick={() => handleDeleteList(list.id)}
                                className="w-8 h-8 rounded-full text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 flex items-center justify-center opacity-60 group-hover:opacity-100 focus:opacity-100 transition-all flex-shrink-0"
                                title="Delete batch list"
                                aria-label={`Delete ${list.name}`}
                              >
                                <span className="material-symbols-outlined text-[17px]">delete</span>
                              </button>
                            )}
                          </div>

                          <div className="bg-input-bg/70 border border-border-subtle rounded-xl p-3 max-h-28 overflow-y-auto custom-scrollbar">
                            {(list.targets || []).map((target, index) => (
                              <div key={`${target}-${index}`} className="flex items-center gap-2 py-1 text-[10px] md:text-[11px] text-text-muted font-mono">
                                <span className="w-1 h-1 rounded-full bg-text-muted/40 flex-shrink-0"></span>
                                <span className="truncate">{target}</span>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      ))}

                      {targetLists.length === 0 && (
                        <div className="col-span-full rounded-2xl border border-dashed border-border-subtle px-5 py-8 text-center">
                          <div className="w-10 h-10 rounded-full bg-input-bg flex items-center justify-center mx-auto mb-2 text-text-muted">
                            <span className="material-symbols-outlined text-[20px]">playlist_add</span>
                          </div>
                          <p className="text-xs font-medium text-text-main">No batch lists yet</p>
                          <p className="text-[10px] text-text-muted mt-1">Create one to scan multiple advertisers together.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 min-h-[250px] shadow-sm">
                    <h2 className="text-sm font-semibold text-text-main mb-5 flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">mail</span> Report recipients</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {emailLists.map((list) => (
                        <motion.div whileHover={{ y: -2 }} key={list.id} className="bg-surface-solid border border-border-subtle rounded-xl p-5 flex flex-col transition-all group shadow-sm">
                          <h3 className="text-sm font-semibold text-text-main truncate mb-4">{list.name}</h3>
                          <div className="bg-input-bg border border-border-subtle rounded-lg p-3 h-16 overflow-y-auto text-xs text-text-muted mb-4">
                            {parseJsonArray(list.emails).map((e, i) => <div key={i} className="truncate mb-1">{e}</div>)}
                          </div>
                          {isAdmin && (
                            <button onClick={() => handleDeleteEmail(list.id)} className="mt-auto bg-surface-glass text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 border border-border-subtle text-xs font-medium py-2.5 px-4 rounded-lg shadow-sm transition-all flex justify-center items-center gap-2 opacity-0 group-hover:opacity-100"><span className="material-symbols-outlined text-[18px]">delete</span> Delete recipient</button>
                          )}
                        </motion.div>
                      ))}
                      {emailLists.length === 0 && <div className="col-span-full text-sm text-text-muted py-6 text-center italic border-2 border-dashed border-border-subtle rounded-xl">No recipients saved.</div>}
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}

          {/* SETTINGS TAB (ADMIN ONLY) */}
          {activeTab === "settings" && isAdmin && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-6 md:gap-8 max-w-4xl mx-auto">
              <div>
                <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">System Settings</h1>
                <p className="font-body-sm md:font-body-md text-text-muted mt-1">Configure Google Sheets integrations and PDF report templates.</p>
              </div>

              <form onSubmit={handleSaveSettings} className="space-y-4 md:space-y-6">
                <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-sm space-y-6">
                  <h3 className="text-base font-semibold text-text-main flex items-center gap-2">
                    <span className="material-symbols-outlined text-electric-blue text-[22px]">cloud_sync</span> Cloud configuration
                  </h3>

                  <div className="space-y-2">
                    <label className="text-xs text-text-muted block font-medium">Google Spreadsheet ID</label>
                    <input type="text" value={settings.google_sheet_id} onChange={(e) => setSettings(s => ({ ...s, google_sheet_id: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/40" placeholder="e.g. 1tQysvSfu..." />
                  </div>
                </div>

                <div className="bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-sm space-y-6">
                  <h3 className="text-base font-semibold text-text-main flex items-center gap-2">
                    <span className="material-symbols-outlined text-text-muted text-[22px]">description</span> PDF template
                  </h3>

                  <div className="space-y-2">
                    <label className="text-xs text-text-muted block font-medium">Email Subject Header</label>
                    <input type="text" value={settings.report_subject_template} onChange={(e) => setSettings(s => ({ ...s, report_subject_template: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/40" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-text-muted block font-medium">Opening Notes</label>
                    <textarea rows={3} value={settings.report_notes} onChange={(e) => setSettings(s => ({ ...s, report_notes: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/40 resize-none" />
                  </div>
                </div>

                <div className="flex flex-col-reverse sm:flex-row items-center justify-between pt-2 gap-4 relative z-10">
                  {settingsStatus && <span className={cn("text-xs md:text-sm font-medium bg-surface-glass px-3 md:px-4 py-2 rounded-lg border border-border-subtle shadow-sm w-full sm:w-auto text-center", settingsStatus.includes("success") ? "text-emerald-metric" : "text-urgent-red")}>{settingsStatus}</span>}
                  <button type="submit" disabled={isSavingSettings} className="w-full sm:w-auto bg-electric-blue text-white font-medium py-3 px-6 md:py-3.5 md:px-8 rounded-xl hover:bg-blue-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-[10px] md:text-xs">
                    <span className="material-symbols-outlined text-[18px] md:text-[20px]">{isSavingSettings ? 'sync' : 'save'}</span>
                    {isSavingSettings ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            </motion.div>
          )}

        </main>
      </div>

      {/* MOBILE MATERIAL NAVIGATION BAR */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-bg-base/95 backdrop-blur-xl border-t border-border-subtle px-2 pb-[env(safe-area-inset-bottom)]">
        <div className="h-[72px] flex items-center justify-around">
          {[
            { id: "dashboard", icon: "dashboard", label: "Dashboard" },
            { id: "directory", icon: "dataset", label: "Directory" },
            { id: "automated", icon: "track_changes", label: "Targets" },
            ...(isAdmin ? [{ id: "settings", icon: "settings", label: "Settings" }] : [])
          ].map((tab) => (
            <button key={`mobile-${tab.id}`} type="button" onClick={() => setActiveTab(tab.id)} className="flex flex-col items-center gap-1 min-w-[64px]">
              <span className={cn(
                "w-14 h-8 rounded-full flex items-center justify-center transition-colors",
                activeTab === tab.id ? "bg-primary-container text-on-primary-container" : "text-text-muted"
              )}>
                <span className="material-symbols-outlined text-[20px]">{tab.icon}</span>
              </span>
              <span className={cn("text-[9px] font-medium", activeTab === tab.id ? "text-text-main" : "text-text-muted")}>{tab.label}</span>
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
              color: "text-electric-blue",
              total: statCompetitors.length,
              placeholder: "Search competitors or advertiser IDs...",
            },
            publishers: {
              title: "Publishers",
              subtitle: "Publisher accounts discovered across groups",
              icon: "account_box",
              color: "text-electric-blue",
              total: statPublishers.length,
              placeholder: "Search publishers or competitor groups...",
            },
            games: {
              title: "Games",
              subtitle: "Unique games discovered by Atlas",
              icon: "sports_esports",
              color: "text-electric-blue",
              total: statGames.length,
              placeholder: "Search games, publishers, or package names...",
            },
          }[activeStatPanel];

          return (
            <div className="fixed inset-0 z-[115] flex items-center justify-center p-3 sm:p-5 md:p-8">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={closeStatPanel}
                className="absolute inset-0 bg-black/70"
              />

              <motion.div
                initial={{ opacity: 0, scale: 0.985, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.985, y: 8 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="relative z-10 w-full max-w-5xl h-[82vh] md:h-[78vh] bg-surface-solid border border-border-subtle rounded-2xl md:rounded-3xl shadow-2xl overflow-hidden flex flex-col will-change-transform"
              >
                <div className="relative p-4 sm:p-5 md:p-6 border-b border-border-subtle bg-surface-glass overflow-hidden flex-shrink-0">

                  <div className="relative z-10 flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 md:gap-4 min-w-0">
                      <div className={cn("w-11 h-11 md:w-14 md:h-14 rounded-xl md:rounded-2xl bg-surface-solid border border-border-subtle shadow-sm flex items-center justify-center flex-shrink-0", meta.color)}>
                        <span className="material-symbols-outlined text-[24px] md:text-[30px]">{meta.icon}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-headline-lg text-xl md:text-2xl text-text-main font-bold tracking-tight">{meta.title}</h2>
                          <span className={cn("text-[10px] md:text-xs font-medium px-2 py-0.5 rounded-md bg-input-bg border border-border-subtle", meta.color)}>{meta.total}</span>
                        </div>
                        <p className="font-body-xs md:font-body-sm text-text-muted mt-1 truncate">
                          {viewMode === "latest" && <span className="text-emerald-metric font-bold mr-2">● Latest</span>}
                          {meta.subtitle}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={closeStatPanel}
                      className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-surface-solid border border-border-subtle text-text-muted hover:text-text-main hover:bg-input-bg transition-colors flex-shrink-0"
                      aria-label={`Close ${meta.title} list`}
                    >
                      <span className="material-symbols-outlined text-[20px]">close</span>
                    </button>
                  </div>

                  <div className="relative z-10 mt-4 flex items-center gap-2 bg-input-bg border border-border-subtle rounded-xl px-3.5 py-2.5 focus-within:ring-2 focus-within:ring-electric-blue/30">
                    <span className="material-symbols-outlined text-text-muted text-[19px]">search</span>
                    <input
                      autoFocus
                      value={statPanelSearch}
                      onChange={(event) => setStatPanelSearch(event.target.value)}
                      placeholder={meta.placeholder}
                      className="w-full bg-transparent text-text-main placeholder:text-text-muted/70 outline-none text-sm font-body-sm"
                    />
                    {statPanelSearch && (
                      <button onClick={() => setStatPanelSearch("")} className="text-text-muted hover:text-text-main flex-shrink-0">
                        <span className="material-symbols-outlined text-[18px]">close</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 sm:p-4 md:p-5 bg-surface-solid">
                  {filteredStatItems.length === 0 ? (
                    <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center text-text-muted px-6">
                      <span className="material-symbols-outlined text-4xl opacity-40 mb-2">search_off</span>
                      <p className="text-xs font-medium font-bold">No matches found</p>
                      <p className="font-body-xs text-xs mt-1 opacity-70">Try a different search.</p>
                    </div>
                  ) : activeStatPanel === "competitors" ? (
                    <div className="space-y-2.5">
                      {filteredStatItems.map((comp) => (
                        <div key={`stat-comp-${comp.id ?? comp.name}`} className="group flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-xl bg-surface-glass border border-border-subtle hover:border-electric-blue/30 hover:bg-input-bg/40 transition-colors">
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-electric-blue/10 border border-electric-blue/15 flex items-center justify-center text-electric-blue flex-shrink-0">
                            <span className="material-symbols-outlined text-[21px] md:text-[24px]">corporate_fare</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-body-md font-bold text-text-main truncate">{comp.name || "Unnamed Competitor"}</h3>
                            <p className="font-mono text-[9px] md:text-[10px] text-text-muted truncate mt-0.5">{comp.ads_id || "No advertiser ID"}</p>
                          </div>
                          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                            <span className="text-[10px] font-medium text-text-muted bg-surface-solid border border-border-subtle rounded-md px-2 py-1">{comp.publisherCount} pubs</span>
                            <span className="text-[10px] font-medium text-text-muted bg-input-bg border border-border-subtle rounded-md px-2 py-1">{comp.gameCount} games</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : activeStatPanel === "publishers" ? (
                    <div className="space-y-2.5">
                      {filteredStatItems.map((publisher, index) => (
                        <div key={`stat-pub-${publisher.competitorId}-${publisher.id ?? publisher.publisher_name}-${index}`} className="group flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-xl bg-surface-glass border border-border-subtle hover:border-electric-blue/30 hover:bg-input-bg/40 transition-colors">
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-electric-blue/10 border border-electric-blue/15 flex items-center justify-center text-electric-blue flex-shrink-0">
                            <span className="material-symbols-outlined text-[21px] md:text-[24px]">account_box</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-body-md font-bold text-text-main truncate">{publisher.publisher_name || "Unknown Publisher"}</h3>
                            <p className="font-body-xs text-[10px] md:text-xs text-text-muted truncate mt-0.5">Group: <span className="text-text-main font-semibold">{publisher.competitorName || "Unknown"}</span></p>
                          </div>
                          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                            <span className="text-[10px] font-medium text-text-muted bg-input-bg border border-border-subtle rounded-md px-2 py-1">{publisher.totalGames} games</span>
                            <span className="text-[10px] font-medium text-text-muted bg-input-bg border border-border-subtle rounded-md px-2 py-1">{formatInstalls(publisher.totalInstalls)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {filteredStatItems.map((game) => (
                        <button
                          type="button"
                          key={`stat-game-${getGameIdentity(game)}`}
                          onClick={() => openGameFromStatPanel(game)}
                          className="w-full text-left group flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-xl bg-surface-glass border border-border-subtle hover:border-electric-blue/40 hover:bg-input-bg/40 transition-colors"
                        >
                          <div className="w-11 h-11 md:w-14 md:h-14 rounded-xl overflow-hidden bg-input-bg border border-border-subtle shadow-sm flex items-center justify-center flex-shrink-0">
                            {game.icon ? <img loading="lazy" decoding="async" src={game.icon} alt={game.title || "Game"} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted">sports_esports</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-body-md font-bold text-text-main truncate group-hover:text-electric-blue transition-colors">{game.title || "Untitled Game"}</h3>
                            <p className="font-body-xs text-[10px] md:text-xs text-text-muted truncate mt-0.5">{game.publisher_name || "Unknown Publisher"}</p>
                            <p className="font-mono text-[9px] text-text-muted/70 truncate mt-1 hidden md:block">{game.package_name}</p>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                            {Number(game.ad_count) > 0 && <span className="text-[9px] md:text-[10px] font-bold text-electric-blue bg-electric-blue/10 border border-electric-blue/20 rounded-md px-2 py-0.5">{viewMode === "latest" ? `+${game.ad_count} Ads` : `${game.ad_count} Detections`}</span>}
                            <div className="flex items-center gap-1.5">
                              {getInstallCount(game) > 0 && <span className="text-[9px] md:text-[10px] font-medium text-text-muted bg-input-bg border border-border-subtle rounded-md px-1.5 py-0.5">{game.installs || formatInstalls(getInstallCount(game))}</span>}
                              {getAgeText(game.released) && <span className="text-[9px] md:text-[10px] text-text-muted bg-surface-solid border border-border-subtle rounded-md px-1.5 py-0.5">{getAgeText(game.released)}</span>}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex-shrink-0 px-4 md:px-5 py-3 border-t border-border-subtle bg-surface-glass flex items-center justify-between gap-3">
                  <span className="text-[9px] md:text-[10px] text-text-muted">Showing {filteredStatItems.length} of {meta.total}</span>
                  {activeStatPanel === "games" && <span className="font-body-xs text-[10px] text-text-muted hidden sm:block">Click a game to open details</span>}
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence onExitComplete={() => setSelectedGame(null)}>
        {isDrawerOpen && selectedGame && (
          <div className="fixed inset-0 z-[60] pointer-events-none">
            <motion.div
              key="game-drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="absolute inset-0 bg-black/70 pointer-events-auto"
              onClick={closeDrawer}
            />
            <motion.aside
              key={`game-drawer-${getGameIdentity(selectedGame)}`}
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "tween", duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="absolute top-0 right-0 h-full w-full sm:w-[450px] md:w-[500px] bg-surface-solid border-l border-border-subtle shadow-2xl flex flex-col z-[70] pointer-events-auto will-change-transform"
            >
            <div className="p-6 md:p-8 pb-6 flex items-start justify-between relative bg-surface-glass border-b border-border-subtle pt-safe">
              <div className="flex gap-5 md:gap-6 items-start min-w-0 pr-4">
                <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-input-bg border border-border-subtle flex items-center justify-center overflow-hidden flex-shrink-0">
                  {selectedGame.icon ? <img loading="lazy" decoding="async" src={selectedGame.icon} alt="Icon" className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-[40px] text-primary/50">sports_esports</span>}
                </div>
                <div className="flex flex-col pt-1 min-w-0">
                  <h1 className="font-headline-lg text-text-main text-xl md:text-2xl mb-1 leading-tight truncate">{selectedGame.title}</h1>
                  <p className="font-body-xs md:font-body-sm text-text-muted  font-medium mb-3 truncate">{selectedGame.publisher_name}</p>
                  
                  {(() => {
                    const compName = getCompetitorForGame(selectedGame, competitorTree);
                    return compName ? (
                      <div className="flex items-center gap-1.5 text-electric-blue font-medium text-[10px] md:text-xs bg-electric-blue/10 border border-electric-blue/20 px-2.5 py-1 rounded w-max mb-4 shadow-sm">
                        <span className="material-symbols-outlined text-[14px]">corporate_fare</span>
                        Group: {compName}
                      </div>
                    ) : (
                      <div className="mb-2"></div>
                    );
                  })()}

                  <a href={`https://play.google.com/store/apps/details?id=${selectedGame.package_name}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 bg-electric-blue hover:bg-blue-600 text-white text-xs px-4 py-2 rounded-lg border border-border-subtle transition-all w-max shadow-sm font-bold active:scale-[0.98]">
                    Play Store <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  </a>
                </div>
              </div>
              <button onClick={closeDrawer} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-glass border border-transparent hover:border-border-subtle transition-all text-text-muted hover:text-text-main bg-surface-solid md:bg-transparent flex-shrink-0"><span className="material-symbols-outlined text-[24px]">close</span></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col gap-8 custom-scrollbar pb-24">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-2xl"><p className="text-xs text-text-muted  mb-2 font-bold">Rating</p><div className="flex items-center gap-2"><p className="font-headline-lg text-2xl text-text-main font-bold">{Number(selectedGame.rating) > 0 ? Number(selectedGame.rating).toFixed(1) : "N/A"}</p><span className="material-symbols-outlined text-electric-blue text-[22px] mb-0.5" style={{fontVariationSettings: "'FILL' 1"}}>star</span></div></div>
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-2xl"><p className="text-xs text-text-muted  mb-2 font-bold">Reviews</p><p className="font-headline-lg text-2xl text-text-main font-bold">{selectedGame.ratings_count || 0}</p></div>
              </div>
              {selectedGame.screenshots && (
                <div className="flex flex-col gap-4">
                  <h3 className="text-xs text-text-muted  flex items-center gap-3 font-bold"><span className="w-8 h-[1px] bg-border-subtle"></span> Screenshots</h3>
                  <div className="flex overflow-x-auto gap-4 pb-4 snap-x snap-mandatory custom-scrollbar">
                    {parseJsonArray(selectedGame.screenshots).slice(0, 4).map((url, i) => <div key={i} className="w-[140px] h-[280px] flex-shrink-0 bg-surface-glass rounded-xl overflow-hidden snap-center border border-border-subtle shadow-sm"><img loading="lazy" decoding="async" src={url} alt={`Screenshot ${i}`} className="w-full h-full object-cover hover:scale-105 transition-transform duration-500" /></div>)}
                  </div>
                </div>
              )}
              {selectedGame.similar_apps && (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between"><h3 className="text-xs text-text-muted  flex items-center gap-2 font-bold"><span className="material-symbols-outlined text-[16px] text-electric-blue">radar</span> Similar apps</h3><span className="font-mono text-[10px] text-text-muted bg-surface-solid px-2.5 py-1 rounded border border-border-subtle font-bold">{parseJsonArray(selectedGame.similar_apps).length} Found</span></div>
                  <div className="space-y-3">
                    {parseJsonArray(selectedGame.similar_apps).length === 0 ? <p className="font-body-sm text-xs text-text-muted italic">No direct copycats detected.</p> : parseJsonArray(selectedGame.similar_apps).map((sim, i) => (
                      <div key={i} className="flex items-center justify-between p-3.5 rounded-xl bg-surface-glass border border-border-subtle shadow-sm group">
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="w-12 h-12 rounded-lg overflow-hidden bg-input-bg flex-shrink-0 border border-border-subtle">
                            {sim.icon ? <img loading="lazy" decoding="async" src={sim.icon} alt={sim.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50 text-[24px] flex h-full items-center justify-center">sports_esports</span>}
                          </div>
                          <div className="min-w-0 pr-2">
                            <p className="font-body-sm font-bold text-text-main truncate group-hover:text-primary transition-colors">{sim.title}</p>
                            <p className="font-body-xs text-xs text-text-muted truncate mt-0.5">{sim.developer}</p>
                          </div>
                        </div>
                        <a href={`https://play.google.com/store/apps/details?id=${sim.appId}`} target="_blank" rel="noreferrer" className="text-text-muted hover:text-electric-blue ml-2 p-2 rounded-lg bg-surface-solid border border-border-subtle flex-shrink-0"><span className="material-symbols-outlined text-[18px]">open_in_new</span></a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isScanning && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-[100] bg-surface-solid border border-border-subtle rounded-[22px] shadow-lg overflow-hidden",
              isScanMinimized ? "md:w-[300px]" : "md:w-[370px]"
            )}
          >
            <div className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative w-9 h-9 rounded-full bg-input-bg border border-border-subtle flex items-center justify-center flex-shrink-0 overflow-hidden">
                  <motion.span
                    className="absolute w-7 h-7 rounded-full border border-electric-blue/55"
                    animate={{ scale: [0.65, 1.15], opacity: [0.7, 0] }}
                    transition={{ duration: 1.35, repeat: Infinity, ease: "easeOut" }}
                  />
                  <span className="w-2.5 h-2.5 rounded-full bg-electric-blue"></span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs md:text-sm font-medium text-text-main">Scanning</h4>
                    <div className="flex items-center gap-1" aria-label="Scan active">
                      {[0, 1, 2].map((dot) => (
                        <motion.span
                          key={dot}
                          className="w-1 h-1 rounded-full bg-electric-blue"
                          animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                          transition={{ duration: 1.05, repeat: Infinity, delay: dot * 0.14, ease: "easeInOut" }}
                        />
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] md:text-[11px] text-text-muted truncate mt-0.5">
                    {scanProgress.target} · {scanProgress.targetIndex}/{scanProgress.totalTargets}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-0.5 flex-shrink-0">
                {isAdmin && (
                  <button
                    onClick={handleCancelScan}
                    className="w-8 h-8 rounded-full text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 flex items-center justify-center transition-colors"
                    title="Cancel scan"
                    aria-label="Cancel scan"
                  >
                    <span className="material-symbols-outlined text-[18px]">stop_circle</span>
                  </button>
                )}
                <button
                  onClick={() => setIsScanMinimized(!isScanMinimized)}
                  className="w-8 h-8 rounded-full text-text-muted hover:text-text-main hover:bg-black/[0.035] dark:hover:bg-white/[0.045] flex items-center justify-center transition-colors"
                  title={isScanMinimized ? "Expand" : "Minimize"}
                  aria-label={isScanMinimized ? "Expand scan progress" : "Minimize scan progress"}
                >
                  <span className="material-symbols-outlined text-[18px]">{isScanMinimized ? "expand_content" : "minimize"}</span>
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
                  <div className="px-4 pb-4">
                    <div className="relative h-1.5 bg-input-bg rounded-full overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-electric-blue rounded-full transition-[width] duration-300 ease-out"
                        style={{ width: `${scanPercentage}%` }}
                      ></div>
                      <motion.div
                        className="absolute inset-y-0 w-14 bg-gradient-to-r from-transparent via-electric-blue/55 to-transparent"
                        animate={{ x: [-70, 390] }}
                        transition={{ duration: 1.45, repeat: Infinity, ease: "linear" }}
                      />
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-3 text-[10px] md:text-[11px] text-text-muted">
                      <span>
                        <span className="text-text-main font-medium">{scanProgress.currentAd}</span> of {scanProgress.totalAds} ads
                        <span className="ml-1.5">· {scanPercentage}%</span>
                      </span>
                      <span className="tabular-nums flex-shrink-0">{scanProgress.timeRemaining}</span>
                    </div>

                    <div className="mt-2.5 flex items-center gap-2 text-[10px] text-text-muted min-w-0">
                      <span className="material-symbols-outlined text-[14px] flex-shrink-0">terminal</span>
                      <span className="truncate">{scanProgress.logs[scanProgress.logs.length - 1] || "Preparing scan…"}</span>
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
              initial={{ opacity: 0, scale: 0.97, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 10 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="relative w-full max-w-2xl bg-surface-solid border border-border-subtle rounded-[28px] shadow-xl overflow-hidden flex flex-col max-h-[86vh]"
            >
              <div className="px-5 md:px-6 py-5 border-b border-border-subtle flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[20px]">explore</span>
                  </div>
                  <div>
                    <h2 className="text-lg md:text-xl text-text-main font-semibold tracking-tight">How Atlas works</h2>
                    <p className="text-[11px] md:text-xs text-text-muted mt-1">A quick guide to scanning, organizing, and reviewing competitor intelligence.</p>
                  </div>
                </div>

                <button
                  onClick={() => setIsGuideOpen(false)}
                  className="w-9 h-9 rounded-full hover:bg-black/[0.035] dark:hover:bg-white/[0.045] flex items-center justify-center transition-colors text-text-muted hover:text-text-main flex-shrink-0"
                  aria-label="Close guide"
                >
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>

              <div className="px-5 md:px-6 py-5 overflow-y-auto custom-scrollbar">
                <div className="space-y-6">
                  <section className="grid grid-cols-[36px_1fr] gap-3">
                    <div className="w-9 h-9 rounded-full bg-input-bg text-electric-blue flex items-center justify-center text-xs font-semibold">1</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">What Atlas does</h3>
                      <p className="text-xs md:text-sm text-text-muted leading-6 mt-1.5">
                        Atlas monitors competitor advertising activity, resolves Google Play package IDs from live creatives, and organizes the discovered games under their publishers and competitor groups.
                      </p>
                    </div>
                  </section>

                  <div className="h-px bg-border-subtle"></div>

                  <section className="grid grid-cols-[36px_1fr] gap-3">
                    <div className="w-9 h-9 rounded-full bg-input-bg text-electric-blue flex items-center justify-center text-xs font-semibold">2</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">Run a scan</h3>
                      <div className="mt-3 space-y-2">
                        {[
                          { icon: "search", title: "Brand search", text: "Enter a competitor name and Atlas will look for its Google Ads Transparency presence." },
                          { icon: "fingerprint", title: "Advertiser ID", text: "Paste an AR advertiser ID when you already know the exact account you want to scan." },
                          { icon: "playlist_play", title: "Batch list", text: "Choose a saved batch list to scan several advertiser IDs in sequence." },
                        ].map((item) => (
                          <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-border-subtle p-3.5">
                            <div className="w-8 h-8 rounded-full bg-input-bg flex items-center justify-center text-text-muted flex-shrink-0">
                              <span className="material-symbols-outlined text-[17px]">{item.icon}</span>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-text-main">{item.title}</p>
                              <p className="text-[11px] md:text-xs text-text-muted leading-5 mt-0.5">{item.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <div className="h-px bg-border-subtle"></div>

                  <section className="grid grid-cols-[36px_1fr] gap-3">
                    <div className="w-9 h-9 rounded-full bg-input-bg text-electric-blue flex items-center justify-center text-xs font-semibold">3</div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-main">Review and manage data</h3>
                      <div className="mt-3 grid sm:grid-cols-2 gap-2.5">
                        <div className="rounded-2xl border border-border-subtle p-3.5">
                          <span className="material-symbols-outlined text-[18px] text-text-muted">account_tree</span>
                          <p className="text-xs font-semibold text-text-main mt-2">Live Directory</p>
                          <p className="text-[11px] text-text-muted leading-5 mt-1">Expand competitor groups and publishers to inspect the games Atlas has linked to them.</p>
                        </div>
                        <div className="rounded-2xl border border-border-subtle p-3.5">
                          <span className="material-symbols-outlined text-[18px] text-text-muted">delete_sweep</span>
                          <p className="text-xs font-semibold text-text-main mt-2">Data cleanup</p>
                          <p className="text-[11px] text-text-muted leading-5 mt-1">Admins can remove individual games, publishers, or entire competitor groups when test data is no longer needed.</p>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              <div className="px-5 md:px-6 py-4 border-t border-border-subtle flex items-center justify-between gap-3">
                <p className="text-[10px] md:text-[11px] text-text-muted hidden sm:block">You can reopen this guide anytime from the help icon.</p>
                <button
                  onClick={() => setIsGuideOpen(false)}
                  className="ml-auto h-10 px-5 rounded-full bg-[#1a73e8] hover:bg-[#1765cc] text-white text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8]/40"
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