import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { cn } from "./lib/utils"; 

// 🚨 NGROK URL
const NGROK_URL = "https://skeptic-resample-caution.ngrok-free.dev";

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
  ? "http://localhost:3000" 
  : NGROK_URL;

const CHART_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6"];

const FADE_UP = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function fetchJson(url, options = {}) {
  options.headers = { ...options.headers, "ngrok-skip-browser-warning": "69420" };
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Invalid JSON response (${response.status}) from ${url}`); }
  if (!response.ok) { throw new Error(data?.error || data?.message || `Request failed with status ${response.status}`); }
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

// Stable identity for Trending cards. package_name is the best key because API/database
// row IDs can be missing, duplicated, or change between responses.
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
    <motion.div variants={FADE_UP} className="w-full bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl shadow-xl p-4 md:p-6 h-[300px] md:h-[400px] flex flex-col">
      <div className="flex justify-between items-start mb-4 md:mb-6">
        <div>
          <h2 className="font-label-caps text-xs md:text-sm font-bold uppercase tracking-wider text-text-main">Game Discovery Telemetry</h2>
          <p className="font-body-xs text-[10px] md:text-xs text-text-muted mt-0.5">Total unique games discovered per competitor over time</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-label-caps text-[10px] text-text-muted"><span className="w-1.5 h-1.5 rounded-full bg-electric-blue animate-pulse"></span> Active Trend</span>
        </div>
      </div>

      <div className="flex-1 w-full min-h-0">
        {historyData.data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={historyData.data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                {historyData.lines.map((competitorName, index) => (
                  <linearGradient key={competitorName} id={`color${index}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0.3}/>
                    <stop offset="95%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0}/>
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? '#334155' : '#e2e8f0'} />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 10, fontFamily: 'Inter' }} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 10, fontFamily: 'Inter' }} />
              <Tooltip
                itemSorter={(item) => -Number(item.value || 0)}
                contentStyle={{ backgroundColor: isDarkMode ? '#1e293b' : '#ffffff', borderColor: isDarkMode ? '#334155' : '#e2e8f0', borderRadius: '12px', color: isDarkMode ? '#f8fafc' : '#0f172a', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
                labelStyle={{ color: isDarkMode ? '#94a3b8' : '#64748b', marginBottom: '4px', fontSize: '10px' }}
              />
              {historyData.lines.map((competitorName, index) => (
                <Area key={competitorName} connectNulls={true} type="monotone" dataKey={competitorName} stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={3} fillOpacity={1} fill={`url(#color${index})`} activeDot={{ r: 6, strokeWidth: 0 }} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-text-muted">
            <span className="material-symbols-outlined text-3xl md:text-4xl mb-2 opacity-50">show_chart</span>
            <p className="font-body-sm text-xs">Run scans to build data.</p>
          </div>
        )}
      </div>
    </motion.div>
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
    <div className="xl:col-span-7 bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl shadow-xl flex flex-col h-[500px] md:h-[600px] overflow-hidden">
      <div className="p-4 md:p-6 pb-4 bg-surface-solid border-b border-border-subtle flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-label-caps text-xs md:text-sm font-bold uppercase tracking-wider text-text-main">Trending Targets</h2>
          <p className="font-body-xs text-[10px] md:text-xs text-text-muted mt-0.5">{viewMode === 'latest' && <span className="text-emerald-metric mr-2 font-bold">● LATEST</span>}Ranked by velocity</p>
        </div>
        <div className="flex bg-input-bg p-1 rounded-xl border border-border-subtle w-full sm:w-auto mt-2 sm:mt-0">
          {[ { id: 'ads', label: 'AD PUSH' }, { id: 'installs', label: 'INSTALLS' }, { id: 'newest', label: 'NEWEST' }].map((btn) => (
            <button key={btn.id} onClick={() => onSort(btn.id)} className={cn("flex-1 px-2 md:px-3 py-1 md:py-1.5 text-[10px] md:text-xs font-label-caps uppercase font-bold border shadow-sm transition-all rounded-lg", trendingSort === btn.id ? "bg-primary border-border-subtle text-white shadow-[0_0_10px_rgba(59,130,246,0.3)]" : "bg-transparent border-transparent text-text-muted hover:text-text-main")}>{btn.label}</button>
          ))}
        </div>
      </div>
      <motion.div layoutScroll className="flex-1 p-3 md:p-4 space-y-2.5 overflow-y-auto custom-scrollbar">
        {sortedTrending.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted opacity-50 p-6">
            <span className="material-symbols-outlined text-4xl mb-2">radar</span>
            <span className="font-label-caps uppercase tracking-widest text-xs">
              {viewMode === 'latest'
                ? (latestScanTargetName ? `No ads found for "${latestScanTargetName}".` : "No active scan.")
                : "No data."}
            </span>
          </div>
        ) : (
          <LayoutGroup id="trending-targets">
            {sortedTrending.map((game) => {
              const gameKey = getGameIdentity(game);
              return (
                <motion.div
                  key={gameKey}
                  layout="position"
                  transition={{ layout: { type: "spring", stiffness: 500, damping: 42, mass: 0.65 } }}
                  whileHover={{ y: -2 }}
                  onClick={() => onGameClick(game)}
                  className="flex items-center p-2.5 md:p-4 rounded-xl bg-surface-solid border border-border-subtle shadow-sm hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] hover:border-electric-blue/30 cursor-pointer transition-[box-shadow,border-color] group"
                >
                  <div className="w-11 h-11 md:w-14 md:h-14 rounded-xl overflow-hidden bg-input-bg border border-border-subtle shadow-sm flex items-center justify-center flex-shrink-0 mr-3 md:mr-4 group-hover:shadow-[0_0_15px_rgba(59,130,246,0.2)] transition-shadow">
                    {game.icon ? <img loading="lazy" decoding="async" src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted">sports_esports</span>}
                  </div>
                  <div className="flex-1 min-w-0 pr-2">
                    <h3 className="font-body-sm md:font-body-md font-semibold text-text-main truncate group-hover:text-primary transition-colors">{game.title}</h3>
                    <p className="font-body-xs text-[10px] md:text-sm text-text-muted truncate">{game.publisher_name}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 md:gap-2 ml-auto flex-shrink-0">
                    {game.ad_count >= 1 && <div className="bg-urgent-red/10 text-urgent-red border border-urgent-red/20 shadow-sm rounded-md px-1.5 md:px-3 py-0.5 md:py-1 font-label-caps text-[9px] md:text-xs flex items-center font-bold whitespace-nowrap">+{game.ad_count} Ads</div>}
                    <div className="flex items-center gap-1.5">
                      {game.installs && game.installs !== "0+" && <span className="font-mono text-[9px] md:text-[10px] font-semibold text-emerald-metric bg-emerald-metric/10 border border-emerald-metric/20 px-1.5 py-0.5 rounded shadow-sm">{game.installs}</span>}
                      {game.released && game.released !== "Unknown" && <span className="font-label-caps text-[9px] md:text-[10px] font-medium text-text-muted bg-surface-glass border border-border-subtle px-1.5 py-0.5 rounded uppercase">{getAgeText(game.released)}</span>}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </LayoutGroup>
        )}
      </motion.div>
    </div>
  );
});

const LiveDirectory = memo(function LiveDirectory({
  visibleCompetitorTree,
  viewMode,
  expandedNodes,
  onToggleNode,
  onGameClick,
  onNukeCompetitorData,
  onNukePublisherData,
}) {
  return (
    <div className="xl:col-span-5 bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl shadow-xl flex flex-col h-[400px] md:h-[600px] overflow-hidden">
      <div className="p-4 md:p-6 pb-4 bg-surface-solid border-b border-border-subtle">
        <h2 className="font-label-caps text-xs md:text-sm font-bold uppercase tracking-wider text-text-main">Live Directory</h2>
        <p className="font-body-xs text-[10px] md:text-xs text-text-muted mt-0.5">{viewMode === 'latest' && <span className="text-emerald-metric mr-2 font-bold">● LATEST</span>}Hierarchy View</p>
      </div>
      <div className="flex-1 p-4 md:p-6 overflow-y-auto custom-scrollbar bg-surface-solid">
        {visibleCompetitorTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-text-muted opacity-50 p-6">
            <span className="material-symbols-outlined text-4xl mb-2">account_tree</span>
            <span className="font-label-caps uppercase tracking-widest text-xs">No data.</span>
          </div>
        ) : visibleCompetitorTree.map((comp) => (
          <div key={comp.id} className="mb-6 font-mono text-xs space-y-2">
            <div className="flex items-center justify-between bg-primary/10 px-3 py-2 rounded-lg border border-border-subtle cursor-pointer hover:bg-primary/20 transition-colors" onClick={() => onToggleNode(`comp_${comp.id}`)}>
              <div className="flex items-center space-x-2">
                <span className="material-symbols-outlined text-electric-blue text-[16px] transition-transform" style={{ transform: expandedNodes[`comp_${comp.id}`] === false ? 'rotate(-90deg)' : 'rotate(0deg)' }}>expand_more</span>
                <span className="material-symbols-outlined text-electric-blue text-[14px]">corporate_fare</span>
                <span className="font-bold text-text-main uppercase text-[11px] md:text-xs">{comp.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-glass text-text-muted border border-border-subtle uppercase font-semibold">Group</span>
                <button onClick={(e) => onNukeCompetitorData(e, comp.id, comp.name)} className="text-text-muted hover:text-urgent-red p-1 rounded transition-colors" title="Delete ALL Group Data"><span className="material-symbols-outlined text-[14px]">delete</span></button>
              </div>
            </div>

            {expandedNodes[`comp_${comp.id}`] !== false && (
              <div className="pl-4 space-y-2.5 relative border-l border-border-subtle ml-2 pt-1">
                {comp.accounts && comp.accounts.map((acc) => (
                  <div key={acc.id} className="space-y-1.5">
                    <div className="flex items-center justify-between bg-surface-glass px-2.5 py-1.5 rounded-lg border border-border-subtle cursor-pointer hover:border-electric-blue/50 transition-colors" onClick={() => onToggleNode(`pub_${acc.id}`)}>
                      <div className="flex items-center space-x-1.5">
                        <span className="material-symbols-outlined text-electric-blue text-[14px] transition-transform" style={{ transform: expandedNodes[`pub_${acc.id}`] === false ? 'rotate(-90deg)' : 'rotate(0deg)' }}>expand_more</span>
                        <span className="text-electric-blue text-xs">📁</span>
                        <span className="text-text-main text-[10px] md:text-[11px] font-medium truncate max-w-[150px] md:max-w-[200px]">{acc.publisher_name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] px-1 py-0.5 rounded bg-surface-solid text-electric-blue font-semibold border border-electric-blue/30">Pub</span>
                        <button onClick={(e) => onNukePublisherData(e, acc.id, acc.publisher_name)} className="text-text-muted hover:text-urgent-red p-1 rounded transition-colors" title="Delete Publisher Data"><span className="material-symbols-outlined text-[14px]">delete</span></button>
                      </div>
                    </div>

                    {expandedNodes[`pub_${acc.id}`] !== false && (
                      <div className="pl-4 ml-2 border-l border-border-subtle space-y-1">
                        {acc.games && acc.games.map((game) => (
                          <div key={getGameIdentity(game)} onClick={() => onGameClick(game)} className="bg-surface-solid p-2 rounded-lg border border-border-subtle text-[10px] space-y-0.5 cursor-pointer hover:border-electric-blue/50 transition-colors">
                            <div className="flex items-center space-x-1 text-text-main">
                              <span>📱</span>
                              <span className="font-semibold truncate">{game.title}</span>
                            </div>
                            <div className="text-[9px] text-text-muted truncate pl-4">{game.package_name}</div>
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
    </div>
  );
});

function App() {
  const [activeTab, setActiveTab] = useState("dashboard"); 
  const [trendingSort, setTrendingSort] = useState("ads");
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [trending, setTrending] = useState([]);
  const [historyData, setHistoryData] = useState({ data: [], lines: [] });

  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryFilter, setDirectoryFilter] = useState("all"); 
  const [pubSort, setPubSort] = useState("installs"); 
  const [pubFilterNew, setPubFilterNew] = useState(false); 
  const [pubFilterComp, setPubFilterComp] = useState("all");

  const [expandedNodes, setExpandedNodes] = useState({});

  const [viewMode, setViewMode] = useState("all"); 
  const [latestScanPackages, setLatestScanPackages] = useState(() => {
    try { return JSON.parse(localStorage.getItem("atlas_latest_packages")) || []; } catch { return []; }
  });
  const [latestScanTargetName, setLatestScanTargetName] = useState(() => localStorage.getItem("atlas_latest_target_name") || "");
  const [latestScanCompId, setLatestScanCompId] = useState(() => localStorage.getItem("atlas_latest_comp_id") || null);
  const [hasLatestScan, setHasLatestScan] = useState(() => localStorage.getItem("atlas_has_latest_scan") === "1");

  const [settings, setSettings] = useState({ ghost_scan_enabled: "1", auto_report_enabled: "1", default_report_email: "", report_subject_template: "", report_notes: "", google_sheet_id: "" });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");

  const [isScanning, setIsScanning] = useState(false);
  const [isScanMinimized, setIsScanMinimized] = useState(false);
  const [isSaving, setIsSaving] = useState(false); 
  const [isMaxAds, setIsMaxAds] = useState(false); 
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [sourceSearch, setSourceSearch] = useState("");
  
  const [lastScanTime, setLastScanTime] = useState("Never");
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
  }, []);

  useEffect(() => { 
    loadAllData(); 
    const heartbeat = setInterval(async () => {
      try { await fetchJson(`${API_BASE}/api/health`); setIsNodeOnline(true); } 
      catch { setIsNodeOnline(false); }
    }, 30000);
    return () => clearInterval(heartbeat);
  }, [loadAllData]);

  const toggleNode = useCallback((nodeId) => {
    setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }, []);

  const handleNukeCompetitorData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (window.confirm(`⚠️ WARNING: Are you sure you want to PERMANENTLY delete ALL data for ${name} (including all associated games and publishers)? This cannot be undone.`)) {
      try {
        await fetchJson(`${API_BASE}/api/competitors/${id}/data`, { method: "DELETE" });
        loadAllData();
      } catch { alert("Failed to delete competitor."); }
    }
  }, [loadAllData]);

  const handleNukePublisherData = useCallback(async (e, id, name) => {
    e.stopPropagation();
    if (window.confirm(`⚠️ WARNING: Are you sure you want to PERMANENTLY delete ALL data for publisher ${name}?`)) {
      try {
        await fetchJson(`${API_BASE}/api/publishers/${id}/data`, { method: "DELETE" });
        loadAllData();
      } catch { alert("Failed to delete publisher."); }
    }
  }, [loadAllData]);

  const isFromLatestScan = (game) => {
    if (viewMode === "all") return true;
    if (!hasLatestScan) return false;
    
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
    return trending.filter(isFromLatestScan);
  }, [trending, viewMode, hasLatestScan, latestScanPackages, latestScanCompId, latestScanTargetName]);

  const visibleCompetitorTree = useMemo(() => {
    return competitorTree.map(comp => {
      if (viewMode === "all") return comp;
      const isTargetComp = latestScanCompId ? comp.id.toString() === latestScanCompId.toString() : 
        (latestScanTargetName ? comp.name.toLowerCase().includes(latestScanTargetName.toLowerCase()) : false);

      const visibleAccounts = (comp.accounts || []).map(acc => {
        const visibleGames = (acc.games || []).filter(isFromLatestScan);
        return { ...acc, games: visibleGames };
      }).filter(acc => acc.games.length > 0 || isTargetComp);

      return { ...comp, accounts: visibleAccounts };
    }).filter(comp => {
      if (viewMode === "all") return true;
      if (latestScanCompId) return comp.id.toString() === latestScanCompId.toString();
      if (latestScanTargetName) return comp.name.toLowerCase().includes(latestScanTargetName.toLowerCase());
      return comp.accounts.length > 0;
    });
  }, [competitorTree, viewMode, latestScanCompId, latestScanTargetName, hasLatestScan, latestScanPackages]);

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

  const sortedTrending = useMemo(() => {
    // De-dupe first. Besides preventing duplicate cards from the API, this guarantees
    // every animated row has exactly one stable React key during a reorder.
    const uniqueGames = new Map();

    visibleTrending.forEach((game) => {
      const key = getGameIdentity(game);
      const existing = uniqueGames.get(key);

      if (!existing) {
        uniqueGames.set(key, game);
        return;
      }

      // If the backend happens to return the same package more than once, preserve
      // the strongest counters while keeping the most complete/latest row data.
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

      // Deterministic tie-breakers keep equal-value rows from needlessly swapping.
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
    e.preventDefault(); setIsSavingSettings(true); setSettingsStatus("");
    try {
      const data = await fetchJson(`${API_BASE}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      if (data?.status === "success") { setSettingsStatus("Settings saved successfully!"); setTimeout(() => setSettingsStatus(""), 3500); }
    } catch { setSettingsStatus("Failed to save settings."); } finally { setIsSavingSettings(false); }
  };

  const handleSeedHistory = async () => { if (window.confirm("Seed 7 days of historical testing data?")) { try { await fetch(`${API_BASE}/api/dev/seed-history`, { method: "POST", headers: {"ngrok-skip-browser-warning": "true"} }); loadAllData(); } catch {} } };
  const handleCreateList = async (e) => { e.preventDefault(); if (!newListName || !newListTargets || isSaving) return; setIsSaving(true); try { await fetch(`${API_BASE}/api/lists`, { method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }, body: JSON.stringify({ name: newListName, targets: newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t) }) }); setNewListName(""); setNewListTargets(""); loadAllData(); } catch {} finally { setIsSaving(false); } };
  const handleToggleList = async (id, currentStatus) => { try { await fetch(`${API_BASE}/api/lists/${id}/toggle`, { method: "PATCH", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }, body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 }) }); loadAllData(); } catch {} };
  const handleSaveCompetitor = async (e) => { e.preventDefault(); if (!newCompName || !newCompAdsId || isSaving) return; setIsSaving(true); try { await fetch(`${API_BASE}/api/competitors`, { method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }, body: JSON.stringify({ name: newCompName, adsId: newCompAdsId, country: "Any" }) }); setNewCompName(""); setNewCompAdsId(""); loadAllData(); } catch {} finally { setIsSaving(false); } };
  const handleSaveEmailList = async (e) => { e.preventDefault(); if (!newEmailName || !newEmailTargets || isSaving) return; setIsSaving(true); try { await fetch(`${API_BASE}/api/emails`, { method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" }, body: JSON.stringify({ name: newEmailName, emails: newEmailTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t) }) }); setNewEmailName(""); setNewEmailTargets(""); loadAllData(); } catch {} finally { setIsSaving(false); } };
  const handleDeleteList = async (id) => { if (window.confirm("Delete this target list?")) { try { await fetch(`${API_BASE}/api/lists/${id}`, { method: "DELETE", headers: {"ngrok-skip-browser-warning": "true"} }); loadAllData(); } catch {} } };
  const handleDeleteCompetitor = async (id) => { if (window.confirm("Delete this saved competitor?")) { try { await fetch(`${API_BASE}/api/saved-competitors/${id}`, { method: "DELETE", headers: {"ngrok-skip-browser-warning": "true"} }); loadAllData(); } catch {} } };
  const handleDeleteEmail = async (id) => { if (window.confirm("Delete this email target?")) { try { await fetch(`${API_BASE}/api/emails/${id}`, { method: "DELETE", headers: {"ngrok-skip-browser-warning": "true"} }); loadAllData(); } catch {} } };
  
  const handleCancelScan = async () => {
    if (!window.confirm("Abort the current scan? Any targets already processed will be saved safely.")) return;
    try { await fetch(`${API_BASE}/api/cancel-scan`, { method: "POST", headers: {"ngrok-skip-browser-warning": "true"} }); setScanProgress(prev => ({ ...prev, logs: [...prev.logs, "> 🛑 Sending abort signal to backend..."] })); } catch {}
  };

  const handleRunScan = async () => {
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
    setHasLatestScan(false);
    localStorage.setItem("atlas_latest_target_name", targetDisplayName || "");
    if (targetCompId) localStorage.setItem("atlas_latest_comp_id", targetCompId);
    else localStorage.removeItem("atlas_latest_comp_id");

    setViewMode("latest");
    setIsScanning(true); 
    setIsScanMinimized(false);

    const finalLimit = isMaxAds ? 999999 : Math.max(1, Number(scanLimit) || 1);
    setScanProgress({ target: "Initializing...", targetIndex: 1, totalTargets: 1, currentAd: 0, totalAds: finalLimit, timeRemaining: "Calculating...", logs: ["> Booting Intelligence Node..."] });

    let scanType = "manual"; let targetId = null;
    if (selectedSource.startsWith("list_")) { scanType = "list"; targetId = selectedSource.split("_")[1]; } 
    else if (selectedSource.startsWith("comp_")) { scanType = "competitor"; targetId = selectedSource.split("_")[1]; }

    const eventSource = new EventSource(
      `${API_BASE}/api/scan-stream?ngrok-skip-browser-warning=true`
    );

    eventSource.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!data || typeof data !== "object") return;

      // Completion exclusively handles scan termination
      if (data.isComplete) {
        if (data.packages && Array.isArray(data.packages)) {
          setLatestScanPackages(data.packages);
          localStorage.setItem("atlas_latest_packages", JSON.stringify(data.packages));
        }

        if (data.competitorId) {
          setLatestScanCompId(data.competitorId);
          localStorage.setItem("atlas_latest_comp_id", data.competitorId.toString());
        }

        setHasLatestScan(true);
        localStorage.setItem("atlas_has_latest_scan", "1");
        setLastScanTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        loadAllData();

        setTimeout(() => {
          setIsScanning(false);
          eventSource.close();
        }, 2500);

      } else if (data.isCancelled || data.fatalError) {
        // Only stop if user actively cancelled or backend had a fatal, total abort
        setScanProgress(prev => ({
          ...prev,
          logs: [...prev.logs, data.log || "> Scan terminated."].slice(-5)
        }));

        setTimeout(() => {
          setIsScanning(false);
          eventSource.close();
        }, 3000);

      } else {
        // Standard progress update - continues running even if individual ads fail/timeout
        setScanProgress(prev => {
          const newLogs = [...prev.logs, data.log].filter(Boolean).slice(-5);

          return {
            ...prev,
            target: data.target || prev.target,
            targetIndex: data.targetIndex || prev.targetIndex,
            totalTargets: data.totalTargets || prev.totalTargets,
            currentAd: data.currentAd !== undefined ? data.currentAd : prev.currentAd,
            totalAds: data.totalAds || prev.totalAds,
            timeRemaining: data.timeRemaining || prev.timeRemaining,
            logs: newLogs
          };
        });
      }
    };

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
    } catch (err) {
      console.error("Scan dispatch error:", err);
    }
  };

  const handleReset = () => {
    if (!window.confirm("Clear the 'Latest Scan' view? This empties the screen until your next scan. (All-time database records remain safe).")) return;
    setLatestScanPackages([]);
    setLatestScanTargetName("");
    setLatestScanCompId(null);
    setHasLatestScan(false);
    localStorage.removeItem("atlas_latest_packages");
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

  const getTargetSourceName = () => {
    if (selectedSource === "manual") return "📝 Manual Entry";
    if (selectedSource.startsWith("comp_")) { const comp = savedCompetitors.find(c => `comp_${c.id}` === selectedSource); return comp ? `👤 ${comp.name}` : "Saved Competitor"; }
    if (selectedSource.startsWith("list_")) { const list = targetLists.find(l => `list_${l.id}` === selectedSource); return list ? `📂 ${list.name}` : "Target List"; }
    return "Select Source";
  };

  const getEmailListName = () => {
    if (selectedEmailList === "none") return "❌ Don't Send";
    if (selectedEmailList === "custom") return customReportEmail.trim() || "Custom Email";
    const list = emailLists.find(e => e.id.toString() === selectedEmailList.toString());
    return list ? `✉️ ${list.name}` : "Don't Send";
  };

  const dropDownAnim = { hidden: { opacity: 0, y: -10, scale: 0.95 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.15, ease: "easeOut" } }, exit: { opacity: 0, y: -10, scale: 0.95, transition: { duration: 0.1, ease: "easeIn" } } };
  const scanPercentage = Math.min(100, (scanProgress.currentAd / Math.max(1, scanProgress.totalAds)) * 100).toFixed(0);

  return (
    <div className="bg-bg-base font-body-md text-text-main min-h-screen relative transition-colors duration-400 z-10 overflow-x-hidden pb-20 md:pb-0">
      
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-electric-blue/5 blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] rounded-full bg-primary/5 blur-[100px]"></div>
      </div>

      {/* TOP HEADER */}
      <header className="fixed top-0 left-0 right-0 h-16 md:h-20 bg-surface-glass backdrop-blur-xl z-30 px-4 md:px-6 lg:px-8 flex items-center justify-between border-b border-border-subtle transition-colors duration-400">
        <div className="flex items-center gap-6 lg:gap-8">
          <div className="flex items-center gap-3">
            <img src="/atlas-logo.png" alt="Atlas Logo" className="h-8 w-8 object-contain rounded-md shadow-sm" />
            <span className="font-headline-lg text-lg tracking-tight text-text-main uppercase font-bold hidden sm:block">Atlas</span>
          </div>
          
          <nav className="hidden md:flex items-center gap-1.5">
            {[ { id: "dashboard", icon: "dashboard", label: "Dashboard" }, { id: "directory", icon: "folder_shared", label: "Directory" }, { id: "automated", icon: "radar", label: "Auto Scans" }, { id: "settings", icon: "tune", label: "Settings" } ].map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} className="relative flex items-center gap-2 px-3.5 py-2 rounded-xl group transition-all">
                {activeTab === tab.id && <motion.div layoutId="header-active" className="absolute inset-0 bg-primary-container rounded-xl z-0" transition={{ type: "spring", stiffness: 300, damping: 30 }} />}
                <span className={cn("material-symbols-outlined z-10 transition-colors text-[18px]", activeTab === tab.id ? "text-on-primary-container" : "text-text-muted group-hover:text-text-main")} style={{ fontVariationSettings: "'wght' 500" }}>{tab.icon}</span>
                <span className={cn("font-label-caps text-[11px] tracking-wider z-10 uppercase transition-colors", activeTab === tab.id ? "text-on-primary-container font-bold" : "text-text-muted group-hover:text-text-main font-semibold")}>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
        
        <div className="flex items-center gap-3 md:gap-4">
          <div className="hidden lg:flex items-center gap-2 bg-surface-solid border border-border-subtle rounded-lg px-3 py-1.5 shadow-sm">
            <div className={cn("h-2 w-2 rounded-full animate-pulse", isNodeOnline ? "bg-emerald-metric" : "bg-urgent-red")}></div>
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest font-bold">{isNodeOnline ? "System: Online" : "System: Offline"}</span>
          </div>

          <div className="flex bg-surface-solid p-1 rounded-xl border border-border-subtle shadow-sm hidden sm:flex">
            <button onClick={() => setViewMode("all")} className={cn("px-4 py-1.5 text-[10px] font-label-caps uppercase tracking-wider rounded-lg transition-all", viewMode === "all" ? "bg-electric-blue text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]" : "text-text-muted hover:text-text-main hover:bg-surface-glass")}>All Time</button>
            <button onClick={() => setViewMode("latest")} className={cn("px-4 py-1.5 text-[10px] font-label-caps uppercase tracking-wider rounded-lg transition-all flex items-center gap-1.5", viewMode === "latest" ? "bg-emerald-metric text-white shadow-[0_0_10px_rgba(16,185,129,0.4)]" : "text-text-muted hover:text-text-main hover:bg-surface-glass")}>
              {viewMode === "latest" && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>}
              Latest Scan
            </button>
          </div>

          <button onClick={() => setIsGuideOpen(true)} className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-surface-solid flex items-center justify-center text-text-main hover:bg-surface-glass transition-all shadow-sm border border-border-subtle" title="How Atlas Works">
            <span className="material-symbols-outlined text-[18px] md:text-[20px]" style={{ fontVariationSettings: "'wght' 500" }}>help</span>
          </button>
          
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-surface-solid flex items-center justify-center text-text-main hover:bg-surface-glass transition-all shadow-sm border border-border-subtle" title="Toggle Theme">
            <span className="material-symbols-outlined text-[18px] md:text-[20px]" style={{ fontVariationSettings: "'wght' 500" }}>{isDarkMode ? "light_mode" : "dark_mode"}</span>
          </button>
        </div>
      </header>

      {/* FULL-WIDTH VIEWPORT */}
      <div className="relative z-10 w-full max-w-[1600px] mx-auto">
        <main className="relative pt-20 md:pt-28 min-h-screen px-3 sm:px-6 lg:px-8 py-8 pb-32">
          
          {!isNodeOnline && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 w-full bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-center gap-2 text-amber-500 font-mono text-[10px] md:text-xs shadow-sm z-40 relative">
              <span className="flex items-center gap-2 font-bold"><span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> NODE OFFLINE</span>
              <span className="hidden sm:block text-amber-500/50">|</span>
              <span className="text-center sm:text-left">Workstation server is unreachable. Active tracking hours: 9:00 AM – 6:00 PM.</span>
            </motion.div>
          )}

          {activeTab === "dashboard" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-6 md:gap-8">
              
              <motion.div variants={FADE_UP} className={cn("w-full bg-surface-glass backdrop-blur-xl rounded-2xl p-4 md:p-6 shadow-xl border border-border-subtle z-40 transition-all", isScanning && "ring-1 ring-electric-blue/50 opacity-75")}>
                <div className="flex flex-col md:flex-row flex-wrap items-end gap-3 md:gap-4 w-full">
                  <div className="flex-[2] min-w-full md:min-w-[200px] space-y-1.5 md:space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Competitor / ID</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">my_location</span>
                      <input value={selectedSource === "manual" ? scanQuery : "Auto-Target Selected"} onChange={(e) => setScanQuery(e.target.value)} disabled={selectedSource !== "manual" || isScanning}
                        className="w-full bg-input-bg text-text-main border border-border-subtle font-mono font-semibold rounded-xl py-3 pl-10 pr-4 outline-none transition-all shadow-sm focus:ring-2 focus:ring-electric-blue/50 disabled:opacity-50" placeholder="e.g. Voodoo or ID: 12345" type="text" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:flex flex-[3] gap-4 w-full">
                    {/* DUAL COLUMN SEARCHABLE DROPDOWN */}
                    <div className="flex-[1.5] min-w-[140px] space-y-2 relative">
                      <label className="font-label-caps text-[10px] md:text-xs text-text-muted uppercase tracking-widest pl-1 block truncate">Target Source</label>
                      <div onClick={(e) => { 
                            if(!isScanning) { 
                              e.stopPropagation(); 
                              if (activeDropdown !== 'source') setSourceSearch("");
                              setActiveDropdown(activeDropdown === 'source' ? null : 'source'); 
                            } 
                          }}
                        className={cn("w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-3 md:pl-10 md:pr-4 outline-none transition-all shadow-sm cursor-pointer flex items-center justify-between select-none hover:border-text-muted/50", activeDropdown === 'source' && 'ring-2 ring-electric-blue/20', isScanning && "opacity-50 cursor-not-allowed")}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px] hidden md:block">list_alt</span>
                        <span className="truncate font-semibold text-xs md:text-sm">{getTargetSourceName()}</span>
                        <span className="material-symbols-outlined text-text-muted text-[18px] transition-transform" style={{ transform: activeDropdown === 'source' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                      </div>
                      <AnimatePresence>
                        {activeDropdown === 'source' && (
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
                                <div onClick={() => { setSelectedSource("manual"); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-semibold transition-colors">📝 Manual</div>
                                <div className="px-3 py-1.5 mt-2 text-[10px] font-semibold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Competitors</div>
                                {savedCompetitors
                                  .filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                  .map(c => (
                                    <div key={`comp_${c.id}`} onClick={() => { setSelectedSource(`comp_${c.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-semibold transition-colors truncate">👤 {c.name}</div>
                                  ))}
                                {savedCompetitors.length > 0 && savedCompetitors.filter(c => (c.name || "").toLowerCase().includes(sourceSearch.toLowerCase()) || (c.ads_id || "").toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-3 text-xs text-text-muted italic">No competitors found.</div>
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Target Lists</div>
                                {targetLists
                                  .filter(l => (l.name || "").toLowerCase().includes(sourceSearch.toLowerCase()))
                                  .map(l => (
                                    <div key={`list_${l.id}`} onClick={() => { setSelectedSource(`list_${l.id}`); setSourceSearch(""); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-semibold transition-colors truncate">📂 {l.name}</div>
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
                      <label className="font-label-caps text-[10px] md:text-xs text-text-muted uppercase tracking-widest pl-1 block truncate">Email Report</label>
                      <motion.div
                        layout
                        transition={{ type: "spring", stiffness: 320, damping: 30 }}
                        onClick={(e) => {
                          if (!isScanning) {
                            e.stopPropagation();
                            setActiveDropdown(activeDropdown === 'email' ? null : 'email');
                          }
                        }}
                        className={cn(
                          "w-full h-[46px] md:h-[50px] bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl px-3 md:pl-10 md:pr-3 outline-none shadow-sm cursor-pointer flex items-center gap-2 select-none transition-[border-color,box-shadow,opacity]",
                          activeDropdown === 'email' && 'ring-2 ring-electric-blue/20',
                          selectedEmailList === 'custom' && EMAIL_REGEX.test(customReportEmail.trim()) && 'border-emerald-metric/40',
                          isScanning && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px] hidden md:block">mail</span>

                        <div className="flex-1 min-w-0">
                          <AnimatePresence mode="wait" initial={false}>
                            {selectedEmailList === 'custom' ? (
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
                                className="w-full bg-transparent text-text-main placeholder:text-text-muted/70 text-xs md:text-sm font-semibold outline-none disabled:cursor-not-allowed"
                              />
                            ) : (
                              <motion.span
                                key="saved-email-selection"
                                initial={{ opacity: 0, x: 8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -6 }}
                                transition={{ duration: 0.15 }}
                                className="block truncate font-semibold text-xs md:text-sm"
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
                        {activeDropdown === 'email' && (
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
                                "px-3 py-2.5 rounded-lg hover:bg-urgent-red/10 text-urgent-red cursor-pointer text-sm font-semibold transition-colors flex items-center gap-2",
                                selectedEmailList === 'none' && 'bg-urgent-red/5'
                              )}
                            >
                              <span className="material-symbols-outlined text-[17px]">mail_off</span> Don't Send
                            </div>

                            <div
                              onClick={() => { setSelectedEmailList("custom"); setActiveDropdown(null); }}
                              className={cn(
                                "px-3 py-2.5 mt-1 rounded-lg hover:bg-electric-blue/10 text-text-main cursor-pointer text-sm font-semibold transition-colors flex items-center gap-2",
                                selectedEmailList === 'custom' && 'bg-electric-blue/10 text-electric-blue'
                              )}
                            >
                              <span className="material-symbols-outlined text-[17px] text-electric-blue">alternate_email</span>
                              <div className="min-w-0">
                                <div>Custom Email</div>
                                <div className="text-[10px] font-normal text-text-muted truncate">Type a one-time recipient</div>
                              </div>
                            </div>

                            {emailLists.length > 0 && (
                              <>
                                <div className="px-3 py-1.5 mt-2 text-[10px] font-semibold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Contacts</div>
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
                    <label className="font-label-caps text-[10px] md:text-xs text-text-muted uppercase tracking-widest pl-1 block">Ad Limit</label>
                    <div className={cn("flex items-center bg-input-bg border border-border-subtle rounded-xl shadow-sm transition-all h-[46px] md:h-[50px]", (isMaxAds || isScanning) && 'opacity-50 cursor-not-allowed', activeDropdown === 'limit' && 'ring-2 ring-electric-blue/20')}>
                      <button disabled={isMaxAds || isScanning} onClick={() => setScanLimit(Math.max(1, scanLimit - 10))} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">remove</span></button>
                      <input disabled={isMaxAds || isScanning} value={isMaxAds ? "ALL" : scanLimit} onChange={(e) => { const val = e.target.value.replace(/\D/g, ''); setScanLimit(val === '' ? '' : Number(val)); }} onBlur={() => { if (!scanLimit || scanLimit < 1) setScanLimit(1); }} className="w-full h-full bg-transparent text-text-main text-center font-mono font-semibold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed" type="text" />
                      <button disabled={isMaxAds || isScanning} onClick={() => setScanLimit((scanLimit || 0) + 10)} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">add</span></button>
                      <div className="w-px h-full bg-border-subtle"></div>
                      <button disabled={isMaxAds || isScanning} onClick={(e) => { e.stopPropagation(); if(!isMaxAds && !isScanning) setActiveDropdown(activeDropdown === 'limit' ? null : 'limit'); }} className="h-full px-3 md:px-2 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-r-xl transition-colors disabled:opacity-50 flex items-center justify-center"><span className="material-symbols-outlined text-[18px]">arrow_drop_down</span></button>
                    </div>
                    <AnimatePresence>
                      {activeDropdown === 'limit' && !isMaxAds && (
                        <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 w-full md:w-28 mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl overflow-hidden p-2 z-50 grid grid-cols-3 md:grid-cols-1 gap-1">
                          {[10, 20, 50, 100, 250, 500].map(val => <div key={val} onClick={() => { setScanLimit(val); setActiveDropdown(null); }} className="px-3 py-2 rounded-lg hover:bg-input-bg cursor-pointer text-sm font-mono font-semibold text-center transition-colors border border-border-subtle md:border-none">{val}</div>)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex gap-2 items-center flex-shrink-0 w-full xl:w-auto mt-2 xl:mt-0">
                    <button onClick={() => setIsMaxAds(!isMaxAds)} disabled={isScanning} className={cn("h-[46px] md:h-[50px] px-4 rounded-xl font-semibold tracking-widest text-sm uppercase transition-all flex items-center justify-center gap-2 border border-border-subtle shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed", isMaxAds ? 'bg-urgent-red text-white border-urgent-red' : 'bg-surface-solid text-text-main')} title="Scan every single ad. No limits."><span className="material-symbols-outlined text-[18px] hidden md:block">all_inclusive</span> MAX</button>
                    
                    {isScanning ? (
                      <button onClick={handleCancelScan} className="h-[46px] md:h-[50px] flex-1 md:flex-none bg-urgent-red/10 text-urgent-red hover:bg-urgent-red hover:text-white font-label-caps uppercase tracking-wider font-semibold px-6 rounded-xl border border-urgent-red/30 shadow-[0_0_15px_rgba(239,68,68,0.3)] flex justify-center items-center gap-2 transition-all active:scale-[0.98]">
                        <span className="material-symbols-outlined text-[20px]">cancel</span> Cancel
                      </button>
                    ) : (
                      <button onClick={handleRunScan} className="h-[46px] md:h-[50px] flex-1 md:flex-none bg-electric-blue text-white font-label-caps uppercase tracking-wider font-semibold px-6 rounded-xl border border-border-subtle shadow-[0_0_15px_rgba(59,130,246,0.4)] hover:shadow-[0_0_25px_rgba(59,130,246,0.6)] hover:-translate-y-0.5 transition-all flex justify-center items-center gap-2 active:scale-[0.98]">
                        <span className="material-symbols-outlined text-[20px]">data_usage</span> Scan
                      </button>
                    )}

                    <button onClick={handleReset} disabled={isScanning} title="Clear Latest Scan View" className="h-[46px] md:h-[50px] bg-surface-solid text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 border border-border-subtle shadow-sm hover:shadow-md font-label-caps text-xs uppercase tracking-widest px-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                      <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
                    </button>
                  </div>
                </div>
              </motion.div>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 md:gap-6">
                {[
                  { label: "Last Scan", value: lastScanTime, icon: "schedule", color: "text-primary", glow: "bg-primary" },
                  { id: "competitors", label: "Competitors", value: displayStats.competitors, icon: "corporate_fare", color: "text-secondary", glow: "bg-secondary" },
                  { id: "publishers", label: "Publishers", value: displayStats.accounts, icon: "account_box", color: "text-tertiary-container", glow: "bg-tertiary-container" },
                  { id: "games", label: "Games", value: displayStats.games, icon: "sports_esports", color: "text-electric-blue", glow: "bg-electric-blue" }
                ].map((stat) => {
                  const isExpandable = Boolean(stat.id);

                  return (
                    <motion.div
                      key={stat.label}
                      variants={FADE_UP}
                      whileHover={isExpandable ? { y: -5, scale: 1.01, transition: { duration: 0.18 } } : { y: -5, transition: { duration: 0.2 } }}
                      whileTap={isExpandable ? { scale: 0.985 } : undefined}
                      onClick={() => isExpandable && openStatPanel(stat.id)}
                      onKeyDown={(event) => {
                        if (isExpandable && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          openStatPanel(stat.id);
                        }
                      }}
                      role={isExpandable ? "button" : undefined}
                      tabIndex={isExpandable ? 0 : undefined}
                      aria-label={isExpandable ? `Open ${stat.label} list` : undefined}
                      className={cn(
                        "bg-surface-glass backdrop-blur-xl rounded-2xl p-4 md:p-6 shadow-lg border border-border-subtle relative overflow-hidden group transition-[box-shadow,border-color] hover:shadow-xl flex flex-col justify-between outline-none",
                        isExpandable ? "cursor-pointer hover:border-electric-blue/30 focus-visible:ring-2 focus-visible:ring-electric-blue/50" : "cursor-default"
                      )}
                    >
                      <div className={cn("absolute -right-8 -top-8 w-32 h-32 rounded-full blur-[50px] transition-all duration-500 opacity-20 group-hover:opacity-40", stat.glow)}></div>
                      <div className="flex items-center justify-between gap-3 relative z-10">
                        <div className="flex items-center gap-2 md:gap-3 mb-2 md:mb-4 min-w-0">
                          <div className={cn("w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-surface-solid shadow-sm border border-border-subtle flex items-center justify-center flex-shrink-0", stat.color)}><span className="material-symbols-outlined text-[16px] md:text-[24px]">{stat.icon}</span></div>
                          <span className="font-label-caps text-text-muted uppercase tracking-widest text-[9px] md:text-[11px] font-bold truncate">{stat.label}</span>
                        </div>
                        {isExpandable && (
                          <span className="material-symbols-outlined text-[17px] md:text-[19px] text-text-muted group-hover:text-electric-blue group-hover:translate-x-0.5 transition-all mb-2 md:mb-4">arrow_outward</span>
                        )}
                      </div>
                      <div className={cn("font-mono text-2xl md:text-3xl font-black relative z-10", stat.color)}>{stat.value}</div>
                    </motion.div>
                  );
                })}
              </div>

              {/* Heavy Recharts subtree is memoized so opening drawers/modals does not redraw it. */}
              <DashboardTelemetry historyData={historyData} isDarkMode={isDarkMode} />

              <motion.div variants={FADE_UP} className="grid grid-cols-1 xl:grid-cols-12 gap-6 md:gap-8 mt-2 md:mt-4">
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
                  onToggleNode={toggleNode}
                  onGameClick={handleGameClick}
                  onNukeCompetitorData={handleNukeCompetitorData}
                  onNukePublisherData={handleNukePublisherData}
                />
              </motion.div>
            </motion.div>
          )}

          {/* DIRECTORY SEARCH TAB */}
          {activeTab === "directory" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }} className="flex flex-col w-full gap-6 md:gap-8">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h1 className="font-headline-lg text-2xl md:text-3xl text-text-main tracking-tight uppercase">Master Directory {viewMode === 'latest' && <span className="text-emerald-metric text-sm md:text-lg ml-2 font-bold tracking-widest bg-emerald-metric/10 px-2 md:px-3 py-1 rounded-lg border border-emerald-metric/20 shadow-sm">● LATEST</span>}</h1>
                  <p className="font-body-sm md:font-body-md text-text-muted mt-1">Full database index of all intercepted competitors, publishers, and games.</p>
                </div>
                
                <div className="relative w-full md:w-96">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">search</span>
                  <input value={directorySearch} onChange={(e) => setDirectorySearch(e.target.value)} placeholder="Search games, packages..." className="w-full bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 text-text-main shadow-sm font-body-md transition-shadow" />
                  {directorySearch && <button onClick={() => setDirectorySearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"><span className="material-symbols-outlined text-[18px]">close</span></button>}
                </div>
              </div>

              <div className="flex overflow-x-auto items-center gap-2 border-b border-border-subtle pb-4 custom-scrollbar">
                {[
                  { id: "all", label: `All (${filteredGames.length + processedAccounts.length + filteredCompetitors.length})` },
                  { id: "games", label: `Games (${filteredGames.length})` },
                  { id: "publishers", label: `Publishers (${processedAccounts.length})` },
                  { id: "competitors", label: `Competitors (${filteredCompetitors.length})` }
                ].map(tab => (
                  <button key={tab.id} onClick={() => setDirectoryFilter(tab.id)} className={cn("px-4 py-2 rounded-xl text-xs font-label-caps uppercase tracking-wider font-bold transition-all whitespace-nowrap", directoryFilter === tab.id ? "bg-electric-blue text-white shadow-md" : "bg-surface-glass text-text-muted hover:text-text-main border border-border-subtle shadow-sm")}>{tab.label}</button>
                ))}
              </div>

              {(directoryFilter === "all" || directoryFilter === "games") && filteredGames.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-[18px]">sports_esports</span> Mobile Games</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6">
                    {filteredGames.map(game => (
                      <motion.div whileHover={{ y: -4 }} key={game.id} onClick={() => handleGameClick(game)} className="bg-surface-glass backdrop-blur-xl rounded-2xl border border-border-subtle overflow-hidden shadow-sm hover:shadow-lg transition-all cursor-pointer group flex flex-col relative">
                        {game.header_image && (
                          <div className="h-24 md:h-32 w-full overflow-hidden bg-input-bg relative">
                            <img src={game.header_image} alt={game.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                            {game.video && <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded-md text-[9px] md:text-[10px] text-white flex items-center gap-1 shadow-md"><span className="material-symbols-outlined text-[12px] text-urgent-red drop-shadow-[0_0_5px_rgba(239,68,68,0.8)]">play_arrow</span> Trailer</div>}
                          </div>
                        )}
                        <div className="p-4 md:p-5 flex-1 flex flex-col justify-between relative z-10">
                          <div className="flex gap-3 md:gap-4 items-start">
                            <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-surface-solid border border-border-subtle overflow-hidden flex-shrink-0 shadow-sm group-hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-shadow">
                              {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted flex h-full items-center justify-center">sports_esports</span>}
                            </div>
                            <div className="min-w-0 flex-1">
                              <h4 className="font-body-sm md:font-body-md font-semibold text-text-main truncate group-hover:text-electric-blue transition-colors">{game.title}</h4>
                              <p className="font-body-xs text-[10px] md:text-sm text-text-muted truncate">{game.publisher_name}</p>
                              <p className="font-mono text-[9px] md:text-[10px] text-text-muted/70 truncate mt-0.5">{game.package_name}</p>
                            </div>
                          </div>
                          
                          <div className="mt-3 md:mt-4 pt-3 md:pt-4 border-t border-border-subtle/50 flex items-center justify-between">
                            <span className="font-mono text-[10px] md:text-xs font-semibold text-electric-blue drop-shadow-[0_0_2px_rgba(59,130,246,0.5)]">{game.ad_count || 1} Active Ads</span>
                            <div className="flex items-center gap-2">
                              {game.installs && <span className="text-[9px] md:text-[10px] font-mono font-bold bg-emerald-metric/10 text-emerald-metric px-1.5 md:px-2 py-0.5 rounded shadow-sm">{game.installs}</span>}
                              {Number(game.rating) > 0 && <span className="text-[9px] md:text-[10px] font-mono font-bold bg-tertiary-container/10 text-tertiary-container px-1.5 md:px-2 py-0.5 rounded flex items-center gap-0.5 shadow-sm">⭐ {Number(game.rating).toFixed(1)}</span>}
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
                    <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2">
                      <span className="material-symbols-outlined text-secondary text-[18px]">folder</span> Publisher Accounts
                    </h3>
                    
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <div onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === 'pubGroup' ? null : 'pubGroup'); }}
                             className="bg-surface-glass backdrop-blur-xl text-text-main border border-border-subtle font-label-caps text-[9px] md:text-[10px] uppercase font-bold rounded-lg px-2 md:px-3 py-1.5 outline-none shadow-sm cursor-pointer flex items-center justify-between gap-2 w-[120px] md:min-w-[140px] hover:border-text-muted transition-colors">
                          <span className="truncate">{pubFilterComp === 'all' ? 'All Groups' : competitorTree.find(c => c.id.toString() === pubFilterComp.toString())?.name || 'All Groups'}</span>
                          <span className="material-symbols-outlined text-[14px]">expand_more</span>
                        </div>
                        <AnimatePresence>
                          {activeDropdown === 'pubGroup' && (
                            <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" className="absolute top-full right-0 md:left-0 mt-1 w-48 bg-surface-solid border border-border-subtle rounded-lg shadow-xl max-h-48 overflow-y-auto custom-scrollbar z-50 py-1">
                               <div onClick={() => { setPubFilterComp('all'); setActiveDropdown(null); }} className="px-3 py-2 text-[10px] font-label-caps font-bold hover:bg-input-bg cursor-pointer uppercase">All Groups</div>
                               {competitorTree.map(c => (
                                 <div key={c.id} onClick={() => { setPubFilterComp(c.id); setActiveDropdown(null); }} className="px-3 py-2 text-[10px] font-label-caps font-bold hover:bg-input-bg cursor-pointer uppercase truncate">
                                   {c.name}
                                 </div>
                               ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <button onClick={() => setPubFilterNew(!pubFilterNew)} className={cn("px-2 py-1.5 rounded-lg text-[9px] md:text-[10px] font-label-caps uppercase font-bold border transition-colors shadow-sm flex items-center gap-1", pubFilterNew ? "bg-amber-500/10 text-amber-500 border-amber-500/30 shadow-sm" : "bg-surface-glass backdrop-blur-xl text-text-muted border-border-subtle hover:text-text-main")}>
                        <span className="material-symbols-outlined text-[12px] md:text-[14px]">local_fire_department</span> 7d
                      </button>
                      <div className="flex bg-surface-glass backdrop-blur-xl rounded-lg border border-border-subtle p-0.5 shadow-sm">
                        {[ { id: 'name', label: 'A-Z' }, { id: 'games', label: 'Games' }].map(btn => (
                          <button key={btn.id} onClick={() => setPubSort(btn.id)} className={cn("px-2 py-1 text-[9px] md:text-[10px] font-label-caps uppercase font-bold rounded-md transition-all", pubSort === btn.id ? "bg-secondary text-on-primary-container shadow-md" : "text-text-muted hover:text-text-main")}>{btn.label}</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
                    {processedAccounts.map(acc => {
                      const encoded = encodeURIComponent(acc.publisher_name).replace(/%20/g, '+');
                      return (
                        <motion.div whileHover={{ y: -2 }} key={acc.id} className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-xl p-3 md:p-4 shadow-sm flex flex-col justify-between hover:shadow-lg transition-all gap-3 relative overflow-hidden group">
                          {acc.recentGame && <div className="absolute -right-6 -top-6 w-20 h-20 bg-amber-500/10 rounded-full blur-[20px] pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>}
                          <div className="flex justify-between items-start min-w-0 relative z-10">
                            <div className="min-w-0 pr-2">
                              <h5 className="font-body-sm md:font-body-md font-semibold text-text-main truncate uppercase">{acc.publisher_name}</h5>
                              <p className="font-body-xs text-[10px] md:text-sm text-text-muted truncate">Group: <span className="text-text-main">{acc.competitorName}</span></p>
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => handleNukePublisherData(e, acc.id, acc.publisher_name)} className="text-text-muted hover:text-urgent-red p-1 md:p-1.5 hover:bg-surface-solid rounded-lg transition-colors flex-shrink-0 border border-transparent hover:border-border-subtle shadow-sm" title="Delete Publisher Data"><span className="material-symbols-outlined text-[16px] md:text-[18px]">delete</span></button>
                              <a href={`https://play.google.com/store/apps/developer?id=${encoded}`} target="_blank" rel="noreferrer" className="text-text-muted hover:text-electric-blue p-1 md:p-1.5 hover:bg-surface-solid rounded-lg transition-colors flex-shrink-0 border border-transparent hover:border-border-subtle shadow-sm"><span className="material-symbols-outlined text-[16px] md:text-[18px]">open_in_new</span></a>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 border-t border-border-subtle/50 pt-2 md:pt-3 relative z-10">
                            <span className="text-[9px] md:text-[10px] font-mono font-bold bg-primary/10 text-primary border border-primary/20 px-1.5 md:px-2 py-0.5 rounded shadow-inner">{acc.totalGames} Games</span>
                            <span className="text-[9px] md:text-[10px] font-mono font-bold bg-emerald-metric/10 text-emerald-metric border border-emerald-metric/20 px-1.5 md:px-2 py-0.5 rounded shadow-inner">{formatInstalls(acc.totalInstalls)} Installs</span>
                            {acc.recentGame && <span className="text-[9px] md:text-[10px] font-mono font-bold bg-amber-500 text-white px-1.5 md:px-2 py-0.5 rounded ml-auto">🔥 Recent</span>}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(directoryFilter === "all" || directoryFilter === "competitors") && filteredCompetitors.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2"><span className="material-symbols-outlined text-primary text-[18px]">corporate_fare</span> Competitor Entities</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                    {filteredCompetitors.map(comp => (
                      <motion.div whileHover={{ y: -2 }} key={comp.id} className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-xl p-4 md:p-5 shadow-sm flex items-center justify-between hover:shadow-md transition-all group">
                        <div className="min-w-0 pr-4">
                          <h4 className="font-body-sm md:font-body-md font-semibold text-text-main uppercase truncate">{comp.name}</h4>
                          <p className="font-mono text-[10px] md:text-xs text-text-muted mt-0.5 md:mt-1 truncate">{comp.ads_id || "Direct Target"}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={(e) => handleNukeCompetitorData(e, comp.id, comp.name)} className="text-text-muted hover:text-urgent-red p-1.5 rounded-lg transition-colors border border-transparent hover:border-border-subtle hover:bg-surface-solid opacity-0 group-hover:opacity-100" title="Delete ALL Group Data"><span className="material-symbols-outlined text-[16px] md:text-[18px]">delete</span></button>
                          <button onClick={() => { setSelectedSource(`comp_${comp.id}`); setActiveTab("dashboard"); window.scrollTo(0,0); }} className="bg-surface-solid hover:bg-electric-blue hover:text-white border border-border-subtle px-3 py-1.5 md:px-4 md:py-2 rounded-lg md:rounded-xl text-[10px] md:text-xs font-label-caps uppercase tracking-wider font-bold transition-all shadow-sm">Target</button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* AUTOMATED SCANS TAB */}
          {activeTab === "automated" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-6 md:gap-8 max-w-7xl mx-auto">
              <motion.div variants={FADE_UP} className="flex justify-between items-end mb-4">
                <div>
                  <h1 className="font-headline-lg text-3xl md:text-4xl text-text-main uppercase tracking-tight font-bold">Database Targets</h1>
                  <p className="text-sm text-text-muted mt-2">Manage saved competitors, batch lists, and email reporting targets.</p>
                </div>
              </motion.div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">
                {/* FORMS */}
                <motion.div variants={FADE_UP} className="lg:col-span-4 space-y-6 md:space-y-8">
                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl relative overflow-hidden group">
                    <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-secondary/10 blur-[40px] pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
                    <h2 className="text-base font-bold text-text-main mb-5 flex items-center gap-2 uppercase tracking-wide"><span className="material-symbols-outlined text-secondary text-[24px]">person_add</span> Save Competitor</h2>
                    <form onSubmit={handleSaveCompetitor} className="space-y-4 relative z-10">
                      <input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Playmax" type="text" />
                      <input value={newCompAdsId} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="AR123456789012345" type="text" />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-secondary hover:text-secondary hover:shadow-[0_0_15px_rgba(16,185,129,0.2)] font-label-caps uppercase font-bold py-3.5 px-6 rounded-xl transition-all shadow-md disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save Entity"}</button>
                    </form>
                  </div>
                  
                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl relative overflow-hidden group">
                    <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-primary/10 blur-[40px] pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
                    <h2 className="text-base font-bold text-text-main mb-5 flex items-center gap-2 uppercase tracking-wide"><span className="material-symbols-outlined text-primary text-[24px]">format_list_bulleted_add</span> Create Batch List</h2>
                    <form onSubmit={handleCreateList} className="space-y-4 relative z-10">
                      <input value={newListName} onChange={(e) => setNewListName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Tier 1 Tracking" type="text" />
                      <textarea value={newListTargets} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm resize-none" placeholder="AR123...&#10;AR456..." />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-primary hover:text-primary hover:shadow-[0_0_15px_rgba(59,130,246,0.2)] font-label-caps uppercase font-bold py-3.5 px-6 rounded-xl transition-all shadow-md disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save List"}</button>
                    </form>
                  </div>

                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl relative overflow-hidden group">
                    <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-tertiary-container/10 blur-[40px] pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
                    <h2 className="text-base font-bold text-text-main mb-5 flex items-center gap-2 uppercase tracking-wide"><span className="material-symbols-outlined text-tertiary-container text-[24px]">contact_mail</span> Add Recipient</h2>
                    <form onSubmit={handleSaveEmailList} className="space-y-4 relative z-10">
                      <input value={newEmailName} onChange={(e) => setNewEmailName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-sm md:font-body-md rounded-xl py-2.5 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm" placeholder="e.g. Marketing Team" type="text" />
                      <textarea value={newEmailTargets} onChange={(e) => setNewEmailTargets(e.target.value)} className="w-full h-16 md:h-20 bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-2.5 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 transition-all shadow-sm resize-none" placeholder="hello@gmail.com, team@..." />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle text-text-main hover:border-tertiary-container hover:text-tertiary-container hover:shadow-[0_0_15px_rgba(139,92,246,0.2)] font-label-caps uppercase font-semibold py-2.5 px-6 rounded-xl transition-all shadow-md disabled:opacity-50 text-xs">{isSaving ? "Saving..." : "Save Contact"}</button>
                    </form>
                  </div>
                </motion.div>

                {/* LISTS */}
                <motion.div variants={FADE_UP} className="lg:col-span-8 space-y-6 md:space-y-8">
                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 min-h-[250px] shadow-xl">
                    <h2 className="font-label-caps text-xs text-text-muted uppercase tracking-widest mb-5 font-bold flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">person</span> Saved Competitors</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {savedCompetitors.map((comp) => (
                        <motion.div whileHover={{ y: -2 }} key={comp.id} className="bg-surface-solid border border-border-subtle rounded-xl p-4 flex items-center justify-between transition-all group shadow-sm">
                          <div className="min-w-0 pr-4"><h3 className="text-sm font-bold text-text-main truncate uppercase tracking-wide">{comp.name}</h3><p className="font-mono text-xs text-text-muted mt-1 truncate">{comp.ads_id}</p></div>
                          <button onClick={() => handleDeleteCompetitor(comp.id)} className="bg-surface-glass text-urgent-red border border-border-subtle p-2.5 rounded-lg hover:bg-urgent-red hover:text-white shadow-sm transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"><span className="material-symbols-outlined text-[20px]">delete</span></button>
                        </motion.div>
                      ))}
                      {savedCompetitors.length === 0 && <div className="col-span-full text-sm text-text-muted py-6 text-center italic border-2 border-dashed border-border-subtle rounded-xl">No competitors saved.</div>}
                    </div>
                  </div>

                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 min-h-[250px] shadow-xl">
                    <h2 className="font-label-caps text-xs text-text-muted uppercase tracking-widest mb-5 font-bold flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">view_list</span> Batch Lists</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {targetLists.map((list) => (
                        <motion.div whileHover={{ y: -2 }} key={list.id} className="bg-surface-solid border border-border-subtle rounded-xl p-5 flex flex-col transition-all group shadow-sm">
                          <div className="flex justify-between items-start mb-4">
                            <h3 className="text-base font-bold text-text-main truncate pr-4 uppercase tracking-wide">{list.name}</h3>
                            <button onClick={() => handleToggleList(list.id, list.is_active)} className={cn("w-12 h-6 rounded-full flex items-center px-1 transition-colors border shadow-sm flex-shrink-0", list.is_active ? "bg-emerald-metric border-emerald-metric" : "bg-surface-glass border-border-subtle")}><div className={cn("w-4 h-4 rounded-full bg-white shadow transition-transform", list.is_active ? "translate-x-6" : "translate-x-0")}></div></button>
                          </div>
                          <div className="bg-input-bg border border-border-subtle rounded-lg p-3 h-20 overflow-y-auto font-mono text-xs text-text-muted font-semibold mb-4 shadow-inner">
                            {list.targets.map((t, i) => (<div key={i} className="flex items-center gap-2 mb-1.5"><span className="w-1.5 h-1.5 bg-border-subtle rounded-full flex-shrink-0"></span> <span className="truncate">{t}</span></div>))}
                          </div>
                          <button onClick={() => handleDeleteList(list.id)} className="mt-auto bg-surface-glass text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 border border-border-subtle font-label-caps text-xs uppercase tracking-widest font-bold py-2.5 px-4 rounded-lg shadow-sm transition-all flex justify-center items-center gap-2 opacity-0 group-hover:opacity-100"><span className="material-symbols-outlined text-[18px]">delete</span> Delete List</button>
                        </motion.div>
                      ))}
                      {targetLists.length === 0 && <div className="col-span-full text-sm text-text-muted py-6 text-center italic border-2 border-dashed border-border-subtle rounded-xl">No batch lists created.</div>}
                    </div>
                  </div>

                  <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 min-h-[250px] shadow-xl">
                    <h2 className="font-label-caps text-xs text-text-muted uppercase tracking-widest mb-5 font-bold flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">mail</span> Report Recipients</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {emailLists.map((list) => (
                        <motion.div whileHover={{ y: -2 }} key={list.id} className="bg-surface-solid border border-border-subtle rounded-xl p-5 flex flex-col transition-all group shadow-sm">
                          <h3 className="text-base font-bold text-text-main truncate mb-4 uppercase tracking-wide">{list.name}</h3>
                          <div className="bg-input-bg border border-border-subtle rounded-lg p-3 h-16 overflow-y-auto font-mono text-xs text-text-muted mb-4 shadow-inner">
                            {parseJsonArray(list.emails).map((e, i) => <div key={i} className="truncate mb-1">{e}</div>)}
                          </div>
                          <button onClick={() => handleDeleteEmail(list.id)} className="mt-auto bg-surface-glass text-text-muted hover:text-urgent-red hover:bg-urgent-red/10 border border-border-subtle font-label-caps text-xs uppercase tracking-widest font-bold py-2.5 px-4 rounded-lg shadow-sm transition-all flex justify-center items-center gap-2 opacity-0 group-hover:opacity-100"><span className="material-symbols-outlined text-[18px]">delete</span> Delete Contact</button>
                        </motion.div>
                      ))}
                      {emailLists.length === 0 && <div className="col-span-full text-sm text-text-muted py-6 text-center italic border-2 border-dashed border-border-subtle rounded-xl">No recipients saved.</div>}
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === "settings" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-6 md:gap-8 max-w-4xl mx-auto">
              <div>
                <h1 className="font-headline-lg text-2xl md:text-3xl text-text-main tracking-tight uppercase font-bold">System Settings</h1>
                <p className="font-body-sm md:font-body-md text-text-muted mt-1">Configure background cron daemons, Google Sheets integrations, and report templates.</p>
              </div>

              <form onSubmit={handleSaveSettings} className="space-y-4 md:space-y-6">
                <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl space-y-6">
                  <h3 className="text-base font-bold text-text-main uppercase tracking-wide flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary drop-shadow-[0_0_8px_rgba(16,185,129,0.5)] text-[24px]">smart_toy</span> Background Automations
                  </h3>
                  
                  <div className="flex items-center justify-between p-4 bg-surface-solid rounded-xl border border-border-subtle shadow-sm">
                    <div className="pr-4">
                      <h4 className="text-sm md:text-base font-bold text-text-main">3:00 AM Ghost Scans</h4>
                      <p className="text-xs text-text-muted mt-1">Silently scrapes all saved competitors daily.</p>
                    </div>
                    <button type="button" onClick={() => setSettings(s => ({ ...s, ghost_scan_enabled: s.ghost_scan_enabled === "1" ? "0" : "1" }))} className={cn("w-12 h-6 rounded-full flex items-center px-1 transition-colors border shadow-sm flex-shrink-0", settings.ghost_scan_enabled === "1" ? "bg-emerald-metric border-emerald-metric" : "bg-surface-glass border-border-subtle")}>
                      <div className={cn("w-4 h-4 rounded-full bg-white shadow transition-transform", settings.ghost_scan_enabled === "1" ? "translate-x-6" : "translate-x-0")}></div>
                    </button>
                  </div>
                </div>

                <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl space-y-6">
                  <h3 className="text-base font-bold text-text-main uppercase tracking-wide flex items-center gap-2">
                    <span className="material-symbols-outlined text-electric-blue drop-shadow-[0_0_8px_rgba(59,130,246,0.5)] text-[24px]">cloud_sync</span> Cloud Config
                  </h3>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Google Spreadsheet ID</label>
                    <input type="text" value={settings.google_sheet_id} onChange={(e) => setSettings(s => ({ ...s, google_sheet_id: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-mono text-xs md:text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 shadow-inner" placeholder="e.g. 1tQysvSfu..." />
                  </div>
                </div>

                <div className="bg-surface-glass backdrop-blur-xl border border-border-subtle rounded-2xl p-6 shadow-xl space-y-6">
                  <h3 className="text-base font-bold text-text-main uppercase tracking-wide flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary drop-shadow-[0_0_8px_rgba(245,158,11,0.5)] text-[24px]">description</span> PDF Template
                  </h3>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Email Subject Header</label>
                    <input type="text" value={settings.report_subject_template} onChange={(e) => setSettings(s => ({ ...s, report_subject_template: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 shadow-inner" />
                  </div>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Opening Notes</label>
                    <textarea rows={3} value={settings.report_notes} onChange={(e) => setSettings(s => ({ ...s, report_notes: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle text-sm rounded-xl py-3 px-4 outline-none focus:ring-1 focus:ring-electric-blue/50 shadow-inner resize-none" />
                  </div>
                </div>

                <div className="flex flex-col-reverse sm:flex-row items-center justify-between pt-2 gap-4 relative z-10">
                  {settingsStatus && <span className={cn("font-mono text-xs md:text-sm font-bold bg-surface-glass px-3 md:px-4 py-2 rounded-lg border border-border-subtle shadow-sm w-full sm:w-auto text-center", settingsStatus.includes("success") ? "text-emerald-metric" : "text-urgent-red")}>{settingsStatus}</span>}
                  <button type="submit" disabled={isSavingSettings} className="w-full sm:w-auto bg-electric-blue text-white font-label-caps uppercase tracking-wider font-semibold py-3 px-6 md:py-3.5 md:px-8 rounded-xl shadow-[0_0_15px_rgba(59,130,246,0.4)] hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-[10px] md:text-xs">
                    <span className="material-symbols-outlined text-[18px] md:text-[20px]">{isSavingSettings ? 'sync' : 'save'}</span>
                    {isSavingSettings ? "Saving..." : "Save Config"}
                  </button>
                </div>
              </form>
            </motion.div>
          )}

        </main>
      </div>

      {/* EXPANDABLE DASHBOARD STAT LISTS */}
      <AnimatePresence>
        {activeStatPanel && (() => {
          const meta = {
            competitors: {
              title: "Competitors",
              subtitle: "Tracked competitor groups",
              icon: "corporate_fare",
              color: "text-secondary",
              glow: "bg-secondary",
              total: statCompetitors.length,
              placeholder: "Search competitors or advertiser IDs...",
            },
            publishers: {
              title: "Publishers",
              subtitle: "Publisher accounts discovered across groups",
              icon: "account_box",
              color: "text-tertiary-container",
              glow: "bg-tertiary-container",
              total: statPublishers.length,
              placeholder: "Search publishers or competitor groups...",
            },
            games: {
              title: "Games",
              subtitle: "Unique games discovered by Atlas",
              icon: "sports_esports",
              color: "text-electric-blue",
              glow: "bg-electric-blue",
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
                  <div className={cn("absolute -right-16 -top-20 w-56 h-56 rounded-full blur-[80px] opacity-20 pointer-events-none", meta.glow)}></div>

                  <div className="relative z-10 flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 md:gap-4 min-w-0">
                      <div className={cn("w-11 h-11 md:w-14 md:h-14 rounded-xl md:rounded-2xl bg-surface-solid border border-border-subtle shadow-sm flex items-center justify-center flex-shrink-0", meta.color)}>
                        <span className="material-symbols-outlined text-[24px] md:text-[30px]">{meta.icon}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-headline-lg text-xl md:text-2xl text-text-main font-bold tracking-tight">{meta.title}</h2>
                          <span className={cn("font-mono text-[10px] md:text-xs font-bold px-2 py-0.5 rounded-md bg-input-bg border border-border-subtle", meta.color)}>{meta.total}</span>
                        </div>
                        <p className="font-body-xs md:font-body-sm text-text-muted mt-1 truncate">
                          {viewMode === "latest" && <span className="text-emerald-metric font-bold mr-2">● LATEST</span>}
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

                  <div className="relative z-10 mt-4 flex items-center gap-2 bg-input-bg border border-border-subtle rounded-xl px-3.5 py-2.5 shadow-inner focus-within:ring-2 focus-within:ring-electric-blue/30">
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
                      <p className="font-label-caps uppercase tracking-widest text-xs font-bold">No matches found</p>
                      <p className="font-body-xs text-xs mt-1 opacity-70">Try a different search.</p>
                    </div>
                  ) : activeStatPanel === "competitors" ? (
                    <div className="space-y-2.5">
                      {filteredStatItems.map((comp) => (
                        <div key={`stat-comp-${comp.id ?? comp.name}`} className="group flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-xl bg-surface-glass border border-border-subtle hover:border-secondary/40 hover:bg-input-bg/40 transition-colors">
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-secondary/10 border border-secondary/20 flex items-center justify-center text-secondary flex-shrink-0">
                            <span className="material-symbols-outlined text-[21px] md:text-[24px]">corporate_fare</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-body-md font-bold text-text-main truncate">{comp.name || "Unnamed Competitor"}</h3>
                            <p className="font-mono text-[9px] md:text-[10px] text-text-muted truncate mt-0.5">{comp.ads_id || "No advertiser ID"}</p>
                          </div>
                          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                            <span className="font-mono text-[10px] font-bold text-text-muted bg-surface-solid border border-border-subtle rounded-md px-2 py-1">{comp.publisherCount} pubs</span>
                            <span className="font-mono text-[10px] font-bold text-electric-blue bg-electric-blue/10 border border-electric-blue/20 rounded-md px-2 py-1">{comp.gameCount} games</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : activeStatPanel === "publishers" ? (
                    <div className="space-y-2.5">
                      {filteredStatItems.map((publisher, index) => (
                        <div key={`stat-pub-${publisher.competitorId}-${publisher.id ?? publisher.publisher_name}-${index}`} className="group flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-xl bg-surface-glass border border-border-subtle hover:border-tertiary-container/40 hover:bg-input-bg/40 transition-colors">
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-tertiary-container/10 border border-tertiary-container/20 flex items-center justify-center text-tertiary-container flex-shrink-0">
                            <span className="material-symbols-outlined text-[21px] md:text-[24px]">account_box</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-body-md font-bold text-text-main truncate">{publisher.publisher_name || "Unknown Publisher"}</h3>
                            <p className="font-body-xs text-[10px] md:text-xs text-text-muted truncate mt-0.5">Group: <span className="text-text-main font-semibold">{publisher.competitorName || "Unknown"}</span></p>
                          </div>
                          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                            <span className="font-mono text-[10px] font-bold text-electric-blue bg-electric-blue/10 border border-electric-blue/20 rounded-md px-2 py-1">{publisher.totalGames} games</span>
                            <span className="font-mono text-[10px] font-bold text-emerald-metric bg-emerald-metric/10 border border-emerald-metric/20 rounded-md px-2 py-1">{formatInstalls(publisher.totalInstalls)}</span>
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
                            {Number(game.ad_count) > 0 && <span className="font-label-caps text-[9px] md:text-[10px] font-bold text-urgent-red bg-urgent-red/10 border border-urgent-red/20 rounded-md px-2 py-0.5">+{game.ad_count} Ads</span>}
                            <div className="flex items-center gap-1.5">
                              {getInstallCount(game) > 0 && <span className="font-mono text-[9px] md:text-[10px] font-bold text-emerald-metric bg-emerald-metric/10 border border-emerald-metric/20 rounded-md px-1.5 py-0.5">{game.installs || formatInstalls(getInstallCount(game))}</span>}
                              {getAgeText(game.released) && <span className="font-label-caps text-[9px] md:text-[10px] text-text-muted bg-surface-solid border border-border-subtle rounded-md px-1.5 py-0.5 uppercase">{getAgeText(game.released)}</span>}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex-shrink-0 px-4 md:px-5 py-3 border-t border-border-subtle bg-surface-glass flex items-center justify-between gap-3">
                  <span className="font-mono text-[9px] md:text-[10px] text-text-muted uppercase tracking-wider">Showing {filteredStatItems.length} of {meta.total}</span>
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
                <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-input-bg border border-border-subtle shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
                  {selectedGame.icon ? <img loading="lazy" decoding="async" src={selectedGame.icon} alt="Icon" className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-[40px] text-primary/50">sports_esports</span>}
                </div>
                <div className="flex flex-col pt-1 min-w-0">
                  <h1 className="font-headline-lg text-text-main text-xl md:text-2xl mb-1 leading-tight truncate">{selectedGame.title}</h1>
                  <p className="font-body-xs md:font-body-sm text-text-muted uppercase tracking-wide font-medium mb-3 truncate">{selectedGame.publisher_name}</p>
                  
                  {(() => {
                    const compName = getCompetitorForGame(selectedGame, competitorTree);
                    return compName ? (
                      <div className="flex items-center gap-1.5 text-emerald-metric font-bold text-[10px] md:text-xs uppercase tracking-wider bg-emerald-metric/10 border border-emerald-metric/20 px-2.5 py-1 rounded w-max mb-4 shadow-sm">
                        <span className="material-symbols-outlined text-[14px]">corporate_fare</span>
                        Group: {compName}
                      </div>
                    ) : (
                      <div className="mb-2"></div>
                    );
                  })()}

                  <a href={`https://play.google.com/store/apps/details?id=${selectedGame.package_name}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 bg-electric-blue hover:bg-blue-600 text-white font-label-caps text-xs uppercase px-4 py-2 rounded-lg border border-border-subtle transition-all w-max shadow-sm font-bold active:scale-[0.98]">
                    Play Store <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  </a>
                </div>
              </div>
              <button onClick={closeDrawer} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-glass border border-transparent hover:border-border-subtle transition-all text-text-muted hover:text-text-main bg-surface-solid md:bg-transparent flex-shrink-0"><span className="material-symbols-outlined text-[24px]">close</span></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col gap-8 custom-scrollbar pb-24">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-2xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-widest mb-2 font-bold">Star Rating</p><div className="flex items-center gap-2"><p className="font-headline-lg text-2xl text-text-main font-bold">{Number(selectedGame.rating) > 0 ? Number(selectedGame.rating).toFixed(1) : "N/A"}</p><span className="material-symbols-outlined text-tertiary-container text-[24px] mb-0.5" style={{fontVariationSettings: "'FILL' 1"}}>star</span></div></div>
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-2xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-widest mb-2 font-bold">Review Count</p><p className="font-headline-lg text-2xl text-text-main font-bold">{selectedGame.ratings_count || 0}</p></div>
              </div>
              {selectedGame.screenshots && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-3 font-bold"><span className="w-8 h-[1px] bg-border-subtle"></span> Screenshots</h3>
                  <div className="flex overflow-x-auto gap-4 pb-4 snap-x snap-mandatory custom-scrollbar">
                    {parseJsonArray(selectedGame.screenshots).slice(0, 4).map((url, i) => <div key={i} className="w-[140px] h-[280px] flex-shrink-0 bg-surface-glass rounded-xl overflow-hidden snap-center border border-border-subtle shadow-sm"><img loading="lazy" decoding="async" src={url} alt={`Screenshot ${i}`} className="w-full h-full object-cover hover:scale-105 transition-transform duration-500" /></div>)}
                  </div>
                </div>
              )}
              {selectedGame.similar_apps && (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between"><h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-2 font-bold"><span className="material-symbols-outlined text-[16px] text-urgent-red">radar</span> Clone Radar</h3><span className="font-mono text-[10px] text-text-muted bg-surface-solid px-2.5 py-1 rounded border border-border-subtle font-bold">{parseJsonArray(selectedGame.similar_apps).length} Found</span></div>
                  <div className="space-y-3">
                    {parseJsonArray(selectedGame.similar_apps).length === 0 ? <p className="font-body-sm text-xs text-text-muted italic">No direct copycats detected.</p> : parseJsonArray(selectedGame.similar_apps).map((sim, i) => (
                      <div key={i} className="flex items-center justify-between p-3.5 rounded-xl bg-surface-glass border border-border-subtle shadow-sm group">
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="w-12 h-12 rounded-lg overflow-hidden bg-input-bg flex-shrink-0 border border-border-subtle">
                            {sim.icon ? <img loading="lazy" decoding="async" src={sim.icon} alt={sim.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50 text-[24px] flex h-full items-center justify-center">sports_esports</span>}
                          </div>
                          <div className="min-w-0 pr-2">
                            <p className="font-body-sm font-bold text-text-main truncate">{sim.title}</p>
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
            initial={{ opacity: 0, y: 50, scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, scale: 1 }} 
            exit={{ opacity: 0, y: 50, scale: 0.9 }} 
            className="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-[100] md:w-96 bg-surface-glass backdrop-blur-2xl border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="p-3 md:p-4 flex items-center justify-between border-b border-border-subtle bg-surface-solid/80">
              <div className="flex items-center gap-2 md:gap-3 min-w-0">
                <div className="w-7 h-7 md:w-8 md:h-8 rounded-lg bg-electric-blue/10 border border-electric-blue/20 flex items-center justify-center text-electric-blue flex-shrink-0 shadow-inner">
                  <span className="material-symbols-outlined text-[16px] md:text-[18px] animate-spin">sync</span>
                </div>
                <div className="min-w-0">
                  <h4 className="font-headline-lg text-xs md:text-sm font-bold text-text-main flex items-center gap-1.5 md:gap-2 truncate drop-shadow-sm">
                    Deep Scan Active <span className="w-1.5 h-1.5 bg-emerald-metric rounded-full animate-pulse flex-shrink-0 shadow-sm"></span>
                  </h4>
                  <p className="font-mono text-[9px] md:text-[10px] text-electric-blue truncate">
                    {scanProgress.target} ({scanProgress.targetIndex}/{scanProgress.totalTargets})
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-text-muted flex-shrink-0">
                <button onClick={handleCancelScan} className="p-1.5 hover:bg-urgent-red/10 text-urgent-red rounded-lg transition-colors bg-urgent-red/5" title="Abort Scan">
                  <span className="material-symbols-outlined text-[16px] md:text-[18px]">stop_circle</span>
                </button>
                <button onClick={() => setIsScanMinimized(!isScanMinimized)} className="p-1.5 hover:bg-input-bg hover:text-text-main rounded-lg transition-colors bg-surface-solid" title={isScanMinimized ? "Expand" : "Minimize"}>
                  <span className="material-symbols-outlined text-[16px] md:text-[18px]">{isScanMinimized ? 'open_in_full' : 'minimize'}</span>
                </button>
              </div>
            </div>

            <AnimatePresence>
              {!isScanMinimized && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex flex-col gap-2.5 md:gap-3 p-3 md:p-4 bg-surface-solid/30">
                  <div className="flex justify-between items-center text-[10px] md:text-[11px]">
                    <span className="font-body-sm text-text-muted">
                      Ads: <span className="font-mono font-bold text-text-main">{scanProgress.currentAd}</span> / {scanProgress.totalAds} <span className="text-border-subtle/50 ml-0.5">({scanPercentage}%)</span>
                    </span>
                    <div className="bg-emerald-metric/10 border border-emerald-metric/20 px-2 py-0.5 rounded font-mono font-bold text-emerald-metric flex items-center gap-1 shadow-inner">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-metric animate-ping"></span> {scanProgress.timeRemaining}
                    </div>
                  </div>

                  <div className="w-full h-1.5 md:h-2 bg-input-bg rounded-full overflow-hidden p-0.5 border border-border-subtle shadow-inner">
                    <div className="h-full bg-electric-blue rounded-full shadow-[0_0_10px_rgba(59,130,246,0.8)] transition-all duration-300" style={{ width: `${scanPercentage}%` }}></div>
                  </div>

                  <div className="bg-surface-glass border border-border-subtle rounded-lg md:rounded-xl px-2.5 md:px-3 py-1.5 md:py-2 font-mono text-[9px] md:text-[10px] text-text-muted flex items-center gap-1.5 md:gap-2 shadow-inner">
                    <span className="material-symbols-outlined text-secondary text-[12px] md:text-[14px] flex-shrink-0">terminal</span>
                    <span className="truncate">{scanProgress.logs[scanProgress.logs.length - 1] || "Initializing..."}</span>
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
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/65" onClick={() => setIsGuideOpen(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-xl bg-surface-solid border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
              <div className="p-4 md:p-6 border-b border-border-subtle flex items-center justify-between bg-surface-glass sticky top-0 z-10">
                <h2 className="font-headline-lg text-lg md:text-xl text-text-main font-bold flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue">radar</span> How Atlas Works</h2>
                <button onClick={() => setIsGuideOpen(false)} className="w-8 h-8 rounded-full hover:bg-input-bg flex items-center justify-center transition-colors text-text-muted hover:text-text-main"><span className="material-symbols-outlined text-[20px]">close</span></button>
              </div>
              <div className="p-4 md:p-6 overflow-y-auto custom-scrollbar space-y-8">
                
                <div className="space-y-2.5">
                  <h3 className="font-label-caps text-xs text-electric-blue uppercase tracking-widest font-bold">1. The Core Premise</h3>
                  <p className="font-body-sm text-text-muted leading-relaxed">Atlas is a competitive intelligence engine. It monitors competitor ad campaigns, reverse-engineers their Google Play bundle IDs from live creatives, and maps their publisher entity networks.</p>
                </div>
                
                <div className="space-y-2.5">
                  <h3 className="font-label-caps text-xs text-secondary uppercase tracking-widest font-bold">2. How to Run a Scan</h3>
                  <ul className="space-y-3 font-body-sm text-text-muted">
                    <li className="leading-relaxed"><span className="text-text-main font-bold pr-1">• Brand Search:</span>Enter a name (e.g., <code className="bg-input-bg border border-border-subtle rounded px-1.5 py-0.5 font-mono text-[11px] text-text-main">Voodoo</code>) to search Google's Transparency records.</li>
                    <li className="leading-relaxed"><span className="text-text-main font-bold pr-1">• Direct ID:</span>Paste a Google Advertiser ID (e.g., <code className="bg-input-bg border border-border-subtle rounded px-1.5 py-0.5 font-mono text-[11px] text-text-main">AR01234...</code>) for direct deep scanning.</li>
                    <li className="leading-relaxed"><span className="text-text-main font-bold pr-1">• Automated:</span>Save competitors or build Batch Lists in the Automated Scans tab to track them without manual entry.</li>
                  </ul>
                </div>
                
                <div className="space-y-2.5">
                  <h3 className="font-label-caps text-xs text-tertiary-container uppercase tracking-widest font-bold">3. Managing Data</h3>
                  <ul className="space-y-3 font-body-sm text-text-muted">
                    <li className="leading-relaxed"><span className="text-text-main font-bold pr-1">• Live Directory:</span>Expand groups and publishers to view specific games.</li>
                    <li className="leading-relaxed"><span className="text-text-main font-bold pr-1">• Data Cleanup:</span>Click the <span className="material-symbols-outlined text-[14px] align-middle text-text-main bg-input-bg rounded p-0.5 border border-border-subtle">delete</span> trash icon next to any Competitor or Publisher to permanently wipe their test data from the database.</li>
                  </ul>
                </div>

              </div>
              <div className="p-4 border-t border-border-subtle bg-surface-glass flex justify-end">
                <button onClick={() => setIsGuideOpen(false)} className="bg-electric-blue text-white font-label-caps text-xs font-bold px-6 py-2.5 rounded-lg shadow-sm hover:shadow-md transition-all active:scale-[0.98]">Got It</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;