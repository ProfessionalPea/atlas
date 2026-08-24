import React, { useEffect, useState } from "react";

function App() {
  const [stats, setStats] = useState({ competitors: 0, accounts: 0, games: 0 });
  const [competitorTree, setCompetitorTree] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState("Never");

  const [scanQuery, setScanQuery] = useState("");
  const [targetCountry, setTargetCountry] = useState("Any Region (Global)");
  const [scanLimit, setScanLimit] = useState(500);

  const loadStats = () => {
    fetch("http://localhost:3000/api/stats")
      .then((res) => res.json())
      .then((data) => setStats(data))
      .catch((err) => console.error("Failed to load stats:", err));
  };

  const loadCompetitors = () => {
    fetch("http://localhost:3000/api/competitors")
      .then((res) => res.json())
      .then((data) => setCompetitorTree(data))
      .catch((err) => console.error("Failed to load competitors:", err));
  };

  useEffect(() => {
    loadStats();
    loadCompetitors();
  }, []);

  const handleRunScan = async () => {
    if (!scanQuery) return alert("Please enter a competitor name or AR ID!");
    setIsScanning(true);
    try {
      const res = await fetch("http://localhost:3000/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchQuery: scanQuery,
          targetCountry: targetCountry.includes("Any") ? "Any" : targetCountry,
          limit: scanLimit
        }),
      });
      const data = await res.json();
      if (data.status === "success") {
        setLastScanTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
        loadStats();
        loadCompetitors();
      }
    } catch (err) {
      console.error("Scan failed:", err);
    } finally {
      setIsScanning(false);
    }
  };

  const handleReset = async () => {
    const confirmWipe = window.confirm("⚠️ WARNING: Are you sure you want to completely wipe the database?");
    if (!confirmWipe) return;
    try {
      const res = await fetch("http://localhost:3000/api/reset", { method: "POST" });
      const data = await res.json();
      if (data.status === "success") {
        alert("Database has been reset!");
        setLastScanTime("Never");
        loadStats();
        loadCompetitors();
      }
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  return (
    <div className="bg-bg-slate-950 font-body-md text-on-surface min-h-screen">
      
      {/* SIDEBAR */}
      <aside className="fixed left-0 top-0 h-full w-64 lg:w-72 bg-surface-container-lowest z-50 hidden md:flex flex-col border-r border-border-subtle">
        <div className="px-6 lg:px-margin-desktop py-8 flex items-center gap-3">
          <div className="h-8 w-8 bg-electric-blue rounded-md flex items-center justify-center font-bold text-white">A</div>
          <span className="font-headline-lg text-headline-lg-mobile tracking-tight text-on-surface">Atlas</span>
        </div>
        <nav className="flex-1 px-4 mt-4 space-y-2">
          <a className="flex items-center px-4 py-3 rounded-xl transition-all group bg-primary-container text-on-primary-container font-bold" href="#">
            <span className="material-symbols-outlined mr-4 text-[22px]">dashboard</span>
            <span className="font-body-md">Dashboard</span>
          </a>
          <a className="flex items-center px-4 py-3 rounded-xl text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all group" href="#">
            <span className="material-symbols-outlined mr-4 text-[22px]">folder_shared</span>
            <span className="font-body-md">Directory</span>
          </a>
          <a className="flex items-center px-4 py-3 rounded-xl text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all group" href="#">
            <span className="material-symbols-outlined mr-4 text-[22px]">radar</span>
            <span className="font-body-md">Automated Scans</span>
          </a>
          <a className="flex items-center px-4 py-3 rounded-xl text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all group" href="#">
            <span className="material-symbols-outlined mr-4 text-[22px]">settings</span>
            <span className="font-body-md">Settings</span>
          </a>
        </nav>
      </aside>

      <div className="md:pl-64 lg:pl-72">
        {/* HEADER */}
        <header className="fixed top-0 md:left-64 lg:left-72 right-0 h-20 bg-background/60 backdrop-blur-xl z-40 px-6 lg:px-margin-desktop flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-4 lg:gap-gutter">
            <div className="h-2 w-2 rounded-full bg-secondary animate-pulse"></div>
            <span className="font-label-caps text-[10px] lg:text-label-caps text-on-surface-variant uppercase tracking-widest hidden sm:block">
              System Active: Intelligence Node Alpha
            </span>
          </div>
          <div className="flex items-center gap-4 lg:gap-6">
            <button className="text-on-surface-variant hover:text-on-surface transition-colors flex items-center">
              <span className="material-symbols-outlined">search</span>
            </button>
            <button className="text-on-surface-variant hover:text-on-surface transition-colors flex items-center relative">
              <span className="material-symbols-outlined">notifications</span>
              <span className="absolute top-0 right-0 w-2 h-2 bg-urgent-red rounded-full ring-2 ring-background"></span>
            </button>
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </div>
          </div>
        </header>

        <main className="relative pt-24 min-h-screen bg-bg-slate-950 px-4 sm:px-6 lg:px-margin-desktop py-gutter">
          <div className="flex flex-col w-full gap-8">
            
            {/* CONTROL PANEL (Now wraps beautifully!) */}
            <div className="w-full bg-surface-container/60 backdrop-blur-2xl rounded-2xl p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-secondary/5 opacity-50 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"></div>
              <div className="relative flex flex-wrap items-end gap-4 w-full z-10">
                <div className="flex-1 min-w-[220px] space-y-2">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest pl-1 block">Target Competitor / AR ID</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[20px]">radar</span>
                    <input 
                      value={scanQuery}
                      onChange={(e) => setScanQuery(e.target.value)}
                      className="w-full bg-surface-dim text-on-surface font-body-md rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all placeholder:text-outline-variant shadow-inner" 
                      placeholder="e.g. Voodoo or ID: 12489" 
                      type="text"
                    />
                  </div>
                </div>
                <div className="w-full sm:w-44 space-y-2">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest pl-1 block">Geo-Target</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[20px]">public</span>
                    <select 
                      value={targetCountry}
                      onChange={(e) => setTargetCountry(e.target.value)}
                      className="w-full bg-surface-dim text-on-surface font-body-md rounded-xl py-3 pl-10 pr-10 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner appearance-none cursor-pointer"
                    >
                      <option>Any Region (Global)</option>
                      <option>United States (US)</option>
                      <option>Japan (JP)</option>
                      <option>Germany (DE)</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-outline text-[20px] pointer-events-none">expand_more</span>
                  </div>
                </div>
                <div className="w-full sm:w-28 space-y-2">
                  <label className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest pl-1 block">Ad Limit</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[20px]">filter_list</span>
                    <input 
                      value={scanLimit}
                      onChange={(e) => setScanLimit(Number(e.target.value))}
                      className="w-full bg-surface-dim text-on-surface font-body-md rounded-xl py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-electric-blue/50 transition-all shadow-inner" 
                      type="number" 
                    />
                  </div>
                </div>
                <div className="flex gap-4 items-center flex-shrink-0 w-full md:w-auto mt-2 md:mt-0">
                  <button 
                    onClick={handleRunScan}
                    disabled={isScanning}
                    className="flex-1 md:flex-none bg-electric-blue hover:bg-primary-container text-white font-body-md font-semibold py-3 px-6 rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_25px_rgba(59,130,246,0.5)] transition-all flex justify-center items-center gap-2 group transform active:scale-95 disabled:opacity-50 whitespace-nowrap"
                  >
                    <span className={`material-symbols-outlined text-[20px] ${isScanning ? "animate-spin" : "group-hover:animate-spin"}`}>data_usage</span>
                    {isScanning ? "Scanning..." : "Run Scan"}
                  </button>
                  <button 
                    onClick={handleReset}
                    className="text-urgent-red hover:bg-urgent-red/10 font-label-caps text-label-caps uppercase tracking-widest py-3 px-4 rounded-xl transition-all flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
                    Reset DB
                  </button>
                </div>
              </div>
            </div>

            {/* STATS GRID (Now dynamically snaps to 2x2 on laptops!) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
              <div className="bg-surface-container rounded-2xl p-6 shadow-md relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/10 rounded-full blur-xl group-hover:bg-primary/20 transition-colors"></div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">schedule</span>
                  </div>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Last Scan</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-metric-xl text-metric-xl text-on-surface">{lastScanTime}</span>
                </div>
              </div>
              
              <div className="bg-surface-container rounded-2xl p-6 shadow-md relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-secondary/10 rounded-full blur-xl group-hover:bg-secondary/20 transition-colors"></div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-secondary">
                    <span className="material-symbols-outlined">corporate_fare</span>
                  </div>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Competitors</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-metric-xl text-metric-xl text-on-surface">{stats.competitors}</span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Tracked</span>
                </div>
                <div className="mt-4 w-full h-1 bg-surface-dim rounded-full overflow-hidden">
                  <div className="h-full bg-secondary w-3/4 rounded-full"></div>
                </div>
              </div>

              <div className="bg-surface-container rounded-2xl p-6 shadow-md relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-tertiary-container/10 rounded-full blur-xl group-hover:bg-tertiary-container/20 transition-colors"></div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-tertiary-container">
                    <span className="material-symbols-outlined">account_box</span>
                  </div>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Publishers</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-metric-xl text-metric-xl text-on-surface">{stats.accounts}</span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Accounts</span>
                </div>
                <div className="mt-4 flex gap-1">
                  <div className="h-1 flex-1 bg-tertiary-container rounded-full opacity-100"></div>
                  <div className="h-1 flex-1 bg-tertiary-container rounded-full opacity-80"></div>
                  <div className="h-1 flex-1 bg-tertiary-container rounded-full opacity-40"></div>
                  <div className="h-1 flex-1 bg-tertiary-container rounded-full opacity-20"></div>
                </div>
              </div>

              <div className="bg-surface-container rounded-2xl p-6 shadow-md relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-electric-blue/10 rounded-full blur-xl group-hover:bg-electric-blue/20 transition-colors"></div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-electric-blue">
                    <span className="material-symbols-outlined">sports_esports</span>
                  </div>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Games</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-metric-xl text-metric-xl text-on-surface">{stats.games}</span>
                </div>
              </div>
            </div>

            {/* LOWER SECTION (Stacks beautifully on smaller screens) */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mt-4">
              
              {/* TRENDING TARGETS */}
              <div className="xl:col-span-7 bg-surface-container rounded-2xl shadow-xl overflow-hidden flex flex-col">
                <div className="p-6 pb-4 bg-surface-container-highest/50 flex justify-between items-end">
                  <div>
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">Trending Targets</h2>
                    <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">Highest Ad Velocity in last 48h</p>
                  </div>
                  <button className="text-electric-blue hover:text-primary-fixed transition-colors font-body-sm flex items-center gap-1">
                    View All <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                  </button>
                </div>
                <div className="flex-1 p-2 space-y-2">
                  <div className="flex items-center p-4 rounded-xl hover:bg-electric-blue/5 transition-colors group cursor-pointer relative overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-electric-blue transform scale-y-0 group-hover:scale-y-100 transition-transform origin-top"></div>
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-surface-dim mr-4 flex-shrink-0 shadow-md">
                      <img className="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuBZ363e75d3YsBK2FkJCaVMB5vmOkBj02-rCbEM40cy88beOzXwSxmq5KMbo37VJoSIbWYBNS0HO5kth2EX_zxDxGWkQbYHgsQ23EkoWBKuvw-QQoWwyvuym0kRruXEkh8KfZJxt7t6mH141c17RmygFHdkUXCCQaVN26kC4CIx9J7BuLgw6kSsWBoAxxUUjHTs14vj8zEq1G22X5U4M1JpBfnyOv44GjRNiIwhDPhKf7ju5HMl_JS9Ag" alt="Helix Jump" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-body-md font-semibold text-on-surface truncate">Helix Jump</h3>
                      <p className="font-body-sm text-on-surface-variant truncate">Voodoo • Arcade</p>
                    </div>
                    <div className="flex flex-col items-end gap-2 ml-4">
                      <div className="bg-emerald-metric/10 text-emerald-metric px-3 py-1 rounded-full font-label-caps text-label-caps flex items-center gap-1 whitespace-nowrap shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                        🔥 +150 Ads (48h)
                      </div>
                      <span className="font-label-caps text-label-caps text-electric-blue uppercase tracking-wider bg-electric-blue/10 px-2 py-0.5 rounded hidden sm:block">Recommend Clone</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center p-4 rounded-xl hover:bg-electric-blue/5 transition-colors group cursor-pointer relative overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-electric-blue transform scale-y-0 group-hover:scale-y-100 transition-transform origin-top"></div>
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-surface-dim mr-4 flex-shrink-0 shadow-md">
                      <img className="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuAfwHlDV-GUEhj7j_C6lon_SNtm1IkovfMgVczdLEPxj_uRLah-AW6HOsIdP5336GR_28KxIMSdBiA8NPhtSq_GjH3mGcQQn_p4kqO_jrSdzVi5v3fEpwSo_Qf7LO8ihnjyYOOxU0vZ_FcdeEfZxMggG2QrWO-lOV-PiZWkJ_gIkaUfqtUfmB_h4Lfba01RhOw5HrDQRsoCEO_UFdu2jEikZX6BQz9M02PYwS4TOZQPT14h78fMgMhusQ" alt="Aquapark.io" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-body-md font-semibold text-on-surface truncate">Aquapark.io</h3>
                      <p className="font-body-sm text-on-surface-variant truncate">Voodoo • Racing</p>
                    </div>
                    <div className="flex flex-col items-end gap-2 ml-4">
                      <div className="bg-emerald-metric/10 text-emerald-metric px-3 py-1 rounded-full font-label-caps text-label-caps flex items-center gap-1 whitespace-nowrap">
                        🔥 +112 Ads (48h)
                      </div>
                      <span className="font-label-caps text-label-caps text-electric-blue uppercase tracking-wider bg-electric-blue/10 px-2 py-0.5 rounded hidden sm:block">High Potential</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* LIVE DIRECTORY */}
              <div className="xl:col-span-5 bg-surface-container rounded-2xl shadow-xl overflow-hidden flex flex-col relative">
                <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-primary/10 to-transparent pointer-events-none"></div>
                <div className="p-6 pb-4 border-b border-white/5 relative z-10">
                  <h2 className="font-headline-lg text-headline-lg text-on-surface">Live Directory</h2>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">Database Hierarchy View</p>
                </div>
                <div className="flex-1 p-6 overflow-y-auto relative z-10 max-h-[500px]">
                  
                  {competitorTree.length === 0 ? (
                    <div className="text-center font-body-sm text-on-surface-variant mt-10">No data found. Run a scan!</div>
                  ) : (
                    competitorTree.map((comp) => (
                      <div key={comp.id} className="mb-6">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="material-symbols-outlined text-tertiary-container">domain</span>
                          <span className="font-body-md font-semibold text-on-surface">{comp.name}</span>
                          <span className="font-label-caps text-label-caps text-on-surface-variant bg-surface-dim px-2 py-1 rounded-md ml-auto">Competitor Group</span>
                        </div>
                        
                        <div className="ml-4 pl-4 border-l border-white/10 space-y-4">
                          {comp.accounts && comp.accounts.map((acc) => (
                            <div key={acc.id}>
                              <div className="flex items-center gap-3 mb-3 mt-4">
                                <div className="w-6 border-b border-white/10 -ml-4"></div>
                                <span className="material-symbols-outlined text-secondary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>folder</span>
                                <span className="font-body-md text-on-surface">{acc.publisher_name}</span>
                                <span className="font-label-caps text-label-caps text-on-surface-variant bg-surface-dim px-2 py-1 rounded-md ml-auto hidden sm:block">Publisher</span>
                              </div>
                              
                              <div className="ml-6 pl-4 border-l border-white/10 space-y-2">
                                {acc.games && acc.games.map((game) => (
                                  <div key={game.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-container-high text-on-surface cursor-pointer group transition-colors">
                                    <div className="w-4 border-b border-white/10 -ml-4"></div>
                                    <span className="material-symbols-outlined text-outline text-[18px]">smartphone</span>
                                    <div className="flex-1 min-w-0">
                                      <p className="font-body-sm font-semibold truncate">{game.title}</p>
                                      <p className="font-label-caps text-[10px] text-outline-variant truncate font-mono">{game.package_name}</p>
                                    </div>
                                    <div className="flex flex-col items-end">
                                      <div className="flex items-center text-tertiary-fixed text-[12px]">
                                        <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>star</span> 
                                        {game.rating > 0 ? game.rating.toFixed(1) : "N/A"}
                                      </div>
                                      <span className="text-[10px] text-on-surface-variant">{game.ratings_count || 0} revs</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}

                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;