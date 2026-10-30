import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "./apiConfig.js";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";

const AUTH_TOKEN_KEY = "atlas_auth_token";

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "69420",
      ...(token ? { "x-atlas-token": token } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try { msg = JSON.parse(text)?.error || msg; } catch {}
    throw new Error(msg);
  }
  return response.json();
}

function formatCompactNumber(num) {
  if (num == null || isNaN(num)) return "0";
  const n = Number(num);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

export default memo(function MarketIntelligenceView({ isAdmin = false, onOpenCountryScan = null }) {
  const [playData, setPlayData] = useState({ publishers: [], games: [], lists: [], competitorGroups: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [selectedPricing, setSelectedPricing] = useState("all");
  const [sortBy, setSortBy] = useState("installs");
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchJson(`${API_BASE}/api/play/overview`);
      setPlayData(res || { publishers: [], games: [], lists: [], competitorGroups: [] });
    } catch (err) {
      console.error("Market Intelligence fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Resolve active competitor group / batch
  const activeGroup = useMemo(() => {
    if (selectedGroup === "all") return null;
    return (playData.competitorGroups || []).find((g) => String(g.id) === String(selectedGroup)) || null;
  }, [playData.competitorGroups, selectedGroup]);

  // Filtered games
  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (playData.games || []).filter((g) => {
      if (activeGroup) {
        const pId = Number(g.publisher_id);
        if (activeGroup.publisher_ids && !activeGroup.publisher_ids.includes(pId)) return false;
      }
      if (selectedPricing === "free" && g.pricing !== "free") return false;
      if (selectedPricing === "paid" && g.pricing !== "paid") return false;
      if (q) {
        const titleMatch = (g.title || "").toLowerCase().includes(q);
        const pkgMatch = (g.package_name || "").toLowerCase().includes(q);
        const devMatch = (g.publisher_name || "").toLowerCase().includes(q);
        if (!titleMatch && !pkgMatch && !devMatch) return false;
      }
      return true;
    }).sort((a, b) => {
      if (sortBy === "installs") {
        return (Number(b.real_installs ?? b.min_installs) || 0) - (Number(a.real_installs ?? a.min_installs) || 0);
      }
      if (sortBy === "delta") {
        return (Number(b.installs_delta_1d) || 0) - (Number(a.installs_delta_1d) || 0);
      }
      if (sortBy === "rating") {
        return (Number(b.rating) || 0) - (Number(a.rating) || 0);
      }
      return (b.title || "").localeCompare(a.title || "");
    });
  }, [playData.games, activeGroup, selectedPricing, search, sortBy]);

  const totalInstalls = useMemo(() => {
    return filteredGames.reduce((acc, g) => acc + (Number(g.real_installs ?? g.min_installs) || 0), 0);
  }, [filteredGames]);

  const totalVelocity = useMemo(() => {
    return filteredGames.reduce((acc, g) => acc + (Number(g.installs_delta_1d) || 0), 0);
  }, [filteredGames]);

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full px-2 sm:px-4 py-4">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-300 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 text-[11px] font-semibold mb-2">
            <span className="material-symbols-outlined text-[15px]">insights</span>
            Market Intelligence · Catalog &amp; Velocity Radar
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">
            Market Intelligence
          </h1>
          <p className="text-xs text-text-muted mt-1">
            Aggregated cross-competitor ecosystem catalog with verified real installs and launch velocity.
          </p>
        </div>

        {/* Competitor Batches Filter */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">folder_special</span>
              Batch / Group:
            </span>
            <div className="relative">
              <select
                value={selectedGroup}
                onChange={(e) => setSelectedGroup(e.target.value)}
                className="h-9 pl-3 pr-8 rounded-xl bg-input-bg border border-border-subtle text-xs font-semibold text-text-main hover:border-electric-blue/40 focus:border-electric-blue focus:outline-none transition appearance-none cursor-pointer"
              >
                <option value="all">All Ecosystem ({playData.publishers?.length || 0} publishers)</option>
                {(playData.competitorGroups || []).map((grp) => (
                  <option key={grp.id} value={grp.id}>
                    ★ {grp.name} ({grp.account_count || 0} accounts)
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined text-[16px] text-text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                unfold_more
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={loadData}
            className="h-9 px-3 rounded-xl bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-semibold flex items-center gap-1.5 transition"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-[15px]">refresh</span>
          </button>
        </div>
      </div>

      {/* METRICS ROW */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-4 rounded-2xl bg-surface-solid border border-border-subtle shadow-sm">
          <div className="text-xs text-text-muted font-medium">Unique Titles</div>
          <div className="text-2xl font-bold text-text-main mt-1">{filteredGames.length.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-0.5">Across tracked publishers</div>
        </div>
        <div className="p-4 rounded-2xl bg-surface-solid border border-border-subtle shadow-sm">
          <div className="text-xs text-text-muted font-medium">Verified Installs</div>
          <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400 mt-1">{formatCompactNumber(totalInstalls)}</div>
          <div className="text-[10px] text-text-muted mt-0.5">Total market reach</div>
        </div>
        <div className="p-4 rounded-2xl bg-surface-solid border border-border-subtle shadow-sm">
          <div className="text-xs text-text-muted font-medium">Daily Velocity</div>
          <div className="text-2xl font-bold text-electric-blue mt-1">+{formatCompactNumber(totalVelocity)}/d</div>
          <div className="text-[10px] text-text-muted mt-0.5">Daily install movement</div>
        </div>
        <div className="p-4 rounded-2xl bg-surface-solid border border-border-subtle shadow-sm">
          <div className="text-xs text-text-muted font-medium">Tracked Publishers</div>
          <div className="text-2xl font-bold text-text-main mt-1">
            {activeGroup ? (activeGroup.account_count || 0) : (playData.publishers?.length || 0)}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">{playData.lists?.length || 0} competitor entities</div>
        </div>
      </div>

      {/* SEARCH AND FILTERS */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col gap-3 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-main">
            Market Games Catalog ({filteredGames.length.toLocaleString()})
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <select
                value={selectedPricing}
                onChange={(e) => setSelectedPricing(e.target.value)}
                className="h-9 pl-3 pr-8 rounded-xl bg-input-bg border border-border-subtle text-xs font-semibold text-text-main hover:border-electric-blue/40 focus:border-electric-blue focus:outline-none transition appearance-none cursor-pointer"
              >
                <option value="all">All Pricing</option>
                <option value="free">Free Only</option>
                <option value="paid">Paid Only</option>
              </select>
              <span className="material-symbols-outlined text-[16px] text-text-muted absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                unfold_more
              </span>
            </div>

            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="h-9 pl-3 pr-8 rounded-xl bg-input-bg border border-border-subtle text-xs font-semibold text-text-main hover:border-electric-blue/40 focus:border-electric-blue focus:outline-none transition appearance-none cursor-pointer"
              >
                <option value="installs">Sort: Highest Installs</option>
                <option value="delta">Sort: Fastest Daily Velocity</option>
                <option value="rating">Sort: Highest Rating</option>
              </select>
              <span className="material-symbols-outlined text-[16px] text-text-muted absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                unfold_more
              </span>
            </div>

            <div className="relative">
              <span className="material-symbols-outlined text-[16px] text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                search
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search market catalog..."
                className="h-9 pl-8 pr-3 rounded-xl bg-input-bg border border-border-subtle text-xs font-medium text-text-main placeholder:text-text-muted focus:border-electric-blue outline-none transition w-52 sm:w-60"
              />
            </div>
          </div>
        </div>

        {/* GAMES TABLE */}
        {loading ? (
          <div className="py-20 text-center text-xs text-text-muted">Loading market catalog...</div>
        ) : filteredGames.length === 0 ? (
          <div className="py-16 text-center text-xs text-text-muted">No games match current filter criteria.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-subtle text-[11px] font-semibold text-text-muted">
                  <th className="py-2.5 px-3">Title / Package</th>
                  <th className="py-2.5 px-3">Publisher</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3 text-right">Real Installs</th>
                  <th className="py-2.5 px-3 text-right">Velocity</th>
                  <th className="py-2.5 px-3 text-center">Rating</th>
                </tr>
              </thead>
              <tbody>
                {filteredGames.slice(0, 50).map((g) => (
                  <tr
                    key={g.id || g.package_name}
                    onClick={() => setActiveGameDrawer(g)}
                    className="border-b border-border-subtle/50 hover:bg-input-bg/60 cursor-pointer transition group"
                  >
                    <td className="py-2.5 px-3 max-w-[280px]">
                      <div className="flex items-center gap-2.5">
                        {g.icon ? (
                          <img src={g.icon} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-8 h-8 rounded-lg bg-input-bg flex items-center justify-center flex-shrink-0 text-text-muted">
                            <span className="material-symbols-outlined text-[18px]">sports_esports</span>
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold text-text-main truncate group-hover:text-electric-blue transition-colors">
                            {g.title || g.package_name}
                          </div>
                          <div className="text-[10px] text-text-muted font-mono truncate">{g.package_name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-text-muted truncate max-w-[160px]">
                      {g.publisher_name || "—"}
                    </td>
                    <td className="py-2.5 px-3 text-text-muted truncate max-w-[120px]">
                      {g.category || "Game"}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatCompactNumber(g.real_installs ?? g.min_installs)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-medium text-electric-blue">
                      {g.installs_delta_1d > 0 ? `+${formatCompactNumber(g.installs_delta_1d)}/d` : "—"}
                    </td>
                    <td className="py-2.5 px-3 text-center text-text-muted">
                      {g.rating ? `★ ${Number(g.rating).toFixed(1)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* UNIVERSAL GAME DRAWER */}
      {activeGameDrawer && (
        <UniversalGameDetailDrawer
          game={activeGameDrawer}
          allGames={playData.games || []}
          onClose={() => setActiveGameDrawer(null)}
          isAdmin={isAdmin}
          onOpenCountryScan={onOpenCountryScan}
        />
      )}
    </div>
  );
});
