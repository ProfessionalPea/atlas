import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { cn } from "./lib/utils"; 

const CHART_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6"];

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

function App() {
  const [activeTab, setActiveTab] = useState("dashboard"); 
  const [trendingSort, setTrendingSort] = useState("ads");
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [trending, setTrending] = useState([]);
  const [historyData, setHistoryData] = useState({ data: [], lines: [] });

  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryFilter, setDirectoryFilter] = useState("all"); 

  const [settings, setSettings] = useState({
    ghost_scan_enabled: "1",
    auto_report_enabled: "1",
    default_report_email: "",
    report_subject_template: "",
    report_notes: "",
    google_sheet_id: "",
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");

  const [isScanning, setIsScanning] = useState(false);
  const [isScanMinimized, setIsScanMinimized] = useState(false);
  const [isSaving, setIsSaving] = useState(false); 
  const [isMaxAds, setIsMaxAds] = useState(false); 
  const [activeDropdown, setActiveDropdown] = useState(null);
  
  const [lastScanTime, setLastScanTime] = useState("Never");
  const [scanQuery, setScanQuery] = useState("");
  const [scanLimit, setScanLimit] = useState(20);
  const [selectedSource, setSelectedSource] = useState("manual"); 
  const [selectedEmailList, setSelectedEmailList] = useState("none");

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
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

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("atlas_theme");
    if (saved) return saved === "dark";
    return true; 
  });

  useEffect(() => {
    const closeDropdowns = () => setActiveDropdown(null);
    document.addEventListener("click", closeDropdowns);
    return () => document.removeEventListener("click", closeDropdowns);
  }, []);

  const sortedTrending = (Array.isArray(trending) ? [...trending] : []).sort((a, b) => {
    if (trendingSort === "ads") return (b.ad_count || 1) - (a.ad_count || 1);
    if (trendingSort === "newest") {
      const timeA = a.released && a.released !== "Unknown" ? new Date(a.released).getTime() : 0;
      const timeB = b.released && b.released !== "Unknown" ? new Date(b.released).getTime() : 0;
      return timeB - timeA; 
    }
    return (b.min_installs || 0) - (a.min_installs || 0);
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add("dark");
      localStorage.setItem("atlas_theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("atlas_theme", "light");
    }
  }, [isDarkMode]);

  const processHistoryData = (rawHistory) => {
    if (!rawHistory || rawHistory.length === 0) return { data: [], lines: [] };
    const grouped = {};
    const lines = new Set();
    rawHistory.forEach(row => {
      const dateObj = new Date(row.scan_date);
      const shortDate = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (!grouped[shortDate]) grouped[shortDate] = { date: shortDate };
      grouped[shortDate][row.name] = row.total_ads;
      lines.add(row.name);
    });
    return { data: Object.values(grouped), lines: Array.from(lines) };
  };

  const loadAllData = () => {
    fetch("http://localhost:3000/api/stats").then(res => res.json()).then(data => setStats(data.error ? {competitors:0, accounts:0, games:0} : data)).catch(console.error);
    fetch("http://localhost:3000/api/competitors").then(res => res.json()).then(data => setCompetitorTree(Array.isArray(data) ? data : [])).catch(console.error);
    fetch("http://localhost:3000/api/trending").then(res => res.json()).then(data => setTrending(Array.isArray(data) ? data : [])).catch(console.error);
    fetch("http://localhost:3000/api/lists").then(res => res.json()).then(data => setTargetLists(Array.isArray(data) ? data : [])).catch(console.error);
    fetch("http://localhost:3000/api/saved-competitors").then(res => res.json()).then(data => setSavedCompetitors(Array.isArray(data) ? data : [])).catch(console.error);
    fetch("http://localhost:3000/api/emails").then(res => res.json()).then(data => setEmailLists(Array.isArray(data) ? data : [])).catch(console.error); 
    fetch("http://localhost:3000/api/competitor-history").then(res => res.json()).then(data => setHistoryData(processHistoryData(data))).catch(console.error);
    fetch("http://localhost:3000/api/settings").then(res => res.json()).then(data => { if (data && !data.error) setSettings(prev => ({ ...prev, ...data })); }).catch(console.error);
  };

  useEffect(() => { loadAllData(); }, []);

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setIsSavingSettings(true);
    setSettingsStatus("");
    try {
      const res = await fetch("http://localhost:3000/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      const data = await res.json();
      if (data.status === "success") { setSettingsStatus("Settings saved successfully!"); setTimeout(() => setSettingsStatus(""), 3500); }
    } catch (err) { setSettingsStatus("Failed to save settings."); } finally { setIsSavingSettings(false); }
  };

  const handleSeedHistory = async () => {
    if (!window.confirm("Seed 7 days of historical testing data?")) return;
    try { await fetch("http://localhost:3000/api/dev/seed-history", { method: "POST" }); loadAllData(); } catch (err) {}
  };

  const handleCreateList = async (e) => {
    e.preventDefault();
    if (!newListName || !newListTargets || isSaving) return;
    setIsSaving(true);
    const parsedTargets = newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t);
    try { await fetch("http://localhost:3000/api/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newListName, targets: parsedTargets }) }); setNewListName(""); setNewListTargets(""); loadAllData(); } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleToggleList = async (id, currentStatus) => {
    try { await fetch(`http://localhost:3000/api/lists/${id}/toggle`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 }) }); loadAllData(); } catch (err) { console.error(err); }
  };

  const handleSaveCompetitor = async (e) => {
    e.preventDefault();
    if (!newCompName || !newCompAdsId || isSaving) return;
    setIsSaving(true);
    try { await fetch("http://localhost:3000/api/competitors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newCompName, adsId: newCompAdsId, country: "Any" }) }); setNewCompName(""); setNewCompAdsId(""); loadAllData(); } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleSaveEmailList = async (e) => {
    e.preventDefault();
    if (!newEmailName || !newEmailTargets || isSaving) return;
    setIsSaving(true);
    const parsedEmails = newEmailTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t);
    try { await fetch("http://localhost:3000/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newEmailName, emails: parsedEmails }) }); setNewEmailName(""); setNewEmailTargets(""); loadAllData(); } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleDeleteList = async (id) => { if (!window.confirm("Delete this target list?")) return; try { await fetch(`http://localhost:3000/api/lists/${id}`, { method: "DELETE" }); loadAllData(); } catch (err) { console.error(err); } };
  const handleDeleteCompetitor = async (id) => { if (!window.confirm("Delete this saved competitor?")) return; try { await fetch(`http://localhost:3000/api/saved-competitors/${id}`, { method: "DELETE" }); loadAllData(); } catch (err) { console.error(err); } };
  const handleDeleteEmail = async (id) => { if (!window.confirm("Delete this email target?")) return; try { await fetch(`http://localhost:3000/api/emails/${id}`, { method: "DELETE" }); loadAllData(); } catch (err) { console.error(err); } };

  const handleCancelScan = async () => {
    if (!window.confirm("Abort the current scan? Any targets already processed will be saved safely.")) return;
    try {
      await fetch("http://localhost:3000/api/cancel-scan", { method: "POST" });
      setScanProgress(prev => ({ ...prev, logs: [...prev.logs, "> 🛑 Sending abort signal to backend..."] }));
    } catch (err) { console.error("Cancel failed:", err); }
  };

  const handleRunScan = async () => {
    if (selectedSource === "manual" && !scanQuery) return alert("Please enter a competitor name or AR ID!");
    setIsScanning(true);
    setIsScanMinimized(false);
    const finalLimit = isMaxAds ? 999999 : scanLimit;
    setScanProgress({ target: "Initializing...", targetIndex: 1, totalTargets: 1, currentAd: 0, totalAds: finalLimit, timeRemaining: "Calculating...", logs: ["> Booting Intelligence Node..."] });

    let scanType = "manual"; let targetId = null;
    if (selectedSource.startsWith("list_")) { scanType = "list"; targetId = selectedSource.split("_")[1]; } 
    else if (selectedSource.startsWith("comp_")) { scanType = "competitor"; targetId = selectedSource.split("_")[1]; }

    const eventSource = new EventSource("http://localhost:3000/api/scan-stream");
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setScanProgress(prev => {
        const newLogs = [...prev.logs, data.log];
        if (newLogs.length > 5) newLogs.shift();
        return { ...prev, target: data.target || prev.target, targetIndex: data.targetIndex || prev.targetIndex, totalTargets: data.totalTargets || prev.totalTargets, currentAd: data.currentAd, totalAds: data.totalAds || prev.totalAds, timeRemaining: data.timeRemaining, logs: newLogs };
      });
    };

    try {
      const res = await fetch("http://localhost:3000/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ searchQuery: scanQuery, scanType, targetId, targetCountry: "Any", limit: finalLimit, sendReport: selectedEmailList !== "none", emailListId: selectedEmailList }) });
      if ((await res.json()).status === "success" || (await res.json()).status === "cancelled") { 
        setLastScanTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})); 
        loadAllData(); 
      }
    } catch (err) { 
      console.error("Scan failed:", err); 
    } finally { 
      eventSource.close(); 
      setTimeout(() => setIsScanning(false), 2000);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("⚠️ WARNING: Are you sure you want to wipe the scan cache? (Saved lists will be kept)")) return;
    try { const res = await fetch("http://localhost:3000/api/reset", { method: "POST" }); if ((await res.json()).status === "success") { setLastScanTime("Never"); loadAllData(); } } catch (err) { console.error("Failed to reset:", err); }
  };

  const handleGameClick = (game) => { setSelectedGame(game); setIsDrawerOpen(true); };
  const closeDrawer = () => { setIsDrawerOpen(false); setTimeout(() => setSelectedGame(null), 300); };

  const getTargetSourceName = () => {
    if (selectedSource === "manual") return "📝 Manual Entry";
    if (selectedSource.startsWith("comp_")) { const comp = savedCompetitors.find(c => `comp_${c.id}` === selectedSource); return comp ? `👤 ${comp.name}` : "Saved Competitor"; }
    if (selectedSource.startsWith("list_")) { const list = targetLists.find(l => `list_${l.id}` === selectedSource); return list ? `📂 ${list.name}` : "Target List"; }
    return "Select Source";
  };

  const getEmailListName = () => {
    if (selectedEmailList === "none") return "❌ Don't Send";
    const list = emailLists.find(e => e.id.toString() === selectedEmailList.toString());
    return list ? `✉️ ${list.name}` : "Don't Send";
  };

  const fadeUp = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };
  const dropDownAnim = { hidden: { opacity: 0, y: -10, scale: 0.95 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.15, ease: "easeOut" } }, exit: { opacity: 0, y: -10, scale: 0.95, transition: { duration: 0.1, ease: "easeIn" } } };
  const scanPercentage = Math.min(100, (scanProgress.currentAd / Math.max(1, scanProgress.totalAds)) * 100).toFixed(0);

  const searchLower = directorySearch.toLowerCase();
  const filteredGames = trending.filter(g => 
    (g.title || "").toLowerCase().includes(searchLower) || (g.publisher_name || "").toLowerCase().includes(searchLower) || (g.package_name || "").toLowerCase().includes(searchLower)
  );
  
  const allAccounts = [];
  competitorTree.forEach(comp => {
    (comp.accounts || []).forEach(acc => {
      if ((acc.publisher_name || "").toLowerCase().includes(searchLower) || (comp.name || "").toLowerCase().includes(searchLower)) {
        allAccounts.push({ ...acc, competitorName: comp.name });
      }
    });
  });

  const filteredCompetitors = competitorTree.filter(c => 
    (c.name || "").toLowerCase().includes(searchLower) || (c.ads_id || "").toLowerCase().includes(searchLower)
  );

  return (
    <div className="bg-bg-base font-body-md text-text-main min-h-screen relative transition-colors duration-400 z-10 overflow-x-hidden">

      {/* RESTORED SIDEBAR WITH ALL 4 TABS */}
      <aside className="fixed left-0 top-0 h-full w-64 lg:w-72 bg-surface-glass backdrop-blur-xl z-40 hidden md:flex flex-col border-r border-border-subtle transition-colors duration-400">
        <div className="px-6 lg:px-8 py-8 flex items-center gap-3">
          <img src="/atlas-logo.png" alt="Atlas Logo" className="h-10 w-10 object-contain rounded-md shadow-lg" />
          <span className="font-headline-lg text-2xl tracking-tight text-text-main">Atlas</span>
        </div>
        <nav className="flex-1 px-4 mt-4 space-y-2">
          {[ 
            { id: "dashboard", icon: "dashboard", label: "Dashboard" },
            { id: "directory", icon: "folder_shared", label: "Directory" },
            { id: "automated", icon: "radar", label: "Automated Scans" },
            { id: "settings", icon: "tune", label: "Settings" }
          ].map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className="relative w-full flex items-center px-4 py-3 rounded-xl group text-left">
              {activeTab === tab.id && <motion.div layoutId="sidebar-active" className="absolute inset-0 bg-primary-container rounded-xl z-0" transition={{ type: "spring", stiffness: 300, damping: 30 }} />}
              <span className={cn("material-symbols-outlined mr-4 z-10 transition-colors", activeTab === tab.id ? "text-on-primary-container" : "text-text-muted group-hover:text-text-main text-[22px]")}>{tab.icon}</span>
              <span className={cn("font-body-md z-10 transition-colors", activeTab === tab.id ? "text-on-primary-container font-bold" : "text-text-muted group-hover:text-text-main")}>{tab.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="md:pl-64 lg:pl-72">
        <header className="fixed top-0 md:left-64 lg:left-72 right-0 h-20 bg-surface-glass/90 backdrop-blur-xl z-30 px-6 lg:px-8 flex items-center justify-between border-b border-border-subtle transition-colors duration-400">
          <div className="flex items-center gap-4">
            <div className="h-2 w-2 rounded-full bg-secondary animate-pulse"></div>
            <span className="font-label-caps text-[10px] lg:text-xs text-text-muted uppercase tracking-widest hidden sm:block">System Active: Ready to scan</span>
          </div>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="w-10 h-10 rounded-full flex items-center justify-center text-text-muted hover:text-text-main hover:bg-surface-glass transition-all shadow-sm border border-border-subtle">
            <span className="material-symbols-outlined text-[20px]">{isDarkMode ? "light_mode" : "dark_mode"}</span>
          </button>
        </header>

        <main className="relative pt-24 min-h-screen px-4 sm:px-6 lg:px-8 py-8">
          
          {/* DASHBOARD TAB */}
          {activeTab === "dashboard" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-8">
              
              <motion.div variants={fadeUp} className={cn("w-full bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl relative border border-border-subtle z-50", isScanning && "opacity-75 pointer-events-none")}>
                <div className="relative flex flex-wrap items-end gap-4 w-full">
                  
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Name / ID</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">radar</span>
                      <input value={selectedSource === "manual" ? scanQuery : "Auto-Target Selected"} onChange={(e) => setScanQuery(e.target.value)} disabled={selectedSource !== "manual" || isScanning}
                        className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner disabled:opacity-50" placeholder="e.g. Voodoo or ID: 12345" type="text" />
                    </div>
                  </div>

                  <div className="w-full sm:w-56 space-y-2 relative">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Source</label>
                    <div onClick={(e) => { if(!isScanning) { e.stopPropagation(); setActiveDropdown(activeDropdown === 'source' ? null : 'source'); } }}
                      className={cn("w-full bg-input-bg text-text-main border font-body-md rounded-xl py-3 pl-10 pr-4 outline-none transition-all shadow-inner cursor-pointer flex items-center justify-between select-none", activeDropdown === 'source' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50')}
                    >
                      <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px]">list_alt</span>
                      <span className="truncate font-semibold text-sm">{getTargetSourceName()}</span>
                      <span className="material-symbols-outlined text-text-muted text-[20px] transition-transform" style={{ transform: activeDropdown === 'source' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                    </div>
                    <AnimatePresence>
                      {activeDropdown === 'source' && (
                        <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 w-full mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl max-h-[400px] overflow-y-auto custom-scrollbar p-2 z-50">
                          <div onClick={() => { setSelectedSource("manual"); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm font-semibold transition-colors">📝 Manual Entry</div>
                          {savedCompetitors.length > 0 && <><div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Competitors</div>{savedCompetitors.map(c => <div key={`comp_${c.id}`} onClick={() => { setSelectedSource(`comp_${c.id}`); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">👤 {c.name}</div>)}</>}
                          {targetLists.length > 0 && <><div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Target Lists</div>{targetLists.map(l => <div key={`list_${l.id}`} onClick={() => { setSelectedSource(`list_${l.id}`); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">📂 {l.name}</div>)}</>}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="w-full sm:w-56 space-y-2 relative">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Email Report To</label>
                    <div onClick={(e) => { if(!isScanning) { e.stopPropagation(); setActiveDropdown(activeDropdown === 'email' ? null : 'email'); } }}
                      className={cn("w-full bg-input-bg text-text-main border font-body-md rounded-xl py-3 pl-10 pr-4 outline-none transition-all shadow-inner cursor-pointer flex items-center justify-between select-none", activeDropdown === 'email' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50')}
                    >
                      <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px]">mail</span>
                      <span className="truncate font-semibold text-sm">{getEmailListName()}</span>
                      <span className="material-symbols-outlined text-text-muted text-[20px] transition-transform" style={{ transform: activeDropdown === 'email' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                    </div>
                    <AnimatePresence>
                      {activeDropdown === 'email' && (
                        <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 w-full mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl max-h-[400px] overflow-y-auto custom-scrollbar p-2 z-50">
                          <div onClick={() => { setSelectedEmailList("none"); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-urgent-red/10 text-urgent-red cursor-pointer text-sm font-semibold transition-colors">❌ Don't Send</div>
                          {emailLists.length > 0 && <><div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Contacts</div>{emailLists.map(e => <div key={e.id} onClick={() => { setSelectedEmailList(e.id); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">✉️ {e.name}</div>)}</>}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  
                  <div className="w-full sm:w-40 space-y-2 relative">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Ad Limit</label>
                    <div className={cn("flex items-center bg-input-bg border rounded-xl shadow-inner transition-all h-[50px]", (isMaxAds || isScanning) ? 'border-urgent-red/50 opacity-50 cursor-not-allowed' : activeDropdown === 'limit' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50')}>
                      <button disabled={isMaxAds || isScanning} onClick={() => setScanLimit(Math.max(1, scanLimit - 10))} className="h-full px-3 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-l-xl transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">remove</span></button>
                      <input disabled={isMaxAds || isScanning} value={isMaxAds ? "ALL" : scanLimit} onChange={(e) => { const val = e.target.value.replace(/\D/g, ''); setScanLimit(val === '' ? '' : Number(val)); }} onBlur={() => { if (!scanLimit || scanLimit < 1) setScanLimit(1); }} className="w-full h-full bg-transparent text-text-main text-center font-mono font-bold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed" type="text" />
                      <button disabled={isMaxAds || isScanning} onClick={() => setScanLimit((scanLimit || 0) + 10)} className="h-full px-3 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50"><span className="material-symbols-outlined text-[16px]">add</span></button>
                      <div className="w-px h-6 bg-border-subtle"></div>
                      <button disabled={isMaxAds || isScanning} onClick={(e) => { e.stopPropagation(); if(!isMaxAds && !isScanning) setActiveDropdown(activeDropdown === 'limit' ? null : 'limit'); }} className="h-full px-2 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-r-xl transition-colors disabled:opacity-50 flex items-center justify-center"><span className="material-symbols-outlined text-[18px]">arrow_drop_down</span></button>
                    </div>
                    <AnimatePresence>
                      {activeDropdown === 'limit' && !isMaxAds && (
                        <motion.div variants={dropDownAnim} initial="hidden" animate="show" exit="exit" onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 w-28 mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl overflow-hidden p-2 z-50">
                          {[10, 20, 50, 100, 250, 500].map(val => <div key={val} onClick={() => { setScanLimit(val); setActiveDropdown(null); }} className="px-3 py-2 rounded-lg hover:bg-surface-glass cursor-pointer text-sm font-mono text-center transition-colors">{val}</div>)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex gap-3 items-center flex-shrink-0 w-full md:w-auto mt-4 md:mt-0">
                    <button onClick={() => setIsMaxAds(!isMaxAds)} disabled={isScanning} className={cn("h-[50px] px-6 rounded-xl font-bold tracking-widest text-sm uppercase transition-all flex items-center justify-center gap-2 border disabled:opacity-50 disabled:cursor-not-allowed", isMaxAds ? 'bg-urgent-red border-urgent-red text-white shadow-xl' : 'bg-surface-solid border-border-subtle text-text-muted hover:bg-surface-glass hover:text-text-main')} title="Scan every single ad. No limits."><span className="material-symbols-outlined text-[18px]">all_inclusive</span> MAX</button>
                    
                    {/* CANCEL SCAN BUTTON */}
                    {isScanning ? (
                      <button onClick={handleCancelScan} className="h-[50px] flex-1 md:flex-none bg-urgent-red/10 text-urgent-red hover:bg-urgent-red hover:text-white font-label-caps uppercase tracking-wider font-bold px-6 rounded-xl border border-urgent-red/30 shadow-md flex justify-center items-center gap-2 transition-all">
                        <span className="material-symbols-outlined text-[20px]">cancel</span> Cancel Scan
                      </button>
                    ) : (
                      <button onClick={handleRunScan} className="h-[50px] flex-1 md:flex-none bg-electric-blue hover:bg-primary-container text-white font-body-md font-semibold px-6 rounded-xl shadow-lg transition-all flex justify-center items-center gap-2">
                        <span className="material-symbols-outlined text-[20px]">data_usage</span> Run Scan
                      </button>
                    )}

                    <button onClick={handleReset} disabled={isScanning} className="h-[50px] text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest px-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"><span className="material-symbols-outlined text-[18px]">delete_sweep</span></button>
                  </div>
                </div>
              </motion.div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
                {[
                  { label: "Last Scan", value: lastScanTime, icon: "schedule", color: "text-primary", bg: "bg-primary/10" },
                  { label: "Competitors", value: stats.competitors, icon: "corporate_fare", color: "text-secondary", bg: "bg-secondary/10" },
                  { label: "Publishers", value: stats.accounts, icon: "account_box", color: "text-tertiary-container", bg: "bg-tertiary-container/10" },
                  { label: "Games", value: stats.games, icon: "sports_esports", color: "text-electric-blue", bg: "bg-electric-blue/10" }
                ].map((stat, i) => (
                  <motion.div key={stat.label} variants={fadeUp} whileHover={{ y: -4, transition: { duration: 0.2 } }} className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group transition-shadow hover:shadow-xl cursor-default">
                    <div className={cn("absolute -right-4 -top-4 w-24 h-24 rounded-full blur-xl transition-colors", stat.bg)}></div>
                    <div className="flex items-center gap-3 mb-4">
                      <div className={cn("w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center shadow-sm border border-border-subtle", stat.color)}><span className="material-symbols-outlined">{stat.icon}</span></div>
                      <span className="font-label-caps text-text-muted uppercase tracking-widest">{stat.label}</span>
                    </div>
                    <div className="font-metric-xl text-text-main">{stat.value}</div>
                  </motion.div>
                ))}
              </div>

              {/* VELOCITY CHART */}
              <motion.div variants={fadeUp} className="w-full bg-surface-glass border border-border-subtle rounded-2xl shadow-xl p-6 h-[400px] flex flex-col">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="font-headline-lg text-text-main text-xl">Competitor Ad Velocity</h2>
                    <p className="font-body-xs text-text-muted">Historical ad push volume over time</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={handleSeedHistory} className="text-[10px] font-label-caps uppercase tracking-wider bg-surface-solid border border-border-subtle px-2 py-1 rounded-md text-text-muted hover:text-text-main transition-colors shadow-sm">
                      Time Machine
                    </button>
                    <span className="flex items-center gap-1.5 font-label-caps text-xs text-text-muted"><span className="w-2 h-2 rounded-full bg-electric-blue"></span> Active Trend</span>
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
                        <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 12, fontFamily: 'Inter' }} dy={10} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: isDarkMode ? '#94a3b8' : '#64748b', fontSize: 12, fontFamily: 'Inter' }} />
                        <Tooltip 
                          contentStyle={{ backgroundColor: isDarkMode ? '#1e293b' : '#ffffff', borderColor: isDarkMode ? '#334155' : '#e2e8f0', borderRadius: '12px', color: isDarkMode ? '#f8fafc' : '#0f172a', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                          itemStyle={{ fontSize: '14px', fontWeight: 'bold' }}
                          labelStyle={{ color: isDarkMode ? '#94a3b8' : '#64748b', marginBottom: '4px' }}
                        />
                        {historyData.lines.map((competitorName, index) => (
                          <Area key={competitorName} type="monotone" dataKey={competitorName} stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={3} fillOpacity={1} fill={`url(#color${index})`} activeDot={{ r: 6, strokeWidth: 0 }} />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-text-muted">
                      <span className="material-symbols-outlined text-4xl mb-2 opacity-50">show_chart</span>
                      <p className="font-body-sm">Click 'Time Machine' or run scans to build data.</p>
                    </div>
                  )}
                </div>
              </motion.div>

              <motion.div variants={fadeUp} className="grid grid-cols-1 xl:grid-cols-12 gap-8 mt-4">
                <div className="xl:col-span-7 bg-surface-glass border border-border-subtle rounded-2xl shadow-xl flex flex-col h-[600px]">
                  <div className="p-6 pb-4 bg-surface-solid border-b border-border-subtle rounded-t-2xl flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h2 className="font-headline-lg text-text-main text-xl">Trending Radar</h2>
                      <p className="font-body-xs text-text-muted">{trendingSort === "installs" ? "Ranked by total install volume" : trendingSort === "newest" ? "Ranked by newest game release" : "Ranked by ad push volume"}</p>
                    </div>
                    <div className="flex items-center gap-1 bg-input-bg p-1 rounded-xl border border-border-subtle shadow-inner">
                      {[ { id: 'ads', icon: 'local_fire_department', label: 'Ad Push' }, { id: 'installs', icon: 'download', label: 'Installs' }, { id: 'newest', icon: 'schedule', label: 'Newest' }].map(btn => (
                        <button key={btn.id} onClick={() => setTrendingSort(btn.id)} className={cn("px-3 py-1.5 text-xs font-label-caps uppercase rounded-lg transition-all flex items-center gap-1.5", trendingSort === btn.id ? "bg-electric-blue text-white shadow-sm font-semibold" : "text-text-muted hover:text-text-main")}><span className="material-symbols-outlined text-[14px]">{btn.icon}</span> {btn.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 p-2 space-y-2 overflow-y-auto custom-scrollbar">
                    {sortedTrending.length === 0 ? <div className="text-center font-body-sm text-text-muted mt-10">No trending data. Run a scan!</div> : sortedTrending.map((game) => (
                      <motion.div layoutId={`game-${game.id}`} key={game.id} onClick={() => handleGameClick(game)} className="flex items-center p-4 rounded-xl hover:bg-surface-solid border border-transparent hover:border-border-subtle cursor-pointer transition-all group">
                        <div className="w-12 h-12 rounded-xl overflow-hidden bg-input-bg border border-border-subtle shadow-md flex items-center justify-center flex-shrink-0 mr-4">
                          {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50">sports_esports</span>}
                        </div>
                        <div className="flex-1 min-w-0"><h3 className="font-body-md font-semibold text-text-main truncate group-hover:text-primary transition-colors">{game.title}</h3><p className="font-body-sm text-text-muted truncate">{game.publisher_name}</p></div>
                        {game.installs && game.installs !== "0+" && <div className="flex-shrink-0 ml-3 bg-emerald-metric/10 border border-emerald-metric/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 shadow-inner"><span className="material-symbols-outlined text-[14px] text-emerald-metric">download</span><span className="font-mono text-[11px] text-emerald-metric font-bold tracking-wider">{game.installs}</span></div>}
                        {game.ad_count >= 1 && <div className="flex-shrink-0 ml-2 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner" title="Active Creatives Intercepted"><span className="material-symbols-outlined text-[14px] text-amber-500">local_fire_department</span><span className="font-mono text-[11px] text-amber-500 font-bold">{game.ad_count} Ads</span></div>}
                        <div className="flex gap-2 ml-2 flex-shrink-0">
                          {game.released && game.released !== "Unknown" && <div className="bg-primary/10 border border-primary/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner"><span className="material-symbols-outlined text-[14px] text-primary">cake</span><span className="font-mono text-[11px] text-primary font-bold">{getAgeText(game.released)}</span></div>}
                          {game.updated && game.updated !== 0 && <div className="bg-tertiary-container/10 border border-tertiary-container/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner"><span className="material-symbols-outlined text-[14px] text-tertiary-container">update</span><span className="font-mono text-[11px] text-tertiary-container font-bold">{getAgeText(game.updated)} ago</span></div>}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>

                <div className="xl:col-span-5 bg-surface-glass border border-border-subtle rounded-2xl shadow-xl flex flex-col h-[600px]">
                  <div className="p-6 pb-4 bg-surface-solid border-b border-border-subtle rounded-t-2xl"><h2 className="font-headline-lg text-text-main text-xl">Live Directory</h2></div>
                  <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
                    {competitorTree.length === 0 ? <div className="text-center font-body-sm text-text-muted mt-10">No data found.</div> : competitorTree.map((comp) => (
                      <div key={comp.id} className="mb-6"><h3 className="font-body-md font-semibold text-text-main mb-2 uppercase">{comp.name}</h3><div className="ml-4 pl-4 border-l border-border-subtle space-y-4">
                        {comp.accounts && comp.accounts.map(acc => (
                          <div key={acc.id}><div className="font-body-md text-text-main mb-2 mt-4 flex items-center gap-2"><span className="material-symbols-outlined text-secondary">folder</span>{acc.publisher_name}</div>
                            <div className="ml-6 pl-4 border-l border-border-subtle space-y-2">{acc.games && acc.games.map(game => (
                              <div key={game.id} onClick={() => handleGameClick(game)} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-solid cursor-pointer border border-transparent hover:border-border-subtle"><span className="material-symbols-outlined text-text-muted">smartphone</span><p className="font-body-sm font-semibold truncate text-text-main">{game.title}</p></div>
                            ))}</div>
                          </div>
                        ))}
                      </div></div>
                    ))}
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* 2. DIRECTORY SEARCH TAB */}
          {activeTab === "directory" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }} className="flex flex-col w-full gap-8">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h1 className="font-headline-lg text-3xl text-text-main tracking-tight uppercase">Master Directory</h1>
                  <p className="font-body-md text-text-muted mt-1">Full database index of all intercepted competitors, publisher accounts, and mobile games.</p>
                </div>
                
                <div className="relative w-full md:w-96">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">search</span>
                  <input value={directorySearch} onChange={(e) => setDirectorySearch(e.target.value)} placeholder="Search games, packages, developers..." className="w-full bg-surface-solid border border-border-subtle rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 text-text-main shadow-sm font-body-md" />
                  {directorySearch && <button onClick={() => setDirectorySearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"><span className="material-symbols-outlined text-[18px]">close</span></button>}
                </div>
              </div>

              <div className="flex items-center gap-2 border-b border-border-subtle pb-4">
                {[
                  { id: "all", label: `All Items (${filteredGames.length + allAccounts.length + filteredCompetitors.length})` },
                  { id: "games", label: `Games (${filteredGames.length})` },
                  { id: "publishers", label: `Publishers (${allAccounts.length})` },
                  { id: "competitors", label: `Competitors (${filteredCompetitors.length})` }
                ].map(tab => (
                  <button key={tab.id} onClick={() => setDirectoryFilter(tab.id)} className={cn("px-4 py-2 rounded-xl text-xs font-label-caps uppercase tracking-wider font-bold transition-all", directoryFilter === tab.id ? "bg-electric-blue text-white shadow-md" : "bg-surface-glass text-text-muted hover:text-text-main border border-border-subtle")}>{tab.label}</button>
                ))}
              </div>

              {(directoryFilter === "all" || directoryFilter === "games") && filteredGames.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2"><span className="material-symbols-outlined text-electric-blue text-[18px]">sports_esports</span> Mobile Games</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {filteredGames.map(game => (
                      <div key={game.id} onClick={() => handleGameClick(game)} className="bg-surface-glass rounded-2xl border border-border-subtle overflow-hidden shadow-sm hover:shadow-xl transition-all cursor-pointer group flex flex-col">
                        {game.header_image && (
                          <div className="h-32 w-full overflow-hidden bg-input-bg relative">
                            <img src={game.header_image} alt={game.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                            {game.video && <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded-md text-[10px] text-white flex items-center gap-1"><span className="material-symbols-outlined text-[12px] text-urgent-red">play_arrow</span> Trailer</div>}
                          </div>
                        )}
                        <div className="p-5 flex-1 flex flex-col justify-between">
                          <div className="flex gap-4 items-start">
                            <div className="w-12 h-12 rounded-xl bg-input-bg border border-border-subtle overflow-hidden flex-shrink-0 shadow-sm">
                              {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-text-muted">sports_esports</span>}
                            </div>
                            <div className="min-w-0 flex-1">
                              <h4 className="font-headline-lg text-lg text-text-main truncate group-hover:text-electric-blue transition-colors uppercase">{game.title}</h4>
                              <p className="font-body-xs text-text-muted truncate">{game.publisher_name}</p>
                              <p className="font-mono text-[10px] text-text-muted/70 truncate mt-0.5">{game.package_name}</p>
                            </div>
                          </div>
                          
                          <div className="mt-4 pt-4 border-t border-border-subtle/50 flex items-center justify-between">
                            <span className="font-mono text-xs font-bold text-electric-blue">{game.ad_count || 1} Active Ads</span>
                            <div className="flex items-center gap-2">
                              {game.installs && <span className="text-[10px] font-mono font-bold bg-emerald-metric/10 text-emerald-metric px-2 py-0.5 rounded-md">{game.installs}</span>}
                              {game.rating > 0 && <span className="text-[10px] font-mono font-bold bg-tertiary-container/10 text-tertiary-container px-2 py-0.5 rounded-md flex items-center gap-0.5">⭐ {game.rating.toFixed(1)}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(directoryFilter === "all" || directoryFilter === "publishers") && allAccounts.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2"><span className="material-symbols-outlined text-secondary text-[18px]">folder</span> Publisher Accounts</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {allAccounts.map(acc => {
                      const encoded = encodeURIComponent(acc.publisher_name).replace(/%20/g, '+');
                      return (
                        <div key={acc.id} className="bg-surface-glass border border-border-subtle rounded-xl p-4 shadow-sm flex items-center justify-between">
                          <div className="min-w-0 pr-2">
                            <h5 className="font-body-md font-bold text-text-main truncate uppercase">{acc.publisher_name}</h5>
                            <p className="font-body-xs text-text-muted truncate">Group: <span className="text-text-main font-semibold">{acc.competitorName}</span></p>
                          </div>
                          <a href={`https://play.google.com/store/apps/developer?id=${encoded}`} target="_blank" rel="noreferrer" className="text-text-muted hover:text-electric-blue p-2 hover:bg-surface-solid rounded-lg transition-colors flex-shrink-0" title="Open in Play Store"><span className="material-symbols-outlined text-[18px]">open_in_new</span></a>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(directoryFilter === "all" || directoryFilter === "competitors") && filteredCompetitors.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest font-bold flex items-center gap-2"><span className="material-symbols-outlined text-primary text-[18px]">corporate_fare</span> Competitor Entities</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredCompetitors.map(comp => (
                      <div key={comp.id} className="bg-surface-glass border border-border-subtle rounded-xl p-5 shadow-sm flex items-center justify-between">
                        <div>
                          <h4 className="font-headline-lg text-lg text-text-main uppercase font-bold">{comp.name}</h4>
                          <p className="font-mono text-xs text-text-muted mt-1">{comp.ads_id || "Direct Target"}</p>
                          <p className="font-body-xs text-text-muted mt-2">{(comp.accounts || []).length} linked publishers</p>
                        </div>
                        <button onClick={() => { setScanQuery(comp.ads_id || comp.name); setActiveTab("dashboard"); }} className="bg-surface-solid hover:bg-electric-blue hover:text-white border border-border-subtle px-4 py-2 rounded-xl text-xs font-label-caps uppercase tracking-wider font-bold transition-all shadow-sm">Target Scan</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* 3. AUTOMATED SCANS TAB */}
          {activeTab === "automated" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-8">
              <motion.div variants={fadeUp} className="flex justify-between items-end mb-2">
                <div><h1 className="font-headline-lg text-3xl text-text-main tracking-tight">Database Targets</h1><p className="font-body-md text-text-muted mt-2">Manage saved competitors, batch lists, and email reporting targets.</p></div>
              </motion.div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
                <motion.div variants={fadeUp} className="xl:col-span-1 space-y-8">
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-secondary">person_add</span> Save Competitor</h2>
                    <form onSubmit={handleSaveCompetitor} className="space-y-4">
                      <input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Playmax" type="text" />
                      <input value={newCompAdsId} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="AR123456789012345" type="text" />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-secondary/10 hover:border-secondary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all shadow-md disabled:opacity-50">{isSaving ? "Saving..." : "Save"}</button>
                    </form>
                  </div>
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-primary">format_list_bulleted_add</span> Create Batch List</h2>
                    <form onSubmit={handleCreateList} className="space-y-4">
                      <input value={newListName} onChange={(e) => setNewListName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Tier 1 Tracking" type="text" />
                      <textarea value={newListTargets} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-inner resize-none placeholder:text-text-muted" placeholder="AR123..." />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-primary/10 hover:border-primary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all shadow-md disabled:opacity-50">{isSaving ? "Saving..." : "Save List"}</button>
                    </form>
                  </div>
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-tertiary-container">contact_mail</span> Add Report Recipient</h2>
                    <form onSubmit={handleSaveEmailList} className="space-y-4">
                      <input value={newEmailName} onChange={(e) => setNewEmailName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Marketing Team" type="text" />
                      <textarea value={newEmailTargets} onChange={(e) => setNewEmailTargets(e.target.value)} className="w-full h-20 bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-inner resize-none placeholder:text-text-muted" placeholder="hello@gmail.com, team@..." />
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-tertiary-container/10 hover:border-tertiary-container/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all shadow-md disabled:opacity-50">{isSaving ? "Saving..." : "Save Contact"}</button>
                    </form>
                  </div>
                </motion.div>

                <motion.div variants={fadeUp} className="xl:col-span-2 space-y-8">
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">person</span> Saved Competitors</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {savedCompetitors.map((comp) => (
                        <div key={comp.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex items-center justify-between">
                          <div className="min-w-0"><h3 className="font-headline-lg text-text-main text-lg truncate uppercase">{comp.name}</h3><p className="font-mono text-xs text-text-muted mt-1 truncate">{comp.ads_id}</p></div>
                          <button onClick={() => handleDeleteCompetitor(comp.id)} className="text-urgent-red hover:bg-urgent-red/10 p-2 rounded-full border border-transparent hover:border-urgent-red/50"><span className="material-symbols-outlined text-[20px]">delete</span></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">view_list</span> Batch Lists</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {targetLists.map((list) => (
                        <div key={list.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex flex-col">
                          <div className="flex justify-between items-start mb-4"><h3 className="font-headline-lg text-text-main text-lg truncate pr-4">{list.name}</h3><button onClick={() => handleToggleList(list.id, list.is_active)} className={cn("w-12 h-6 rounded-full flex items-center px-1 transition-colors border", list.is_active ? "bg-emerald-metric border-emerald-metric" : "bg-surface-solid border-border-subtle")}><div className={cn("w-4 h-4 rounded-full bg-white shadow-sm transition-transform", list.is_active ? "translate-x-6" : "translate-x-0")}></div></button></div>
                          <div className="bg-input-bg border border-border-subtle rounded-xl p-3 h-20 overflow-y-auto font-mono text-[12px] text-text-muted mb-4 shadow-inner">{list.targets.map((t, i) => (<div key={i} className="flex items-center gap-2 mb-1"><span className="w-1 h-1 bg-border-subtle rounded-full"></span> {t}</div>))}</div>
                          <button onClick={() => handleDeleteList(list.id)} className="mt-auto text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-2 px-4 rounded-lg transition-colors border border-transparent hover:border-urgent-red/50 flex justify-center gap-2"><span className="material-symbols-outlined text-[16px]">delete</span> Delete List</button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">mail</span> Report Recipients</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {emailLists.map((list) => (
                        <div key={list.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex flex-col">
                          <h3 className="font-headline-lg text-text-main text-lg truncate mb-3">{list.name}</h3>
                          <div className="bg-input-bg border border-border-subtle rounded-xl p-3 h-16 overflow-y-auto font-mono text-[12px] text-text-muted mb-4">{JSON.parse(list.emails).map((e, i) => <div key={i} className="truncate">{e}</div>)}</div>
                          <button onClick={() => handleDeleteEmail(list.id)} className="mt-auto text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-2 px-4 rounded-lg transition-colors flex justify-center gap-2"><span className="material-symbols-outlined text-[16px]">delete</span> Delete Contact</button>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}

          {/* 4. SETTINGS TAB */}
          {activeTab === "settings" && (
            <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }} className="flex flex-col w-full gap-8 max-w-4xl">
              <div>
                <h1 className="font-headline-lg text-3xl text-text-main tracking-tight uppercase">System Settings</h1>
                <p className="font-body-md text-text-muted mt-1">Configure background cron daemons, Google Sheets integrations, and report templates.</p>
              </div>

              <form onSubmit={handleSaveSettings} className="space-y-6">
                <div className="bg-surface-glass border border-border-subtle rounded-2xl p-6 shadow-xl space-y-6">
                  <h3 className="font-headline-lg text-lg text-text-main uppercase flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary">smart_toy</span> Background Automations
                  </h3>
                  
                  <div className="flex items-center justify-between p-4 bg-surface-solid rounded-xl border border-border-subtle">
                    <div>
                      <h4 className="font-body-md font-bold text-text-main">3:00 AM Ghost Scans</h4>
                      <p className="font-body-xs text-text-muted mt-0.5">Silently scrapes all saved competitors daily to populate historical velocity charts.</p>
                    </div>
                    <button type="button" onClick={() => setSettings(s => ({ ...s, ghost_scan_enabled: s.ghost_scan_enabled === "1" ? "0" : "1" }))} className={cn("w-12 h-6 rounded-full flex items-center px-1 transition-colors border shadow-sm flex-shrink-0", settings.ghost_scan_enabled === "1" ? "bg-emerald-metric border-emerald-metric" : "bg-surface-glass border-border-subtle")}>
                      <div className={cn("w-4 h-4 rounded-full bg-white transition-transform", settings.ghost_scan_enabled === "1" ? "translate-x-5" : "translate-x-0")}></div>
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-4 bg-surface-solid rounded-xl border border-border-subtle">
                    <div>
                      <h4 className="font-body-md font-bold text-text-main">6:00 AM Automated PDF Dispatch</h4>
                      <p className="font-body-xs text-text-muted mt-0.5">Generates executive intelligence PDF report and emails it to the primary recipient.</p>
                    </div>
                    <button type="button" onClick={() => setSettings(s => ({ ...s, auto_report_enabled: s.auto_report_enabled === "1" ? "0" : "1" }))} className={cn("w-12 h-6 rounded-full flex items-center px-1 transition-colors border shadow-sm flex-shrink-0", settings.auto_report_enabled === "1" ? "bg-emerald-metric border-emerald-metric" : "bg-surface-glass border-border-subtle")}>
                      <div className={cn("w-4 h-4 rounded-full bg-white transition-transform", settings.auto_report_enabled === "1" ? "translate-x-5" : "translate-x-0")}></div>
                    </button>
                  </div>
                </div>

                <div className="bg-surface-glass border border-border-subtle rounded-2xl p-6 shadow-xl space-y-4">
                  <h3 className="font-headline-lg text-lg text-text-main uppercase flex items-center gap-2">
                    <span className="material-symbols-outlined text-electric-blue">cloud_sync</span> Cloud & Reporting Config
                  </h3>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Google Spreadsheet ID</label>
                    <input type="text" value={settings.google_sheet_id} onChange={(e) => setSettings(s => ({ ...s, google_sheet_id: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-sm" placeholder="e.g. 1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs" />
                  </div>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Default Report Email Recipient</label>
                    <input type="email" value={settings.default_report_email} onChange={(e) => setSettings(s => ({ ...s, default_report_email: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-sm" placeholder="manager@company.com" />
                  </div>
                </div>

                <div className="bg-surface-glass border border-border-subtle rounded-2xl p-6 shadow-xl space-y-4">
                  <h3 className="font-headline-lg text-lg text-text-main uppercase flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">description</span> PDF & Email Template
                  </h3>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Email Subject Header</label>
                    <input type="text" value={settings.report_subject_template} onChange={(e) => setSettings(s => ({ ...s, report_subject_template: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-sm" />
                  </div>

                  <div className="space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest block font-bold">Executive Opening Notes</label>
                    <textarea rows={3} value={settings.report_notes} onChange={(e) => setSettings(s => ({ ...s, report_notes: e.target.value }))} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-sm resize-none" />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button type="submit" disabled={isSavingSettings} className="bg-electric-blue hover:bg-primary-container text-white font-label-caps uppercase tracking-wider font-bold py-3.5 px-8 rounded-xl shadow-lg transition-all flex items-center gap-2 disabled:opacity-50">
                    <span className="material-symbols-outlined text-[20px]">{isSavingSettings ? 'sync' : 'save'}</span>
                    {isSavingSettings ? "Saving Settings..." : "Save Configuration"}
                  </button>
                  {settingsStatus && <span className={cn("font-mono text-sm font-bold", settingsStatus.includes("success") ? "text-emerald-metric" : "text-urgent-red")}>{settingsStatus}</span>}
                </div>
              </form>
            </motion.div>
          )}

        </main>
      </div>

      <AnimatePresence>
        {isDrawerOpen && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[55]" onClick={closeDrawer} />}
      </AnimatePresence>
      
      <div className={cn("fixed top-0 right-0 h-full w-full sm:w-[40%] min-w-[320px] max-w-[500px] bg-surface-solid border-l border-border-subtle shadow-2xl flex flex-col transition-transform duration-300 ease-in-out z-[60]", isDrawerOpen ? 'translate-x-0' : 'translate-x-full')}>
        {selectedGame && (
          <>
            <div className="p-8 pb-6 flex items-start justify-between relative bg-surface-glass border-b border-border-subtle">
              <div className="flex gap-6 items-start">
                <div className="w-20 h-20 rounded-2xl bg-input-bg border border-border-subtle shadow-lg flex items-center justify-center overflow-hidden flex-shrink-0">
                  {selectedGame.icon ? <img src={selectedGame.icon} alt="Icon" className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-[36px] text-primary/50">sports_esports</span>}
                </div>
                <div className="flex flex-col pt-1">
                  <h1 className="font-headline-lg text-text-main text-xl mb-1 leading-tight">{selectedGame.title}</h1>
                  <p className="font-body-sm text-text-muted mb-4">{selectedGame.publisher_name}</p>
                  <a href={`https://play.google.com/store/apps/details?id=${selectedGame.package_name}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 bg-electric-blue text-white font-label-caps text-xs uppercase px-4 py-2 rounded-full border border-brutal-black hover:bg-primary-container transition-colors w-max shadow-md">
                    Play Store <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  </a>
                </div>
              </div>
              <button onClick={closeDrawer} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-glass border border-transparent hover:border-border-subtle transition-colors text-text-muted"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-8 custom-scrollbar">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-wider mb-2">Star Rating</p><div className="flex items-center gap-2"><p className="font-headline-lg text-text-main">{selectedGame.rating > 0 ? selectedGame.rating.toFixed(1) : "N/A"}</p><span className="material-symbols-outlined text-tertiary-container text-[24px] mb-1" style={{fontVariationSettings: "'FILL' 1"}}>star</span></div></div>
                <div className="bg-surface-glass border border-border-subtle shadow-sm p-5 rounded-xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-wider mb-2">Review Count</p><p className="font-headline-lg text-text-main">{selectedGame.ratings_count || 0}</p></div>
              </div>
              {selectedGame.screenshots && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-3"><span className="w-8 h-[1px] bg-border-subtle"></span> Screenshots</h3>
                  <div className="flex overflow-x-auto gap-4 pb-4 snap-x snap-mandatory custom-scrollbar">
                    {JSON.parse(selectedGame.screenshots).slice(0, 4).map((url, i) => <div key={i} className="w-[140px] h-[280px] flex-shrink-0 bg-surface-glass rounded-xl overflow-hidden snap-center border border-border-subtle shadow-md"><img src={url} alt={`Screenshot ${i}`} className="w-full h-full object-cover" /></div>)}
                  </div>
                </div>
              )}
              {selectedGame.similar_apps && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between"><h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-2"><span className="material-symbols-outlined text-[16px] text-urgent-red">radar</span> Clone Radar (Market Copies)</h3><span className="font-mono text-[11px] text-text-muted">{JSON.parse(selectedGame.similar_apps || "[]").length} Detected</span></div>
                  <div className="space-y-2">
                    {JSON.parse(selectedGame.similar_apps || "[]").length === 0 ? <p className="font-body-sm text-text-muted italic">No direct copycats detected yet.</p> : JSON.parse(selectedGame.similar_apps).map((sim, i) => (
                      <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface-glass border border-border-subtle hover:border-border-subtle transition-all shadow-sm">
                        <div className="flex items-center gap-3 min-w-0"><div className="w-10 h-10 rounded-lg overflow-hidden bg-input-bg flex-shrink-0 border border-border-subtle">{sim.icon ? <img src={sim.icon} alt={sim.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50 text-[20px]">sports_esports</span>}</div><div className="min-w-0"><p className="font-body-sm font-semibold text-text-main truncate">{sim.title}</p><p className="font-body-xs text-text-muted truncate">{sim.developer}</p></div></div>
                        <a href={`https://play.google.com/store/apps/details?id=${sim.appId}`} target="_blank" rel="noreferrer" className="text-text-muted hover:text-electric-blue transition-colors ml-2 p-1.5 rounded-lg hover:bg-surface-solid border border-transparent hover:border-border-subtle" title="Open in Play Store"><span className="material-symbols-outlined text-[18px]">open_in_new</span></a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {isScanning && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, scale: 1 }} 
            exit={{ opacity: 0, y: 50, scale: 0.9 }} 
            className="fixed bottom-6 right-6 z-[100] w-96 bg-surface-solid/95 backdrop-blur-xl border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="p-4 flex items-center justify-between border-b border-border-subtle bg-surface-glass">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-electric-blue/10 border border-electric-blue/20 flex items-center justify-center text-electric-blue flex-shrink-0">
                  <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
                </div>
                <div className="min-w-0">
                  <h4 className="font-headline-lg text-sm font-bold text-text-main flex items-center gap-2 truncate">
                    Deep Scan Active <span className="w-1.5 h-1.5 bg-emerald-metric rounded-full animate-pulse flex-shrink-0"></span>
                  </h4>
                  <p className="font-mono text-[10px] text-electric-blue truncate">
                    {scanProgress.target} ({scanProgress.targetIndex}/{scanProgress.totalTargets})
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-text-muted flex-shrink-0">
                <button onClick={handleCancelScan} className="p-1 hover:bg-urgent-red/10 hover:text-urgent-red text-text-muted rounded-lg transition-colors" title="Abort Scan">
                  <span className="material-symbols-outlined text-[18px]">stop_circle</span>
                </button>
                <button onClick={() => setIsScanMinimized(!isScanMinimized)} className="p-1 hover:bg-input-bg hover:text-text-main rounded-lg transition-colors" title={isScanMinimized ? "Expand" : "Minimize"}>
                  <span className="material-symbols-outlined text-[18px]">{isScanMinimized ? 'open_in_full' : 'minimize'}</span>
                </button>
              </div>
            </div>

            <AnimatePresence>
              {!isScanMinimized && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex flex-col gap-3 p-4">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="font-body-sm text-text-muted">
                      Ads: <span className="font-mono font-bold text-text-main">{scanProgress.currentAd}</span> / {scanProgress.totalAds} <span className="text-border-subtle/50 ml-1">({scanPercentage}%)</span>
                    </span>
                    <div className="bg-emerald-metric/10 border border-emerald-metric/20 px-2 py-0.5 rounded-full font-mono font-bold text-emerald-metric flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-metric animate-ping"></span> {scanProgress.timeRemaining}
                    </div>
                  </div>

                  <div className="w-full h-2 bg-input-bg rounded-full overflow-hidden p-0.5 border border-border-subtle">
                    <div className="h-full bg-electric-blue rounded-full shadow-[0_0_10px_rgba(59,130,246,0.8)] transition-all duration-300" style={{ width: `${scanPercentage}%` }}></div>
                  </div>

                  <div className="bg-surface-glass border border-border-subtle rounded-xl px-3 py-2 font-mono text-[10px] text-text-muted flex items-center gap-2 shadow-inner">
                    <span className="material-symbols-outlined text-secondary text-[14px] flex-shrink-0">terminal</span>
                    <span className="truncate">{scanProgress.logs[scanProgress.logs.length - 1] || "Initializing..."}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;