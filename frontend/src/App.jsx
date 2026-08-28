import { useEffect, useState } from "react";

function App() {
  const [activeTab, setActiveTab] = useState("dashboard"); 
  
  // Dashboard States
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [trending, setTrending] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState("Never");
  const [scanQuery, setScanQuery] = useState("");
  const [scanLimit, setScanLimit] = useState(5);
  const [selectedSource, setSelectedSource] = useState("manual"); // Format: "manual", "list_1", "comp_2"

  // Drawer & Progress States
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
  const [scanProgress, setScanProgress] = useState({ target: "", currentAd: 0, totalAds: 0, timeRemaining: "Calculating...", logs: [] });

  // List & Competitor Management States
  const [targetLists, setTargetLists] = useState([]);
  const [savedCompetitors, setSavedCompetitors] = useState([]);
  
  const [newListName, setNewListName] = useState("");
  const [newListTargets, setNewListTargets] = useState("");
  const [newCompName, setNewCompName] = useState("");
  const [newCompAdsId, setNewCompAdsId] = useState("");

  const [sendReport, setSendReport] = useState(false);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("atlas_theme");
    if (saved) return saved === "dark";
    return true; 
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

  // Fetch Data Functions
  const loadStats = () => fetch("http://localhost:3000/api/stats").then(res => res.json()).then(setStats).catch(console.error);
  const loadCompetitors = () => fetch("http://localhost:3000/api/competitors").then(res => res.json()).then(setCompetitorTree).catch(console.error);
  const loadTrending = () => fetch("http://localhost:3000/api/trending").then(res => res.json()).then(setTrending).catch(console.error);
  const loadTargetLists = () => fetch("http://localhost:3000/api/lists").then(res => res.json()).then(setTargetLists).catch(console.error);
  const loadSavedCompetitors = () => fetch("http://localhost:3000/api/saved-competitors").then(res => res.json()).then(setSavedCompetitors).catch(console.error);

  useEffect(() => {
    loadStats(); loadCompetitors(); loadTrending(); loadTargetLists(); loadSavedCompetitors();
  }, []);

  // --- Management Functions ---
  const handleCreateList = async (e) => {
    e.preventDefault();
    if (!newListName || !newListTargets) return alert("Fill in both fields.");
    const parsedTargets = newListTargets.split(/[\n,]+/).map(t => t.trim()).filter(t => t);
    try {
      const res = await fetch("http://localhost:3000/api/lists", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newListName, targets: parsedTargets })
      });
      if (res.ok) { setNewListName(""); setNewListTargets(""); loadTargetLists(); }
    } catch (err) { console.error(err); }
  };

  const handleToggleList = async (id, currentStatus) => {
    try {
      await fetch(`http://localhost:3000/api/lists/${id}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 })
      });
      loadTargetLists();
    } catch (err) { console.error("Failed to toggle list", err); }
  };

  const handleSaveCompetitor = async (e) => {
    e.preventDefault();
    if (!newCompName || !newCompAdsId) return alert("Fill in both fields.");
    try {
      const res = await fetch("http://localhost:3000/api/competitors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCompName, adsId: newCompAdsId, country: "Any" })
      });
      if (res.ok) { setNewCompName(""); setNewCompAdsId(""); loadSavedCompetitors(); }
    } catch (err) { console.error(err); }
  };

  const handleDeleteList = async (id) => {
    if (!window.confirm("Delete this target list?")) return;
    try { await fetch(`http://localhost:3000/api/lists/${id}`, { method: "DELETE" }); loadTargetLists(); } 
    catch (err) { console.error(err); }
  };

  const handleDeleteCompetitor = async (id) => {
    if (!window.confirm("Delete this saved competitor and all their tracked games?")) return;
    try { await fetch(`http://localhost:3000/api/saved-competitors/${id}`, { method: "DELETE" }); loadSavedCompetitors(); loadStats(); loadCompetitors(); } 
    catch (err) { console.error(err); }
  };

  // Run Scan & Reset
  const handleRunScan = async () => {
    if (selectedSource === "manual" && !scanQuery) return alert("Please enter a competitor name or AR ID!");
    setIsScanning(true);
    
    setScanProgress({ target: "Initializing...", targetIndex: 1, totalTargets: 1, currentAd: 0, totalAds: scanLimit, timeRemaining: "Calculating...", logs: ["> Booting Intelligence Node..."] });

    let scanType = "manual";
    let targetId = null;
    if (selectedSource.startsWith("list_")) {
      scanType = "list";
      targetId = selectedSource.split("_")[1];
    } else if (selectedSource.startsWith("comp_")) {
      scanType = "competitor";
      targetId = selectedSource.split("_")[1];
    }

    const eventSource = new EventSource("http://localhost:3000/api/scan-stream");
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setScanProgress(prev => {
        const newLogs = [...prev.logs, data.log];
        if (newLogs.length > 5) newLogs.shift();
        return { 
          ...prev, 
          target: data.target || prev.target,
          targetIndex: data.targetIndex || prev.targetIndex,
          totalTargets: data.totalTargets || prev.totalTargets,
          currentAd: data.currentAd, 
          totalAds: data.totalAds || prev.totalAds, 
          timeRemaining: data.timeRemaining, 
          logs: newLogs 
        };
      });
    };

    try {
      const res = await fetch("http://localhost:3000/api/scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          searchQuery: scanQuery, 
          scanType: scanType, 
          targetId: targetId, 
          targetCountry: "Any", 
          limit: scanLimit,
          sendReport: sendReport
        })
      });
      const data = await res.json();
      if (data.status === "success") {
        setLastScanTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
        loadStats(); loadCompetitors(); loadTrending();
      }
    } catch (err) { console.error("Scan failed:", err); } finally { eventSource.close(); setIsScanning(false); }
  };

  const handleReset = async () => {
    if (!window.confirm("⚠️ WARNING: Are you sure you want to completely wipe the database?")) return;
    try {
      const res = await fetch("http://localhost:3000/api/reset", { method: "POST" });
      const data = await res.json();
      if (data.status === "success") { setLastScanTime("Never"); loadStats(); loadCompetitors(); setTrending([]); setSavedCompetitors([]); }
    } catch (err) { console.error("Reset failed:", err); }
  };

  const handleGameClick = (game) => { setSelectedGame(game); setIsDrawerOpen(true); };
  const closeDrawer = () => { setIsDrawerOpen(false); setTimeout(() => setSelectedGame(null), 300); };

  return (
    <div className="bg-bg-base font-body-md text-text-main min-h-screen relative transition-colors duration-400">
      
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
        {/* HEADER */}
        <header className="fixed top-0 md:left-64 lg:left-72 right-0 h-20 bg-bg-base/60 backdrop-blur-xl z-30 px-6 lg:px-8 flex items-center justify-between border-b border-border-subtle transition-colors duration-400">
          <div className="flex items-center gap-4">
            <div className="h-2 w-2 rounded-full bg-secondary animate-pulse"></div>
            <span className="font-label-caps text-[10px] lg:text-xs text-text-muted uppercase tracking-widest hidden sm:block">System Active: Ready to scan</span>
          </div>
          <div className="flex items-center gap-4 lg:gap-6">
            <button onClick={() => setIsDarkMode(!isDarkMode)} className="w-10 h-10 rounded-full flex items-center justify-center text-text-muted hover:text-text-main hover:bg-surface-glass transition-all shadow-sm border border-border-subtle">
              <span className="material-symbols-outlined text-[20px]">{isDarkMode ? "light_mode" : "dark_mode"}</span>
            </button>
            <button className="text-text-muted hover:text-text-main transition-colors flex items-center"><span className="material-symbols-outlined">search</span></button>
            <button className="text-text-muted hover:text-text-main transition-colors flex items-center relative"><span className="material-symbols-outlined">notifications</span><span className="absolute top-0 right-0 w-2 h-2 bg-urgent-red rounded-full ring-2 ring-bg-base"></span></button>
            <div className="w-8 h-8 rounded-full bg-electric-blue flex items-center justify-center shadow-[0_0_10px_rgba(59,130,246,0.5)]"><span className="material-symbols-outlined text-white text-[18px]">person</span></div>
          </div>
        </header>

        <main className="relative pt-24 min-h-screen px-4 sm:px-6 lg:px-8 py-8">
          
          {/* DASHBOARD TAB */}
          {activeTab === "dashboard" && (
            <div className="flex flex-col w-full gap-8 animate-in fade-in duration-300">
              <div className="w-full bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl relative overflow-hidden group border border-border-subtle">
                <div className="relative flex flex-wrap items-end gap-4 w-full z-10">
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Name / ID</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">radar</span>
                      <input 
                        value={selectedSource === "manual" ? scanQuery : "Auto-Target Selected"} 
                        onChange={(e) => setScanQuery(e.target.value)}
                        disabled={selectedSource !== "manual"}
                        className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-text-muted shadow-inner disabled:opacity-50 disabled:cursor-not-allowed" 
                        placeholder="e.g. Voodoo or ID: 12345" type="text"
                      />
                    </div>
                  </div>
                  <div className="w-full sm:w-64 space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Target Source</label>
                    <div className="relative">
                      <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">list_alt</span>
                      <select 
                        value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)}
                        className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 pl-10 pr-10 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner appearance-none cursor-pointer"
                      >
                        <option value="manual">Manual Entry</option>
                        <optgroup label="Saved Competitors">
                          {savedCompetitors.map(comp => (
                            <option key={`comp_${comp.id}`} value={`comp_${comp.id}`}>👤 {comp.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Target Lists">
                          {targetLists.map(list => (
                            <option key={`list_${list.id}`} value={`list_${list.id}`}>📂 {list.name} ({list.targets.length})</option>
                          ))}
                        </optgroup>
                      </select>
                      <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-[20px] pointer-events-none">expand_more</span>
                    </div>
                  </div>
                  <div className="w-full sm:w-28 space-y-2">
                    <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Ad Limit</label>
                    <input value={scanLimit} onChange={(e) => setScanLimit(Number(e.target.value))} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner text-center placeholder:text-text-muted" type="number" />
                  </div>
                  <div className="w-full sm:w-36 space-y-2">
                <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block">Email PDF</label>
  <button
    onClick={() => setSendReport(!sendReport)}
    className={`w-full py-3 px-4 rounded-xl flex items-center justify-center transition-all border font-body-md shadow-inner ${sendReport ? 'bg-electric-blue/10 border-electric-blue text-electric-blue' : 'bg-input-bg border-border-subtle text-text-muted hover:bg-surface-glass'}`}
  >
    <span className="material-symbols-outlined text-[20px] mr-2">{sendReport ? 'check_box' : 'check_box_outline_blank'}</span>
    {sendReport ? 'Yes' : 'No'}
  </button>
</div>
                  <div className="flex gap-4 items-center flex-shrink-0 w-full md:w-auto mt-2 md:mt-0">
                    <button onClick={handleRunScan} disabled={isScanning} className="flex-1 md:flex-none bg-electric-blue hover:bg-primary-container text-white font-body-md font-semibold py-3 px-6 rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                      <span className={`material-symbols-outlined text-[20px] ${isScanning ? "animate-spin" : ""}`}>data_usage</span> {isScanning ? "Scanning..." : "Run Scan"}
                    </button>
                    <button onClick={handleReset} disabled={isScanning} className="text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-3 px-4 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                      <span className="material-symbols-outlined text-[18px]">delete_sweep</span> Reset DB
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
                  <div className="flex items-baseline gap-2">
                    <span className="font-metric-xl text-text-main">{stats.competitors}</span>
                  </div>
                </div>

                <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-lg border border-border-subtle relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-tertiary-container/10 rounded-full blur-xl group-hover:bg-tertiary-container/20 transition-colors"></div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-surface-solid flex items-center justify-center text-tertiary-container shadow-[0_0_15px_rgba(223,116,18,0.15)]"><span className="material-symbols-outlined">account_box</span></div>
                    <span className="font-label-caps text-text-muted uppercase tracking-widest">Publishers</span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-metric-xl text-text-main">{stats.accounts}</span>
                  </div>
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
                  <div className="p-6 pb-4 bg-surface-solid border-b border-border-subtle rounded-t-2xl"><h2 className="font-headline-lg text-text-main text-xl">Trending Targets</h2></div>
                  <div className="flex-1 p-2 space-y-2 overflow-y-auto custom-scrollbar">
                    {trending.length === 0 ? <div className="text-center font-body-sm text-text-muted mt-10">No trending data. Run a scan!</div> : trending.map((game) => (
                      <div key={game.id} onClick={() => handleGameClick(game)} className="flex items-center p-4 rounded-xl hover:bg-surface-solid border border-transparent hover:border-border-subtle cursor-pointer transition-all group">
  <div className="w-12 h-12 rounded-xl overflow-hidden bg-input-bg border border-border-subtle shadow-md flex items-center justify-center flex-shrink-0 mr-4">
    {game.icon ? <img src={game.icon} alt={game.title} className="w-full h-full object-cover" /> : <span className="material-symbols-outlined text-primary/50">sports_esports</span>}
  </div>
  <div className="flex-1 min-w-0">
    <h3 className="font-body-md font-semibold text-text-main truncate group-hover:text-primary transition-colors">{game.title}</h3>
    <p className="font-body-sm text-text-muted truncate">{game.publisher_name}</p>
  </div>
  
  {/* THE NEW INSTALLS BADGE */}
  {game.installs && game.installs !== "0+" && (
    <div className="flex-shrink-0 ml-3 bg-emerald-metric/10 border border-emerald-metric/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5 shadow-inner">
      <span className="material-symbols-outlined text-[14px] text-emerald-metric">download</span>
      <span className="font-mono text-[11px] text-emerald-metric font-bold tracking-wider">{game.installs}</span>
    </div>
  )}
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
                  <p className="font-body-md text-text-muted mt-2">Manage individual saved competitors and automated batch lists.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
                
                {/* FORMS COLUMN */}
                <div className="xl:col-span-1 space-y-8">
                  {/* Save Competitor Form */}
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-secondary">person_add</span> Save Competitor</h2>
                    <form onSubmit={handleSaveCompetitor} className="space-y-4">
                      <div>
                        <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block mb-1">Company / Display Name</label>
                        <input value={newCompName} onChange={(e) => setNewCompName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-text-muted shadow-inner" placeholder="e.g. Playmax" type="text" />
                      </div>
                      <div>
                        <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block mb-1">Google Ads Advertiser ID</label>
                        <input value={newCompAdsId} onChange={(e) => setNewCompAdsId(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-text-muted shadow-inner" placeholder="AR123456789012345" type="text" />
                      </div>
                      <button type="submit" className="w-full bg-surface-solid border border-border-subtle hover:bg-secondary/10 hover:border-secondary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 mt-4">
                        <span className="material-symbols-outlined text-[20px] text-secondary">save</span> Save Competitor
                      </button>
                    </form>
                  </div>

                  {/* Create List Form */}
                  <div className="bg-surface-glass backdrop-blur-2xl rounded-2xl p-6 shadow-xl border border-border-subtle">
                    <h2 className="font-headline-lg text-text-main text-lg mb-4 flex items-center gap-2"><span className="material-symbols-outlined text-primary">format_list_bulleted_add</span> Create Batch List</h2>
                    <form onSubmit={handleCreateList} className="space-y-4">
                      <div>
                        <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block mb-1">List Name</label>
                        <input value={newListName} onChange={(e) => setNewListName(e.target.value)} className="w-full bg-input-bg text-text-main border border-border-subtle font-body-md rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-text-muted shadow-inner" placeholder="e.g. Tier 1 Tracking" type="text" />
                      </div>
                      <div>
                        <label className="font-label-caps text-xs text-text-muted uppercase tracking-widest pl-1 block mb-1">Targets (Comma or Line Separated)</label>
                        <textarea value={newListTargets} onChange={(e) => setNewListTargets(e.target.value)} className="w-full h-24 bg-input-bg text-text-main border border-border-subtle font-mono text-sm rounded-xl py-3 px-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner resize-none placeholder:text-text-muted" placeholder="Voodoo&#10;Playmax&#10;AR123456789012345" />
                      </div>
                      <button type="submit" className="w-full bg-surface-solid border border-border-subtle hover:bg-primary/10 hover:border-primary/30 text-text-main font-body-md font-semibold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 mt-4">
                        <span className="material-symbols-outlined text-[20px] text-primary">add_circle</span> Save List
                      </button>
                    </form>
                  </div>
                </div>

                {/* GRIDS COLUMN */}
                <div className="xl:col-span-2 space-y-8">
                  {/* Saved Competitors Grid */}
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">person</span> Saved Competitors
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {savedCompetitors.length === 0 ? (
                        <div className="md:col-span-2 text-center p-8 bg-surface-glass border border-border-subtle rounded-2xl"><p className="font-body-md text-text-muted">No individual competitors saved yet.</p></div>
                      ) : (
                        savedCompetitors.map((comp) => (
                          <div key={comp.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex items-center justify-between">
                            <div className="min-w-0">
                              <h3 className="font-headline-lg text-text-main text-lg truncate uppercase">{comp.name}</h3>
                              <p className="font-mono text-xs text-text-muted mt-1 truncate">{comp.ads_id}</p>
                            </div>
                            <button onClick={() => handleDeleteCompetitor(comp.id)} className="w-10 h-10 rounded-full flex items-center justify-center text-urgent-red hover:bg-urgent-red/10 transition-colors flex-shrink-0 ml-4">
                              <span className="material-symbols-outlined text-[20px]">delete</span>
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Target Lists Grid */}
                  <div>
                    <h2 className="font-label-caps text-text-muted uppercase tracking-widest mb-4 pl-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">view_list</span> Batch Lists
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {targetLists.length === 0 ? (
                        <div className="md:col-span-2 text-center p-8 bg-surface-glass border border-border-subtle rounded-2xl"><p className="font-body-md text-text-muted">No batch lists configured.</p></div>
                      ) : (
                        targetLists.map((list) => (
                          <div key={list.id} className="bg-surface-glass rounded-2xl p-5 shadow-lg border border-border-subtle flex flex-col">
                            <div className="flex justify-between items-start mb-4">
                              <h3 className="font-headline-lg text-text-main text-lg truncate pr-4">{list.name}</h3>
                              <button onClick={() => handleToggleList(list.id, list.is_active)} className={`w-12 h-6 rounded-full flex items-center px-1 transition-colors ${list.is_active ? "bg-emerald-metric" : "bg-surface-solid border border-border-subtle"}`}>
                                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${list.is_active ? "translate-x-6" : "translate-x-0"}`}></div>
                              </button>
                            </div>
                            <div className="bg-input-bg border border-border-subtle rounded-xl p-3 h-20 overflow-y-auto custom-scrollbar font-mono text-[12px] text-text-muted mb-4">
                              {list.targets.map((t, i) => (<div key={i} className="flex items-center gap-2 mb-1"><span className="w-1 h-1 bg-outline-variant rounded-full"></span> {t}</div>))}
                            </div>
                            <button onClick={() => handleDeleteList(list.id)} className="mt-auto text-urgent-red hover:bg-urgent-red/10 font-label-caps text-xs uppercase tracking-widest py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 self-start">
                              <span className="material-symbols-outlined text-[16px]">delete</span> Delete List
                            </button>
                          </div>
                        ))
                      )}
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
                  {scanProgress.totalTargets > 1 && (
                    <span className="font-label-caps text-xs text-text-muted uppercase tracking-widest mt-1">Competitor {scanProgress.targetIndex} of {scanProgress.totalTargets}</span>
                  )}
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