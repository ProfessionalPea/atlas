import { useEffect, useState } from "react";

// Smarter Age Calculator handles both Date strings and Unix Timestamps
function getAgeText(dateValue) {
  if (!dateValue || dateValue === "Unknown" || dateValue === 0) return null;
  
  // Check if it's a timestamp (number) or string
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
  
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false); 
  const [isMaxAds, setIsMaxAds] = useState(false); 
  
  // NEW: State to track which custom dropdown is currently open ('source', 'email', 'limit', or null)
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

  const sortedTrending = (Array.isArray(trending) ? [...trending] : []).sort((a, b) => {
    if (trendingSort === "ads") {
      return (b.ad_count || 1) - (a.ad_count || 1);
    }
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

  const loadStats = () => fetch("http://localhost:3000/api/stats").then(res => res.json()).then(data => setStats(data.error ? {competitors:0, accounts:0, games:0} : data)).catch(console.error);
  const loadCompetitors = () => fetch("http://localhost:3000/api/competitors").then(res => res.json()).then(data => setCompetitorTree(Array.isArray(data) ? data : [])).catch(console.error);
  const loadTrending = () => fetch("http://localhost:3000/api/trending").then(res => res.json()).then(data => setTrending(Array.isArray(data) ? data : [])).catch(console.error);
  const loadTargetLists = () => fetch("http://localhost:3000/api/lists").then(res => res.json()).then(data => setTargetLists(Array.isArray(data) ? data : [])).catch(console.error);
  const loadSavedCompetitors = () => fetch("http://localhost:3000/api/saved-competitors").then(res => res.json()).then(data => setSavedCompetitors(Array.isArray(data) ? data : [])).catch(console.error);
  const loadEmailLists = () => fetch("http://localhost:3000/api/emails").then(res => res.json()).then(data => setEmailLists(Array.isArray(data) ? data : [])).catch(console.error); 

  useEffect(() => {
    loadStats(); loadCompetitors(); loadTrending(); loadTargetLists(); loadSavedCompetitors(); loadEmailLists();
  }, []);

  const handleCreateList = async (e) => {
    e.preventDefault();
    if (!newListName || !newListTargets || isSaving) return;
    setIsSaving(true);
    const parsedTargets = newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t);
    try {
      const res = await fetch("http://localhost:3000/api/lists", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newListName, targets: parsedTargets })
      });
      if (res.ok) { setNewListName(""); setNewListTargets(""); loadTargetLists(); }
    } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleToggleList = async (id, currentStatus) => {
    try {
      await fetch(`http://localhost:3000/api/lists/${id}/toggle`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 })
      });
      loadTargetLists();
    } catch (err) { console.error(err); }
  };

  const handleSaveCompetitor = async (e) => {
    e.preventDefault();
    if (!newCompName || !newCompAdsId || isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch("http://localhost:3000/api/competitors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCompName, adsId: newCompAdsId, country: "Any" })
      });
      if (res.ok) { setNewCompName(""); setNewCompAdsId(""); loadSavedCompetitors(); }
    } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleSaveEmailList = async (e) => {
    e.preventDefault();
    if (!newEmailName || !newEmailTargets || isSaving) return;
    setIsSaving(true);
    const parsedEmails = newEmailTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t);
    try {
      const res = await fetch("http://localhost:3000/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newEmailName, emails: parsedEmails })
      });
      if (res.ok) { setNewEmailName(""); setNewEmailTargets(""); loadEmailLists(); }
    } catch (err) { console.error(err); } finally { setIsSaving(false); }
  };

  const handleDeleteList = async (id) => {
    if (!window.confirm("Delete this target list?")) return;
    try { 
      await fetch(`http://localhost:3000/api/lists/${id}`, { method: "DELETE" }); 
      loadTargetLists(); 
    } catch (err) { console.error("Failed to delete list:", err); }
  };

  const handleRunScan = async () => {
    if (selectedSource === "manual" && !scanQuery) return alert("Please enter a competitor name or AR ID!");
    setIsScanning(true);
    
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
        return { 
          ...prev, target: data.target || prev.target, targetIndex: data.targetIndex || prev.targetIndex, totalTargets: data.totalTargets || prev.totalTargets,
          currentAd: data.currentAd, totalAds: data.totalAds || prev.totalAds, timeRemaining: data.timeRemaining, logs: newLogs 
        };
      });
    };

    try {
      const res = await fetch("http://localhost:3000/api/scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          searchQuery: scanQuery, scanType, targetId, targetCountry: "Any", 
          limit: finalLimit,
          sendReport: selectedEmailList !== "none",
          emailListId: selectedEmailList
        })
      });
      const data = await res.json();
      if (data.status === "success") {
        setLastScanTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
        loadStats(); loadCompetitors(); loadTrending();
      }
    } catch (err) { console.error("Scan failed:", err); } finally { eventSource.close(); setIsScanning(false); }
  };

  const handleGameClick = (game) => { setSelectedGame(game); setIsDrawerOpen(true); };
  const closeDrawer = () => { setIsDrawerOpen(false); setTimeout(() => setSelectedGame(null), 300); };

  const handleDeleteCompetitor = async (id) => {
    if (!window.confirm("Delete this saved competitor?")) return;
    try { 
      await fetch(`http://localhost:3000/api/saved-competitors/${id}`, { method: "DELETE" }); 
      loadSavedCompetitors(); loadStats(); loadCompetitors(); 
    } catch (err) { console.error("Failed to delete competitor:", err); }
  };

  const handleDeleteEmail = async (id) => {
    if (!window.confirm("Delete this email target?")) return;
    try { 
      await fetch(`http://localhost:3000/api/emails/${id}`, { method: "DELETE" }); 
      loadEmailLists(); 
    } catch (err) { console.error("Failed to delete email:", err); }
  };

  const handleReset = async () => {
    if (!window.confirm("⚠️ WARNING: Are you sure you want to wipe the scan cache? (Saved lists will be kept)")) return;
    try {
      const res = await fetch("http://localhost:3000/api/reset", { method: "POST" });
      const data = await res.json();
      if (data.status === "success") { 
        setLastScanTime("Never"); 
        loadStats(); loadCompetitors(); loadTrending(); loadTargetLists(); loadSavedCompetitors(); loadEmailLists();
      }
    } catch (err) { console.error("Failed to reset database:", err); }
  };

  // Helper functions for modern dropdown display names
  const getTargetSourceName = () => {
    if (selectedSource === "manual") return "📝 Manual Entry";
    if (selectedSource.startsWith("comp_")) {
      const comp = savedCompetitors.find(c => `comp_${c.id}` === selectedSource);
      return comp ? `👤 ${comp.name}` : "Saved Competitor";
    }
    if (selectedSource.startsWith("list_")) {
      const list = targetLists.find(l => `list_${l.id}` === selectedSource);
      return list ? `📂 ${list.name}` : "Target List";
    }
    return "Select Source";
  };

  const getEmailListName = () => {
    if (selectedEmailList === "none") return "❌ Don't Send";
    const list = emailLists.find(e => e.id.toString() === selectedEmailList.toString());
    return list ? `✉️ ${list.name}` : "Don't Send";
  };

  return (
    <div className="bg-bg-base font-body-md text-text-main min-h-screen relative transition-colors duration-400">
      
      {/* INVISIBLE CLICK-OUTSIDE OVERLAY FOR CUSTOM DROPDOWNS */}
      {activeDropdown && (
        <div className="fixed inset-0 z-40 cursor-default" onClick={() => setActiveDropdown(null)}></div>
      )}

      {/* SIDEBAR */}
      <aside className="fixed left-0 top-0 h-full w-64 lg:w-72 bg-surface-solid z-40 hidden md:flex flex-col border-r border-border-subtle transition-colors duration-400">
        <div className="px-6 lg:px-8 py-8 flex items-center gap-3">
          <img src="/atlas-logo.png" alt="Atlas Logo" className="h-10 w-10 object-contain rounded-md shadow-[0_0_15px_rgba(59,130,246,0.3)]" />
          <span className="font-headline-lg text-2xl tracking-tight text-text-main">Atlas</span>
        </div>
        <nav className="flex-1 px-4 mt-4 space-y-2">
          <button onClick={() => setActiveTab("dashboard")} className={`w-full flex items-center px-4 py-3 rounded-xl transition-all group ${activeTab === "dashboard" ? "bg-primary-container text-on-primary-container font-bold" : "text-text-muted hover:bg-surface-glass hover:text-text-main"}`}>
            <span className="material-symbols-outlined mr-4 text-[22px]">dashboard</span><span className="font-body-md">Dashboard</span>
          </button>
          <button onClick={() => setActiveTab("automated")} className={`w-full flex items-center px-4 py-3 rounded-xl transition-all group ${activeTab === "automated" ? "bg-primary-container text-on-primary-container font-bold" : "text-text-muted hover:bg-surface-glass hover:text-text-main"}`}>
            <span className="material-symbols-outlined mr-4 text-[22px]">radar</span><span className="font-body-md">Automated Scans</span>
          </button>
        </nav>
      </aside>

      <div className="md:pl-64 lg:pl-72">
        <header className="fixed top-0 md:left-64 lg:left-72 right-0 h-20 bg-bg-base/60 backdrop-blur-xl z-30 px-6 lg:px-8 flex items-center justify-between border-b border-border-subtle transition-colors duration-400">
          <div className="flex items-center gap-4">
            <div className="h-2 w-2 rounded-full bg-secondary animate-pulse"></div>
            <span className="font-label-caps text-[10px] lg:text-xs text-text-muted uppercase tracking-widest hidden sm:block">System Active: Ready to scan</span>
          </div>
          <div className="flex items-center gap-4 lg:gap-6">
            <button onClick={() => setIsDarkMode(!isDarkMode)} className="w-10 h-10 rounded-full flex items-center justify-center text-text-muted hover:text-text-main hover:bg-surface-glass transition-all shadow-sm border border-border-subtle">
              <span className="material-symbols-outlined text-[20px]">{isDarkMode ? "light_mode" : "dark_mode"}</span>
            </button>
            {/* Removed the unused user profile icon */}
          </div>
        </header>

        <main className="relative pt-24 min-h-screen px-4 sm:px-6 lg:px-8 py-8">
          
          {/* DASHBOARD TAB */}
          {activeTab === "dashboard" && (
            <div className="flex flex-col w-full gap-8 animate-in fade-in duration-300">
              
              {/* Removed overflow-hidden here to allow custom dropdowns to break out of the card */}
              <div className="w-full bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl relative group border border-border-subtle z-20">
                <div className="relative flex flex-wrap items-end gap-4 w-full z-10">
                  
                  {/* Target Name Input */}
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Name / ID</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">radar</span>
                      <input 
                        value={selectedSource === "manual" ? scanQuery : "Auto-Target Selected"} 
                        onChange={(e) => setScanQuery(e.target.value)}
                        disabled={selectedSource !== "manual"}
                        className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-text-muted shadow-inner disabled:opacity-50" 
                        placeholder="e.g. Voodoo or ID: 12345" type="text"
                      />
                    </div>
                  </div>

                  {/* MODERN CUSTOM DROPDOWN: Target Source */}
                  <div className="w-full sm:w-56 space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Source</label>
                    <div className="relative z-50">
                      <div 
                        onClick={() => setActiveDropdown(activeDropdown === 'source' ? null : 'source')}
                        className={`w-full bg-input-bg text-text-main border font-body-md rounded-xl py-3 pl-10 pr-4 outline-none transition-all shadow-inner cursor-pointer flex items-center justify-between select-none ${activeDropdown === 'source' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50'}`}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px]">list_alt</span>
                        <span className="truncate font-semibold text-sm">{getTargetSourceName()}</span>
                        <span className="material-symbols-outlined text-text-muted text-[20px] transition-transform" style={{ transform: activeDropdown === 'source' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                      </div>
                      
                      {activeDropdown === 'source' && (
                        <div className="absolute top-full left-0 w-full mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl max-h-64 overflow-y-auto z-50 p-2 animate-in slide-in-from-top-2">
                          <div onClick={() => { setSelectedSource("manual"); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm font-semibold transition-colors">📝 Manual Entry</div>
                          
                          {savedCompetitors.length > 0 && (
                            <>
                              <div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Competitors</div>
                              {savedCompetitors.map(c => (
                                <div key={`comp_${c.id}`} onClick={() => { setSelectedSource(`comp_${c.id}`); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">👤 {c.name}</div>
                              ))}
                            </>
                          )}
                          
                          {targetLists.length > 0 && (
                            <>
                              <div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Target Lists</div>
                              {targetLists.map(l => (
                                <div key={`list_${l.id}`} onClick={() => { setSelectedSource(`list_${l.id}`); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">📂 {l.name}</div>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* MODERN CUSTOM DROPDOWN: Email Report */}
                  <div className="w-full sm:w-56 space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Email Report To</label>
                    <div className="relative z-50">
                      <div 
                        onClick={() => setActiveDropdown(activeDropdown === 'email' ? null : 'email')}
                        className={`w-full bg-input-bg text-text-main border font-body-md rounded-xl py-3 pl-10 pr-4 outline-none transition-all shadow-inner cursor-pointer flex items-center justify-between select-none ${activeDropdown === 'email' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50'}`}
                      >
                        <span className="material-symbols-outlined absolute left-3 text-text-muted text-[20px]">mail</span>
                        <span className="truncate font-semibold text-sm">{getEmailListName()}</span>
                        <span className="material-symbols-outlined text-text-muted text-[20px] transition-transform" style={{ transform: activeDropdown === 'email' ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                      </div>
                      
                      {activeDropdown === 'email' && (
                        <div className="absolute top-full left-0 w-full mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl max-h-64 overflow-y-auto z-50 p-2 animate-in slide-in-from-top-2">
                          <div onClick={() => { setSelectedEmailList("none"); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-urgent-red/10 text-urgent-red cursor-pointer text-sm font-semibold transition-colors">❌ Don't Send</div>
                          
                          {emailLists.length > 0 && (
                            <>
                              <div className="px-3 py-1.5 mt-2 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-subtle mb-1">Saved Contacts</div>
                              {emailLists.map(e => (
                                <div key={e.id} onClick={() => { setSelectedEmailList(e.id); setActiveDropdown(null); }} className="px-3 py-2.5 rounded-lg hover:bg-surface-glass cursor-pointer text-sm transition-colors truncate">✉️ {e.name}</div>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* MODERN GOOGLE DOCS STYLE AD LIMIT INPUT */}
                  <div className="w-full sm:w-40 space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Ad Limit</label>
                    <div className="relative z-50">
                      <div className={`flex items-center bg-input-bg border rounded-xl shadow-inner transition-all h-[50px] ${isMaxAds ? 'border-urgent-red/50 opacity-50 cursor-not-allowed' : activeDropdown === 'limit' ? 'border-electric-blue ring-2 ring-electric-blue/20' : 'border-border-subtle hover:border-electric-blue/50'}`}>
                        
                        <button disabled={isMaxAds} onClick={() => setScanLimit(Math.max(1, scanLimit - 10))} className="h-full px-3 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-l-xl transition-colors disabled:opacity-50">
                          <span className="material-symbols-outlined text-[16px]">remove</span>
                        </button>
                        
                        <input 
                          disabled={isMaxAds}
                          value={isMaxAds ? "ALL" : scanLimit} 
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            setScanLimit(val === '' ? '' : Number(val));
                          }}
                          onBlur={() => { if (!scanLimit || scanLimit < 1) setScanLimit(1); }}
                          className="w-full h-full bg-transparent text-text-main text-center font-mono font-bold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed" 
                          type="text" 
                        />
                        
                        <button disabled={isMaxAds} onClick={() => setScanLimit((scanLimit || 0) + 10)} className="h-full px-3 text-text-muted hover:text-text-main hover:bg-surface-glass transition-colors disabled:opacity-50">
                          <span className="material-symbols-outlined text-[16px]">add</span>
                        </button>

                        <div className="w-px h-6 bg-border-subtle"></div>

                        <button disabled={isMaxAds} onClick={() => !isMaxAds && setActiveDropdown(activeDropdown === 'limit' ? null : 'limit')} className="h-full px-2 text-text-muted hover:text-text-main hover:bg-surface-glass rounded-r-xl transition-colors disabled:opacity-50 flex items-center justify-center">
                          <span className="material-symbols-outlined text-[18px]">arrow_drop_down</span>
                        </button>
                      </div>

                      {/* Presets Menu */}
                      {activeDropdown === 'limit' && !isMaxAds && (
                        <div className="absolute top-full right-0 w-28 mt-2 bg-surface-solid border border-border-subtle rounded-xl shadow-2xl overflow-hidden z-50 p-2 animate-in slide-in-from-top-2">
                          {[10, 20, 50, 100, 250, 500].map(val => (
                            <div 
                              key={val} 
                              onClick={() => { setScanLimit(val); setActiveDropdown(null); }} 
                              className="px-3 py-2 rounded-lg hover:bg-surface-glass cursor-pointer text-sm font-mono text-center transition-colors"
                            >
                              {val}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ACTION BUTTONS (MASSIVE MAX BUTTON) */}
                  <div className="flex gap-3 items-center flex-shrink-0 w-full md:w-auto mt-4 md:mt-0">
                    <button 
                      onClick={() => setIsMaxAds(!isMaxAds)} 
                      className={`h-[50px] px-6 rounded-xl font-bold tracking-widest text-sm uppercase transition-all flex items-center justify-center gap-2 border ${
                        isMaxAds 
                          ? 'bg-urgent-red border-urgent-red text-white shadow-[0_0_15px_rgba(239,68,68,0.5)]' 
                          : 'bg-surface-solid border-border-subtle text-text-muted hover:bg-surface-glass hover:text-text-main'
                      }`}
                      title="Scan every single ad. No limits."
                    >
                      <span className="material-symbols-outlined text-[18px]">{isMaxAds ? 'all_inclusive' : 'select_all'}</span>
                      MAX
                    </button>

                    <button onClick={handleRunScan} disabled={isScanning} className="h-[50px] flex-1 md:flex-none bg-electric-blue hover:bg-primary-container text-white font-body-md font-semibold px-6 rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                      <span className={`material-symbols-outlined text-[20px] ${isScanning ? "animate-spin" : ""}`}>data_usage</span> {isScanning ? "Scanning..." : "Run Scan"}
                    </button>
                    
                    <button onClick={handleReset} disabled={isScanning} className="h-[50px] text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest px-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                      <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
                    </button>
                  </div>

                </div>
              </div>

              {/* STATS GRID */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
                <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/10 rounded-full blur-xl group-hover:bg-primary/20 transition-colors"></div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center text-primary shadow-[0_0_15px_rgba(173,198,255,0.15)]"><span className="material-symbols-outlined">schedule</span></div>
                    <span className="font-label-caps text-text-muted uppercase tracking-widest">Last Scan</span>
                  </div>
                  <div className="font-metric-xl text-text-main">{lastScanTime}</div>
                </div>
                <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-secondary/10 rounded-full blur-xl group-hover:bg-secondary/20 transition-colors"></div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center text-secondary shadow-[0_0_15px_rgba(78,222,163,0.15)]"><span className="material-symbols-outlined">corporate_fare</span></div>
                    <span className="font-label-caps text-text-muted uppercase tracking-widest">Competitors</span>
                  </div>
                  <div className="flex items-baseline gap-2"><span className="font-metric-xl text-text-main">{stats.competitors}</span></div>
                </div>
                <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-tertiary-container/10 rounded-full blur-xl group-hover:bg-tertiary-container/20 transition-colors"></div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center text-tertiary-container shadow-[0_0_15px_rgba(223,116,18,0.15)]"><span className="material-symbols-outlined">account_box</span></div>
                    <span className="font-label-caps text-text-muted uppercase tracking-widest">Publishers</span>
                  </div>
                  <div className="flex items-baseline gap-2"><span className="font-metric-xl text-text-main">{stats.accounts}</span></div>
                </div>
                <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-electric-blue/10 rounded-full blur-xl group-hover:bg-electric-blue/20 transition-colors"></div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center text-electric-blue shadow-[0_0_15px_rgba(59,130,246,0.15)]"><span className="material-symbols-outlined">sports_esports</span></div>
                    <span className="font-label-caps text-text-muted uppercase tracking-widest">Games</span>
                  </div>
                  <div className="font-metric-xl text-text-main">{stats.games}</div>
                </div>
              </div>

              {/* LOWER SECTION */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mt-4">
                <div className="xl:col-span-7 bg-surface-glass border border-border-subtle rounded-2xl shadow-xl flex flex-col h-[600px]">
                  
                  <div className="p-6 pb-4 bg-surface-solid border-b border-border-subtle rounded-t-2xl flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h2 className="font-headline-lg text-text-main text-xl">Trending Radar</h2>
                      <p className="font-body-xs text-text-muted">
                        {trendingSort === "installs" ? "Ranked by total install volume" : trendingSort === "newest" ? "Ranked by newest game release" : "Ranked by ad push volume"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 bg-input-bg p-1 rounded-xl border border-border-subtle">
                      <button
                        onClick={() => setTrendingSort("ads")}
                        className={`px-3 py-1.5 text-xs font-label-caps uppercase rounded-lg transition-all flex items-center gap-1.5 ${
                          trendingSort === "ads" ? "bg-electric-blue text-white shadow-sm font-semibold" : "text-text-muted hover:text-text-main"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">local_fire_department</span> Ad Push
                      </button>
                      <button
                        onClick={() => setTrendingSort("installs")}
                        className={`px-3 py-1.5 text-xs font-label-caps uppercase rounded-lg transition-all flex items-center gap-1.5 ${
                          trendingSort === "installs" ? "bg-electric-blue text-white shadow-sm font-semibold" : "text-text-muted hover:text-text-main"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">download</span> Installs
                      </button>
                      <button
                        onClick={() => setTrendingSort("newest")}
                        className={`px-3 py-1.5 text-xs font-label-caps uppercase rounded-lg transition-all flex items-center gap-1.5 ${
                          trendingSort === "newest" ? "bg-electric-blue text-white shadow-sm font-semibold" : "text-text-muted hover:text-text-main"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">schedule</span> Newest
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex-1 p-2 space-y-2 overflow-y-auto custom-scrollbar">
                    {sortedTrending.length === 0 ? <div className="text-center font-body-sm text-text-muted mt-10">No trending data. Run a scan!</div> : sortedTrending.map((game) => (
                      <div key={game.id} onClick={() => handleGameClick(game)} className="flex items-center p-4 rounded-xl hover:bg-surface-solid border border-transparent hover:border-border-subtle cursor-pointer transition-all group">
                        <div className="w-12 h-12 rounded-xl overflow-hidden bg-input-bg border border-border-subtle shadow-md flex items-center justify-center flex-shrink-0 mr-4">
                          {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50">sports_esports</span>}
                        </div>
                        <div className="flex-1 min-w-0"><h3 className="font-body-md font-semibold text-text-main truncate group-hover:text-primary transition-colors">{game.title}</h3><p className="font-body-sm text-text-muted truncate">{game.publisher_name}</p></div>
                        
                        {game.installs && game.installs !== "0+" && (
                          <div className="flex-shrink-0 ml-3 bg-emerald-metric/10 border border-emerald-metric/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 shadow-inner">
                            <span className="material-symbols-outlined text-[14px] text-emerald-metric">download</span><span className="font-mono text-[11px] text-emerald-metric font-bold tracking-wider">{game.installs}</span>
                          </div>
                        )}
                        
                        {/* AD PUSH BADGE */}
                        {game.ad_count >= 1 && (
                          <div className="flex-shrink-0 ml-2 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner" title="Active Creatives Intercepted">
                            <span className="material-symbols-outlined text-[14px] text-amber-500">local_fire_department</span>
                            <span className="font-mono text-[11px] text-amber-500 font-bold">{game.ad_count} Ads</span>
                          </div>
                        )}
                        
                        {/* DUAL TIMELINE BADGES */}
                        <div className="flex gap-2 ml-2 flex-shrink-0">
                          {/* Release Age (Primary) */}
                          {game.released && game.released !== "Unknown" && (
                            <div className="bg-primary/10 border border-primary/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner" title={`Released: ${game.released}`}>
                              <span className="material-symbols-outlined text-[14px] text-primary">cake</span>
                              <span className="font-mono text-[11px] text-primary font-bold">{getAgeText(game.released)}</span>
                            </div>
                          )}
                          
                          {/* Last Updated (Secondary / Fallback) */}
                          {game.updated && game.updated !== 0 && (
                            <div className="bg-tertiary-container/10 border border-tertiary-container/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-inner" title="Last Updated">
                              <span className="material-symbols-outlined text-[14px] text-tertiary-container">update</span>
                              <span className="font-mono text-[11px] text-tertiary-container font-bold">{getAgeText(game.updated)} ago</span>
                            </div>
                          )}
                        </div>

                      </div>
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
                              <div key={game.id} onClick={() => handleGameClick(game)} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-solid cursor-pointer"><span className="material-symbols-outlined text-text-muted">smartphone</span><p className="font-body-sm font-semibold truncate text-text-main">{game.title}</p></div>
                            ))}</div>
                          </div>
                        ))}
                      </div></div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AUTOMATED SCANS TAB */}
          {activeTab === "automated" && (
            <div className="flex flex-col w-full gap-8 animate-in fade-in duration-300">
              <div className="flex justify-between items-end mb-2">
                <div>
                  <h1 className="font-headline-lg text-3xl text-text-main tracking-tight">Database Targets</h1>
                  <p className="font-body-md text-text-muted mt-2">Manage saved competitors, batch lists, and email reporting targets.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
                
                {/* FORMS COLUMN */}
                <div className="xl:col-span-1 space-y-8">
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-secondary">person_add</span> Save Competitor</h2>
                    <form onSubmit={handleSaveCompetitor} className="space-y-4">
                      <div>
                        <input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Playmax" type="text" />
                      </div>
                      <div>
                        <input value={newCompAdsId} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="AR123456789012345" type="text" />
                      </div>
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-secondary/10 hover:border-secondary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                        {isSaving ? "Saving..." : "Save"}
                      </button>
                    </form>
                  </div>

                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-primary">format_list_bulleted_add</span> Create Batch List</h2>
                    <form onSubmit={handleCreateList} className="space-y-4">
                      <div>
                        <input value={newListName} onChange={(e) => setNewListName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Tier 1 Tracking" type="text" />
                      </div>
                      <div>
                        <textarea value={newListTargets} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-inner resize-none placeholder:text-text-muted" placeholder="AR123..." />
                      </div>
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-primary/10 hover:border-primary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                        {isSaving ? "Saving..." : "Save List"}
                      </button>
                    </form>
                  </div>

                  {/* EMAIL LIST FORM */}
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-tertiary-container">contact_mail</span> Add Report Recipient</h2>
                    <form onSubmit={handleSaveEmailList} className="space-y-4">
                      <div>
                        <input value={newEmailName} onChange={(e) => setNewEmailName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 placeholder:text-text-muted shadow-inner" placeholder="e.g. Marketing Team" type="text" />
                      </div>
                      <div>
                        <textarea value={newEmailTargets} onChange={(e) => setNewEmailTargets(e.target.value)} className="w-full h-20 bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 shadow-inner resize-none placeholder:text-text-muted" placeholder="hello@gmail.com, team@..." />
                      </div>
                      <button type="submit" disabled={isSaving} className="w-full bg-surface-solid border border-border-subtle hover:bg-tertiary-container/10 hover:border-tertiary-container/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                        {isSaving ? "Saving..." : "Save Contact"}
                      </button>
                    </form>
                  </div>
                </div>

                {/* GRIDS COLUMN */}
                <div className="xl:col-span-2 space-y-8">
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">person</span> Saved Competitors
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {savedCompetitors.map((comp) => (
                        <div key={comp.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex items-center justify-between">
                          <div className="min-w-0"><h3 className="font-headline-lg text-text-main text-lg truncate uppercase">{comp.name}</h3><p className="font-mono text-xs text-text-muted mt-1 truncate">{comp.ads_id}</p></div>
                          <button onClick={() => handleDeleteCompetitor(comp.id)} className="text-urgent-red hover:bg-urgent-red/10 p-2 rounded-full"><span className="material-symbols-outlined text-[20px]">delete</span></button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">view_list</span> Batch Lists
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {targetLists.map((list) => (
                        <div key={list.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex flex-col">
                          <div className="flex justify-between items-start mb-4"><h3 className="font-headline-lg text-text-main text-lg truncate pr-4">{list.name}</h3><button onClick={() => handleToggleList(list.id, list.is_active)} className={`w-12 h-6 rounded-full flex items-center px-1 transition-colors ${list.is_active ? "bg-emerald-metric" : "bg-surface-solid border border-border-subtle"}`}><div className={`w-4 h-4 rounded-full bg-white transition-transform ${list.is_active ? "translate-x-6" : "translate-x-0"}`}></div></button></div>
                          <div className="bg-input-bg border border-border-subtle rounded-xl p-3 h-20 overflow-y-auto font-mono text-[12px] text-text-muted mb-4">{list.targets.map((t, i) => (<div key={i} className="flex items-center gap-2 mb-1"><span className="w-1 h-1 bg-outline-variant rounded-full"></span> {t}</div>))}</div>
                          <button onClick={() => handleDeleteList(list.id)} className="mt-auto text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-2 px-4 rounded-lg transition-colors flex justify-center gap-2"><span className="material-symbols-outlined text-[16px]">delete</span> Delete List</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* EMAIL CONTACTS GRID */}
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">mail</span> Report Recipients
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {emailLists.map((list) => (
                        <div key={list.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex flex-col">
                          <h3 className="font-headline-lg text-text-main text-lg truncate mb-3">{list.name}</h3>
                          <div className="bg-input-bg border border-border-subtle rounded-xl p-3 h-16 overflow-y-auto font-mono text-[12px] text-text-muted mb-4">
                            {JSON.parse(list.emails).map((e, i) => <div key={i} className="truncate">{e}</div>)}
                          </div>
                          <button onClick={() => handleDeleteEmail(list.id)} className="mt-auto text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-2 px-4 rounded-lg transition-colors flex justify-center gap-2"><span className="material-symbols-outlined text-[16px]">delete</span> Delete Contact</button>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* OVERLAYS & MODALS */}
      {isDrawerOpen && <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[55]" onClick={closeDrawer}></div>}
      <div className={`fixed top-0 right-0 h-full w-full sm:w-[40%] min-w-[320px] max-w-[500px] bg-surface-solid border-l border-border-subtle shadow-2xl flex flex-col transition-transform duration-300 ease-in-out z-[60] ${isDrawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
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
                  <a href={`https://play.google.com/store/apps/details?id=${selectedGame.package_name}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 bg-electric-blue text-white font-label-caps text-xs uppercase px-4 py-2 rounded-full hover:bg-primary-container transition-colors w-max shadow-md shadow-electric-blue/20">
                    Play Store <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  </a>
                </div>
              </div>
              <button onClick={closeDrawer} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-glass transition-colors text-text-muted"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 flex flex-col gap-8 custom-scrollbar">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-glass border border-border-subtle p-5 rounded-xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-wider mb-2">Star Rating</p><div className="flex items-center gap-2"><p className="font-headline-lg text-text-main">{selectedGame.rating > 0 ? selectedGame.rating.toFixed(1) : "N/A"}</p><span className="material-symbols-outlined text-tertiary-container text-[24px] mb-1" style={{fontVariationSettings: "'FILL' 1"}}>star</span></div></div>
                <div className="bg-surface-glass border border-border-subtle p-5 rounded-xl"><p className="font-label-caps text-xs text-text-muted uppercase tracking-wider mb-2">Review Count</p><p className="font-headline-lg text-text-main">{selectedGame.ratings_count || 0}</p></div>
              </div>
              {selectedGame.screenshots && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-3"><span className="w-8 h-[1px] bg-border-subtle"></span> Screenshots</h3>
                  <div className="flex overflow-x-auto gap-4 pb-4 snap-x snap-mandatory custom-scrollbar">
                    {JSON.parse(selectedGame.screenshots).slice(0, 4).map((url, i) => <div key={i} className="w-[140px] h-[280px] flex-shrink-0 bg-surface-glass rounded-xl overflow-hidden snap-center border border-border-subtle shadow-lg"><img src={url} alt={`Screenshot ${i}`} className="w-full h-full object-cover" /></div>)}
                  </div>
                </div>
              )}
              {/* CLONE RADAR / SIMILAR APPS */}
              {selectedGame.similar_apps && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-label-caps text-xs text-text-muted uppercase tracking-widest flex items-center gap-2">
                      <span className="material-symbols-outlined text-[16px] text-urgent-red">radar</span> Clone Radar (Market Copies)
                    </h3>
                    <span className="font-mono text-[11px] text-text-muted">
                      {JSON.parse(selectedGame.similar_apps || "[]").length} Detected
                    </span>
                  </div>

                  <div className="space-y-2">
                    {JSON.parse(selectedGame.similar_apps || "[]").length === 0 ? (
                      <p className="font-body-sm text-text-muted italic">No direct copycats detected yet.</p>
                    ) : (
                      JSON.parse(selectedGame.similar_apps).map((sim, i) => (
                        <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface-glass border border-border-subtle hover:border-border-strong transition-all">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-lg overflow-hidden bg-input-bg flex-shrink-0 border border-border-subtle">
                              {sim.icon ? (
                                <img src={sim.icon} alt={sim.title} className="w-full h-full object-cover" />
                              ) : (
                                <span className="material-symbols-outlined text-primary/50 text-[20px]">sports_esports</span>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="font-body-sm font-semibold text-text-main truncate">{sim.title}</p>
                              <p className="font-body-xs text-text-muted truncate">{sim.developer}</p>
                            </div>
                          </div>

                          <a
                            href={`https://play.google.com/store/apps/details?id=${sim.appId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-text-muted hover:text-electric-blue transition-colors ml-2 p-1.5 rounded-lg hover:bg-surface-solid"
                            title="Open in Play Store"
                          >
                            <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                          </a>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {isScanning && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-surface-solid border border-border-subtle rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col overflow-hidden">
            <div className="p-6 border-b border-border-subtle flex items-center gap-4 bg-surface-glass">
              <span className="material-symbols-outlined text-electric-blue animate-spin text-[28px]">radar</span>
              <div><h2 className="font-headline-lg text-text-main text-xl">System Active: Deep Scan in Progress</h2><p className="font-body-sm text-text-muted mt-1">Extracting Google Ads Transparency Data</p></div>
            </div>
            <div className="p-8 flex flex-col gap-6">
              <div className="flex justify-between items-end">
                <span className="font-label-caps text-xs text-text-muted uppercase tracking-widest">Current Target</span>
                <div className="flex flex-col items-end">
                  <span className="font-mono text-electric-blue text-lg font-bold uppercase">{scanProgress.target}</span>
                  {scanProgress.totalTargets > 1 && <span className="font-label-caps text-xs text-text-muted uppercase tracking-widest mt-1">Competitor {scanProgress.targetIndex} of {scanProgress.totalTargets}</span>}
                </div>
              </div>
              <div className="w-full">
                <div className="h-4 w-full bg-input-bg rounded-full overflow-hidden shadow-inner border border-border-subtle relative">
                  <div className="h-full bg-electric-blue transition-all duration-300 relative" style={{ width: `${Math.min(100, (scanProgress.currentAd / scanProgress.totalAds) * 100)}%` }}><div className="absolute inset-0 bg-white/20 animate-pulse"></div></div>
                </div>
                <div className="flex justify-between items-center mt-3"><span className="font-mono text-sm text-text-muted">Ads Intercepted: <span className="text-text-main font-bold">{scanProgress.currentAd}</span> / {scanProgress.totalAds}</span><span className="font-label-caps text-xs text-text-muted uppercase tracking-widest bg-surface-glass border border-border-subtle px-3 py-1 rounded-full">Est. Time: <span className="text-emerald-metric">{scanProgress.timeRemaining}</span></span></div>
              </div>
              <div className="bg-[#0a0a0a] rounded-xl p-4 mt-2 border border-border-subtle h-32 overflow-y-auto flex flex-col justify-end font-mono text-[12px] text-text-muted gap-1">
                {scanProgress.logs.map((log, i) => <div key={i} className={i === scanProgress.logs.length - 1 ? "text-emerald-metric font-bold" : ""}>{log}</div>)}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;