import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { API_BASE } from "./apiConfig";
import AtlasSelect from "./AtlasSelect";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";
import { AtlasFeedback } from "./AtlasFeedback.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import {
  Badge,
  EmptyState,
  TableSkeleton
} from "./components/ui/UiPrimitives.jsx";

const EXCLUDED_PHRASES_STORAGE_KEY = "atlas_summary_excluded_phrases_v1";

const WINDOW_OPTIONS = [
  { value: "7d", label: "7d" },
  { value: "14d", label: "14d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" }
];

const SEGMENT_OPTIONS = [
  { value: "all", label: "All" },
  { value: "game", label: "Games" },
  { value: "app", label: "Apps" }
];

const DATE_BASIS_OPTIONS = [
  { value: "release_date", label: "Launch Date" },
  { value: "first_seen_at", label: "Discovered in Atlas" }
];

const SUMMARY_TABS = [
  { id: "overview", label: "Overview" },
  { id: "trends", label: "Title Trends" },
  { id: "genres", label: "Genre Growth" },
  { id: "competitors", label: "Competitors" },
  { id: "newcomers", label: "Newcomers" }
];

const GENRE_SIGNAL_OPTIONS = [
  { value: "all", label: "All Signals" },
  { value: "hot_wave", label: "Hot Wave" },
  { value: "rising_demand", label: "Rising Demand" },
  { value: "opportunity", label: "Opportunity" },
  { value: "declining", label: "Declining" },
  { value: "crowded", label: "Crowded" }
];

function formatCompact(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}${Math.round(abs).toLocaleString()}`;
}

function formatSignedCompact(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return "0";
  return `${n > 0 ? "+" : ""}${formatCompact(n)}`;
}

function getTrendBadgeMeta(status) {
  if (status === "new_wave") return { tone: "accent", label: "New wave" };
  if (status === "emerging") return { tone: "success", label: "Emerging" };
  if (status === "single_competitor") return { tone: "warning", label: "Single competitor" };
  return { tone: "neutral", label: "Established" };
}

function getGenreSignalMeta(signal) {
  switch (signal) {
    case "hot_wave":
      return { tone: "accent", label: "Hot wave" };
    case "rising_demand":
      return { tone: "success", label: "Rising demand" };
    case "opportunity":
      return { tone: "success", label: "Opportunity" };
    case "declining":
      return { tone: "danger", label: "Declining" };
    case "crowded":
      return { tone: "warning", label: "Crowded" };
    default:
      return { tone: "neutral", label: "Steady" };
  }
}

function getSignalActionLabel(targetTab) {
  switch (targetTab) {
    case "trends":
      return "View matching titles";
    case "genres":
      return "View genre analysis";
    case "competitors":
      return "View competitor activity";
    case "newcomers":
      return "View newcomers";
    default:
      return "Inspect details";
  }
}

function loadStoredExcludedPhrases() {
  try {
    const raw = localStorage.getItem(EXCLUDED_PHRASES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((p) => String(p || "").trim().toLowerCase()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function SegmentedPills({ options, value, onChange, ariaLabel }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center p-0.5 rounded-lg bg-input-bg border border-border-subtle shrink-0"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={`px-2.5 h-7 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              active
                ? "bg-surface-solid text-text-main shadow-sm border border-border-subtle"
                : "text-text-muted hover:text-text-main border border-transparent"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function GameChipButton({ game, onSelect, extraLabel = null }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(game);
      }}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-input-bg/70 hover:bg-input-bg border border-border-subtle text-xs text-text-main transition-colors max-w-[230px] cursor-pointer"
      title={`${game.title || game.package_name}${game.competitor_name ? ` · ${game.competitor_name}` : ""}`}
    >
      {game.icon ? (
        <img
          src={game.icon}
          alt=""
          loading="lazy"
          className="w-4 h-4 rounded object-cover shrink-0 border border-border-subtle"
        />
      ) : (
        <AtlasIcon name="sports_esports" size={13} className="text-text-muted shrink-0" />
      )}
      <span className="truncate font-medium">{game.title || game.package_name}</span>
      {extraLabel && (
        <span className="text-[11px] text-text-muted tabular-nums shrink-0">{extraLabel}</span>
      )}
    </button>
  );
}

function EvidenceGameCard({ game, onSelect, metricNote = null }) {
  const installs = Number(game.real_installs || 0);
  const daily = Number(game.installs_delta_1d || 0);
  return (
    <button
      type="button"
      onClick={() => onSelect(game)}
      className="w-full p-2.5 rounded-lg bg-input-bg/45 hover:bg-input-bg border border-border-subtle text-left flex items-center justify-between gap-3 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {game.icon ? (
          <img
            src={game.icon}
            alt=""
            loading="lazy"
            className="w-8 h-8 rounded-lg object-cover shrink-0 border border-border-subtle"
          />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-surface-solid border border-border-subtle flex items-center justify-center shrink-0 text-text-muted">
            <AtlasIcon name="sports_esports" size={15} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-xs font-medium text-text-main truncate group-hover:text-link transition-colors">
            {game.title || game.package_name}
          </div>
          <div className="text-[11px] text-text-muted truncate">
            {[game.competitor_name || game.publisher_name, game.primaryGenre, game.release_date?.slice(0, 10)]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </div>

      <div className="text-right shrink-0 tabular-nums">
        <div className="text-xs font-medium text-text-main">{formatCompact(installs)}</div>
        <div className="text-[11px] text-text-muted">
          {metricNote || (daily > 0 ? `+${formatCompact(daily)}/d` : "—")}
        </div>
      </div>
    </button>
  );
}

export default function MarketSummaryView({
  onOpenCountryScan,
  onSearchInPlayStore,
  isAdmin = false
}) {
  const [windowRange, setWindowRange] = useState("30d");
  const [appType, setAppType] = useState("all");
  const [dateBasis, setDateBasis] = useState("release_date");
  const [competitorId, setCompetitorId] = useState("all");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [fetchNonce, setFetchNonce] = useState(0);

  const [activeSubTab, setActiveSubTab] = useState("overview");

  // Popover controls
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [showHiddenPopover, setShowHiddenPopover] = useState(false);

  // Overview state
  const [showAllSignals, setShowAllSignals] = useState(false);
  const [expandedSignalIds, setExpandedSignalIds] = useState(() => new Set());

  // Title Trends state
  const [trendMode, setTrendMode] = useState("emerging");
  const [showSingleCompetitor, setShowSingleCompetitor] = useState(false);
  const [phraseQuery, setPhraseQuery] = useState("");
  const [excludedPhrases, setExcludedPhrases] = useState(loadStoredExcludedPhrases);
  const [expandedTrendKey, setExpandedTrendKey] = useState(null);

  // Genre Growth state
  const [genreMode, setGenreMode] = useState("primary");
  const [genreSignalFilter, setGenreSignalFilter] = useState("all");
  const [expandedGenreKey, setExpandedGenreKey] = useState(null);

  // Competitors state
  const [showAllShifts, setShowAllShifts] = useState(false);
  const [expandedShiftKeys, setExpandedShiftKeys] = useState(() => new Set());
  const [expandedCompetitorKey, setExpandedCompetitorKey] = useState(null);

  // Newcomers highlight state
  const [highlightedNewcomerPkg, setHighlightedNewcomerPkg] = useState(null);

  const [selectedGame, setSelectedGame] = useState(null);

  const freshNextRef = useRef(false);
  const moreFiltersRef = useRef(null);
  const coverageRef = useRef(null);
  const hiddenPopoverRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const isFresh = freshNextRef.current;
    freshNextRef.current = false;

    const params = new URLSearchParams({
      window: windowRange,
      appType,
      dateBasis,
      competitorId
    });
    if (isFresh) params.set("fresh", "1");

    const token =
      localStorage.getItem("atlas_auth_token") ||
      localStorage.getItem("atlas_token") ||
      "";

    fetch(`${API_BASE}/api/summary/market-pulse?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "ngrok-skip-browser-warning": "69420",
        ...(token ? { "x-atlas-token": token, Authorization: `Bearer ${token}` } : {})
      }
    })
      .then(async (res) => {
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err.name === "AbortError") return;
        setError(err.message || "Failed to load market summary.");
        setLoading(false);
        setRefreshing(false);
      });

    return () => controller.abort();
  }, [windowRange, appType, dateBasis, competitorId, fetchNonce]);

  useEffect(() => {
    if (!moreFiltersOpen && !coverageOpen && !showHiddenPopover) return;
    function handleOutside(e) {
      if (moreFiltersOpen && moreFiltersRef.current && !moreFiltersRef.current.contains(e.target)) {
        setMoreFiltersOpen(false);
      }
      if (coverageOpen && coverageRef.current && !coverageRef.current.contains(e.target)) {
        setCoverageOpen(false);
      }
      if (showHiddenPopover && hiddenPopoverRef.current && !hiddenPopoverRef.current.contains(e.target)) {
        setShowHiddenPopover(false);
      }
    }
    function handleKey(e) {
      if (e.key === "Escape") {
        setMoreFiltersOpen(false);
        setCoverageOpen(false);
        setShowHiddenPopover(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [moreFiltersOpen, coverageOpen, showHiddenPopover]);

  const handleFilterUpdate = useCallback((setter, nextVal) => {
    setError(null);
    setLoading(true);
    setter(nextVal);
  }, []);

  const handleResetFilters = useCallback(() => {
    const anyChanged =
      windowRange !== "30d" ||
      appType !== "all" ||
      dateBasis !== "release_date" ||
      competitorId !== "all";
    if (!anyChanged) {
      setMoreFiltersOpen(false);
      return;
    }
    setError(null);
    setLoading(true);
    setWindowRange("30d");
    setAppType("all");
    setDateBasis("release_date");
    setCompetitorId("all");
    setMoreFiltersOpen(false);
  }, [windowRange, appType, dateBasis, competitorId]);

  const handleRefresh = useCallback(() => {
    freshNextRef.current = true;
    setError(null);
    setRefreshing(true);
    setFetchNonce((n) => n + 1);
  }, []);

  const persistExcluded = useCallback((nextList) => {
    setExcludedPhrases(nextList);
    try {
      localStorage.setItem(EXCLUDED_PHRASES_STORAGE_KEY, JSON.stringify(nextList));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleHidePhrase = useCallback(
    (phrase) => {
      const normalized = String(phrase || "").trim().toLowerCase();
      if (!normalized || excludedPhrases.includes(normalized)) return;
      persistExcluded([...excludedPhrases, normalized]);
      AtlasFeedback.toast(`Hidden "${phrase}" from Title Trends.`, { tone: "info" });
    },
    [excludedPhrases, persistExcluded]
  );

  const handleRestorePhrase = useCallback(
    (phrase) => {
      persistExcluded(excludedPhrases.filter((p) => p !== phrase));
    },
    [excludedPhrases, persistExcluded]
  );

  const handleClearExcluded = useCallback(() => {
    persistExcluded([]);
    setShowHiddenPopover(false);
  }, [persistExcluded]);

  const toggleSignalEvidence = useCallback((obsId) => {
    setExpandedSignalIds((prev) => {
      const next = new Set(prev);
      if (next.has(obsId)) next.delete(obsId);
      else next.add(obsId);
      return next;
    });
  }, []);

  const toggleShiftEvidence = useCallback((shiftKey) => {
    setExpandedShiftKeys((prev) => {
      const next = new Set(prev);
      if (next.has(shiftKey)) next.delete(shiftKey);
      else next.add(shiftKey);
      return next;
    });
  }, []);

  const competitorSelectGroups = useMemo(() => {
    const opts = data?.filterOptions || { groups: [], competitors: [] };
    const result = [
      {
        group: "Scope",
        items: [{ value: "all", label: "All Competitors" }]
      }
    ];
    if (Array.isArray(opts.groups) && opts.groups.length > 0) {
      result.push({
        group: "Competitor Groups",
        items: opts.groups.map((g) => ({
          value: `group_${g.id}`,
          label: `${g.name} (${g.member_count || 0})`
        }))
      });
    }
    if (Array.isArray(opts.competitors) && opts.competitors.length > 0) {
      result.push({
        group: "Competitors",
        items: opts.competitors.map((c) => ({
          value: String(c.id),
          label: `${c.name} (${c.account_count || 0} accts)`
        }))
      });
    }
    return result;
  }, [data?.filterOptions]);

  const selectedCompetitorLabel = useMemo(() => {
    if (competitorId === "all") return null;
    const opts = data?.filterOptions || { groups: [], competitors: [] };
    if (competitorId.startsWith("group_")) {
      const gid = Number(competitorId.slice(6));
      const grp = (opts.groups || []).find((g) => Number(g.id) === gid);
      return grp ? `Group: ${grp.name}` : competitorId;
    }
    const comp = (opts.competitors || []).find((c) => String(c.id) === String(competitorId));
    return comp ? comp.name : competitorId;
  }, [competitorId, data?.filterOptions]);

  const excludedSet = useMemo(() => new Set(excludedPhrases), [excludedPhrases]);

  const drawerPool = useMemo(() => {
    if (!data) return [];
    const byPkg = new Map();
    const pushList = (list) => {
      if (!Array.isArray(list)) return;
      for (const g of list) {
        if (g?.package_name && !byPkg.has(g.package_name)) {
          byPkg.set(g.package_name, g);
        }
      }
    };
    pushList(data.recentTitles);
    pushList(data.newcomers);
    for (const obs of data.observations || []) pushList(obs.evidenceGames);
    for (const t of data.titleTrends?.emerging || []) pushList(t.matchingGames);
    for (const g of data.genreGrowth?.primary || []) {
      pushList(g.topGrowingGames);
      pushList(g.newestReleases);
    }
    for (const c of data.competitorActivity?.activeCompetitors || []) pushList(c.recentReleases);
    return [...byPkg.values()];
  }, [data]);

  const filteredTrends = useMemo(() => {
    const rawList =
      trendMode === "repeated"
        ? data?.titleTrends?.repeated || []
        : data?.titleTrends?.emerging || [];
    const q = phraseQuery.trim().toLowerCase();
    return rawList.filter((item) => {
      if (excludedSet.has(item.phrase)) return false;
      if (!q) return true;
      if (item.phrase.includes(q) || item.displayPhrase.toLowerCase().includes(q)) return true;
      return (item.matchingGames || []).some((g) =>
        String(g.title || "").toLowerCase().includes(q)
      );
    });
  }, [data?.titleTrends, trendMode, excludedSet, phraseQuery]);

  const filteredSingleComp = useMemo(() => {
    const list = data?.titleTrends?.singleCompetitor || [];
    const q = phraseQuery.trim().toLowerCase();
    return list.filter((item) => {
      if (excludedSet.has(item.phrase)) return false;
      if (!q) return true;
      return (
        item.phrase.includes(q) ||
        item.displayPhrase.toLowerCase().includes(q) ||
        (item.matchingGames || []).some((g) => String(g.title || "").toLowerCase().includes(q))
      );
    });
  }, [data?.titleTrends?.singleCompetitor, excludedSet, phraseQuery]);

  const directRecentTitleMatches = useMemo(() => {
    const q = phraseQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const list = data?.recentTitles || [];
    return list
      .filter(
        (g) =>
          String(g.title || "").toLowerCase().includes(q) ||
          String(g.competitor_name || "").toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [data?.recentTitles, phraseQuery]);

  const filteredGenres = useMemo(() => {
    const list =
      genreMode === "subgenres"
        ? data?.genreGrowth?.subgenres || []
        : data?.genreGrowth?.primary || [];
    if (genreSignalFilter === "all") return list;
    return list.filter((g) => g.signal === genreSignalFilter);
  }, [data?.genreGrowth, genreMode, genreSignalFilter]);

  const handleObservationNavigate = useCallback((obs) => {
    if (!obs?.targetTab) return;
    setActiveSubTab(obs.targetTab);
    if (obs.targetTab === "trends") {
      setTrendMode("emerging");
      setExpandedTrendKey(obs.targetKey || null);
    } else if (obs.targetTab === "genres") {
      setGenreMode("primary");
      setGenreSignalFilter("all");
      setExpandedGenreKey(obs.targetKey || null);
    } else if (obs.targetTab === "competitors") {
      setExpandedCompetitorKey(obs.targetKey || null);
    } else if (obs.targetTab === "newcomers") {
      setHighlightedNewcomerPkg(obs.targetKey || null);
    }
  }, []);

  const secondaryFilterCount =
    (dateBasis !== "release_date" ? 1 : 0) + (competitorId !== "all" ? 1 : 0);
  const anyNonDefaultFilter =
    secondaryFilterCount > 0 || windowRange !== "30d" || appType !== "all";

  const meta = data?.meta;
  const coverage = meta?.coverage;
  const k = data?.kpis;
  const observations = data?.observations || [];
  const visibleSignals = showAllSignals ? observations : observations.slice(0, 3);
  const shifts = data?.competitorActivity?.strategyShifts || [];
  const visibleShifts = showAllShifts ? shifts : shifts.slice(0, 3);

  const tabCounts = {
    overview: null,
    trends: filteredTrends.length,
    genres: filteredGenres.length,
    competitors: data?.competitorActivity?.activeCompetitorsCount ?? 0,
    newcomers: data?.newcomers?.length ?? 0
  };

  return (
    <div className="atlas-tab-swap flex flex-col gap-5 pb-12">
      {/* CALM HEADER & PROGRESSIVE FILTERS */}
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-[-0.02em] text-text-main">
              Summary
            </h1>

            {coverage && (
              <div className="relative" ref={coverageRef}>
                <button
                  type="button"
                  onClick={() => setCoverageOpen((v) => !v)}
                  title={coverage.comparisonNote}
                  aria-expanded={coverageOpen}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-text-muted hover:text-text-main hover:bg-input-bg/70 transition-colors cursor-pointer"
                >
                  <AtlasIcon name="info" size={13} />
                  <span className="tabular-nums">
                    {coverage.comparisonStatus === "full"
                      ? "Full baseline"
                      : `${coverage.totalSnapshotDays || 0}d history`}
                  </span>
                </button>

                {coverageOpen && (
                  <div className="atlas-popover-in absolute left-0 mt-1.5 w-80 max-w-[calc(100vw-2rem)] bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-3.5 z-40 text-xs flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-text-main">
                        Tracked Catalogue Coverage
                      </span>
                      <Badge
                        tone={
                          coverage.comparisonStatus === "full"
                            ? "success"
                            : coverage.comparisonStatus === "partial"
                            ? "warning"
                            : "neutral"
                        }
                      >
                        {coverage.comparisonStatus === "full"
                          ? "Full baseline"
                          : coverage.comparisonStatus === "partial"
                          ? "Partial"
                          : "Building history"}
                      </Badge>
                    </div>
                    <p className="text-text-muted leading-relaxed">
                      {coverage.comparisonNote}
                    </p>
                    <div className="pt-2 border-t border-border-subtle text-[11px] text-text-muted tabular-nums flex items-center justify-between gap-2">
                      <span>{Number(meta?.trackedCatalogCount || 0).toLocaleString()} titles tracked</span>
                      <span>
                        {meta?.windowStart} to {meta?.windowEnd}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {loading && data && (
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <AtlasIcon name="progress_activity" size={13} className="animate-spin" />
                <span>Updating</span>
              </span>
            )}
          </div>
          <p className="text-[13px] text-text-muted mt-0.5">
            Market intelligence across tracked titles
          </p>
        </div>

        {/* Inline primary controls: Time Window, All/Games/Apps, More filters, Refresh */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <SegmentedPills
            ariaLabel="Time window"
            options={WINDOW_OPTIONS}
            value={windowRange}
            onChange={(val) => handleFilterUpdate(setWindowRange, val)}
          />
          <SegmentedPills
            ariaLabel="Catalogue segment"
            options={SEGMENT_OPTIONS}
            value={appType}
            onChange={(val) => handleFilterUpdate(setAppType, val)}
          />

          <div className="relative" ref={moreFiltersRef}>
            <button
              type="button"
              aria-expanded={moreFiltersOpen}
              onClick={() => setMoreFiltersOpen((v) => !v)}
              className={`h-8 px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                secondaryFilterCount > 0 || moreFiltersOpen
                  ? "bg-primary-container text-on-primary-container border-border-subtle"
                  : "bg-surface-solid border-border-subtle text-text-muted hover:text-text-main hover:bg-input-bg/60"
              }`}
            >
              <AtlasIcon name="tune" size={14} />
              <span>More filters</span>
              {secondaryFilterCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-surface-solid text-text-main text-[11px] font-mono tabular-nums border border-border-subtle">
                  {secondaryFilterCount}
                </span>
              )}
            </button>

            {moreFiltersOpen && (
              <div className="atlas-popover-in absolute right-0 mt-1.5 w-80 max-w-[calc(100vw-2rem)] bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-4 z-40 flex flex-col gap-3.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text-main">Additional Filters</span>
                  {anyNonDefaultFilter && (
                    <button
                      type="button"
                      onClick={handleResetFilters}
                      className="text-link hover:underline font-medium cursor-pointer"
                    >
                      Reset filters
                    </button>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    Date Basis
                  </span>
                  <SegmentedPills
                    ariaLabel="Date basis"
                    options={DATE_BASIS_OPTIONS}
                    value={dateBasis}
                    onChange={(val) => handleFilterUpdate(setDateBasis, val)}
                  />
                  {meta && dateBasis === "release_date" && meta.missingLaunchDateCount > 0 && (
                    <p className="text-[11px] text-text-muted leading-snug pt-0.5">
                      {meta.missingLaunchDateCount.toLocaleString()} tracked titles lack a Play launch date; switch to{" "}
                      <button
                        type="button"
                        onClick={() => handleFilterUpdate(setDateBasis, "first_seen_at")}
                        className="text-link hover:underline font-medium cursor-pointer"
                      >
                        Discovered in Atlas
                      </button>{" "}
                      to include them.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    Competitor / Group Scope
                  </span>
                  <AtlasSelect
                    value={competitorId}
                    onChange={(val) => handleFilterUpdate(setCompetitorId, String(val))}
                    groups={competitorSelectGroups}
                    icon="groups"
                    ariaLabel="Filter by competitor or group"
                    placeholder="All Competitors"
                    searchPlaceholder="Search competitors or groups..."
                    align="right"
                    buttonClassName="w-full"
                  />
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={refreshing}
            onClick={handleRefresh}
            aria-label="Refresh summary data"
            className="h-8 px-2.5 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-muted hover:text-text-main text-xs font-medium transition-colors inline-flex items-center gap-1.5 disabled:opacity-60 cursor-pointer"
          >
            <AtlasIcon
              name="refresh"
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
            <span className="hidden sm:inline">{refreshing ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
      </header>

      {/* Subtle Active Secondary Filter Indicator */}
      {secondaryFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted -mt-2">
          <span>Active filters:</span>
          {dateBasis === "first_seen_at" && (
            <span className="px-2 py-0.5 rounded-md bg-input-bg border border-border-subtle text-text-main">
              Discovered in Atlas
            </span>
          )}
          {selectedCompetitorLabel && (
            <span className="px-2 py-0.5 rounded-md bg-input-bg border border-border-subtle text-text-main">
              {selectedCompetitorLabel}
            </span>
          )}
          <button
            type="button"
            onClick={handleResetFilters}
            className="text-link hover:underline font-medium cursor-pointer"
          >
            Reset filters
          </button>
        </div>
      )}

      {/* Initial Loading or Error */}
      {loading && !data ? (
        <div className="flex flex-col gap-4">
          <TableSkeleton rows={2} cols={4} />
          <TableSkeleton rows={5} cols={4} />
        </div>
      ) : error && !data ? (
        <EmptyState
          icon="warning"
          title="Unable to load market summary"
          description={error}
          actions={
            <button
              type="button"
              onClick={handleRefresh}
              className="h-9 px-3.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-medium transition-colors cursor-pointer"
            >
              Retry
            </button>
          }
        />
      ) : data ? (
        <>
          {/* CLEAN UNDERLINE 5-TAB NAVIGATION (OVERVIEW DEFAULT) */}
          <nav
            aria-label="Summary analysis sections"
            className="flex items-center gap-5 border-b border-border-subtle overflow-x-auto custom-scrollbar -mb-1"
          >
            {SUMMARY_TABS.map((tab) => {
              const active = activeSubTab === tab.id;
              const count = tabCounts[tab.id];
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`pb-2.5 pt-1 text-[13px] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 border-b-2 cursor-pointer ${
                    active
                      ? "border-btn-primary text-text-main font-semibold"
                      : "border-transparent text-text-muted hover:text-text-main font-medium"
                  }`}
                >
                  <span>{tab.label}</span>
                  {count !== null && (
                    <span className="text-[11px] font-mono text-text-muted tabular-nums">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* OVERVIEW DIGEST TAB (DEFAULT) */}
          {activeSubTab === "overview" && (
            <div className="flex flex-col gap-5">
              {/* Compact Low-Emphasis 4-Metric Horizontal Strip */}
              {k && (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 sm:divide-x divide-border-subtle">
                    <div className="px-4 py-3 flex flex-col justify-between min-w-0">
                      <span className="text-xs text-text-muted">New releases</span>
                      <div className="mt-1 flex items-baseline gap-2 min-w-0">
                        <span className="text-lg sm:text-[20px] font-semibold tracking-[-0.02em] text-text-main tabular-nums">
                          {Number(k.newReleasesCount || 0).toLocaleString()}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums truncate">
                          {k.releaseDeltaPct != null
                            ? `${k.releaseDeltaPct > 0 ? `+${k.releaseDeltaPct}%` : `${k.releaseDeltaPct}%`} vs prior`
                            : `${Number(k.prevReleasesCount || 0).toLocaleString()} prior`}
                        </span>
                      </div>
                    </div>

                    <div className="px-4 py-3 flex flex-col justify-between min-w-0">
                      <span className="text-xs text-text-muted">Tracked install growth</span>
                      <div className="mt-1 flex items-baseline gap-2 min-w-0">
                        <span className="text-lg sm:text-[20px] font-semibold tracking-[-0.02em] text-text-main tabular-nums">
                          {formatSignedCompact(k.trackedInstallGrowth || 0)}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums truncate">
                          {k.installVelocityDeltaPct != null
                            ? `${k.installVelocityDeltaPct > 0 ? `+${k.installVelocityDeltaPct}%` : `${k.installVelocityDeltaPct}%`} pace`
                            : `${Number(meta?.activeSnapshotBackedGames || 0).toLocaleString()} tracked`}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setActiveSubTab("trends")}
                      className="px-4 py-3 text-left flex flex-col justify-between min-w-0 hover:bg-input-bg/45 transition-colors cursor-pointer"
                    >
                      <span className="text-xs text-text-muted">Title trends</span>
                      <div className="mt-1 flex items-baseline gap-2 min-w-0">
                        <span className="text-lg sm:text-[20px] font-semibold tracking-[-0.02em] text-text-main tabular-nums">
                          {Number(k.emergingPhrasesCount || 0).toLocaleString()}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums truncate">
                          Up to {Number(k.emergingCompetitorsSpread || 0)} comps
                        </span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveSubTab("newcomers")}
                      className="px-4 py-3 text-left flex flex-col justify-between min-w-0 hover:bg-input-bg/45 transition-colors cursor-pointer"
                    >
                      <span className="text-xs text-text-muted">Breakout newcomers</span>
                      <div className="mt-1 flex items-baseline gap-2 min-w-0">
                        <span className="text-lg sm:text-[20px] font-semibold tracking-[-0.02em] text-text-main tabular-nums">
                          {Number(k.breakoutNewcomersCount || 0).toLocaleString()}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums truncate">
                          Of {Number(k.totalNewcomersEvaluated || 0).toLocaleString()} launches
                        </span>
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* Key Signals (Top 3 highlighted by default; View all toggle) */}
              <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <h2 className="text-sm font-semibold text-text-main">Key signals</h2>
                    <span className="text-xs text-text-muted tabular-nums">
                      {showAllSignals || observations.length <= 3
                        ? `${observations.length} detected`
                        : "3 highlighted"}
                    </span>
                  </div>

                  {observations.length > 3 && (
                    <button
                      type="button"
                      onClick={() => setShowAllSignals((v) => !v)}
                      className="text-xs font-medium text-link hover:underline cursor-pointer shrink-0"
                    >
                      {showAllSignals ? "Show top 3" : `View all (${observations.length})`}
                    </button>
                  )}
                </div>

                {visibleSignals.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-text-muted">
                    No standout market shifts detected in this window. Try expanding the date range or clearing filters.
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle">
                    {visibleSignals.map((obs) => {
                      const evidenceList = Array.isArray(obs.evidenceGames) ? obs.evidenceGames : [];
                      const isEvidenceExpanded = expandedSignalIds.has(obs.id);
                      return (
                        <div
                          key={obs.id}
                          className="px-4 py-4 flex flex-col gap-2.5"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold text-text-main">
                                  {obs.subject}
                                </span>
                                <Badge tone={obs.badgeTone || "neutral"}>{obs.badge}</Badge>
                              </div>
                              <p className="text-[13px] text-text-muted mt-1 leading-relaxed">
                                {obs.summary}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
                            <div>
                              {evidenceList.length > 0 && (
                                <button
                                  type="button"
                                  aria-expanded={isEvidenceExpanded}
                                  onClick={() => toggleSignalEvidence(obs.id)}
                                  className="inline-flex items-center gap-1 text-text-muted hover:text-text-main font-medium transition-colors cursor-pointer"
                                >
                                  <AtlasIcon
                                    name={isEvidenceExpanded ? "expand_less" : "expand_more"}
                                    size={14}
                                  />
                                  <span className="tabular-nums">
                                    {evidenceList.length}{" "}
                                    {evidenceList.length === 1 ? "supporting title" : "supporting titles"}
                                  </span>
                                </button>
                              )}
                            </div>

                            <button
                              type="button"
                              onClick={() => handleObservationNavigate(obs)}
                              className="inline-flex items-center gap-1 font-medium text-link hover:underline cursor-pointer"
                            >
                              <span>{getSignalActionLabel(obs.targetTab)}</span>
                              <AtlasIcon name="arrow_forward" size={13} />
                            </button>
                          </div>

                          {isEvidenceExpanded && evidenceList.length > 0 && (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
                              {evidenceList.map((g) => (
                                <EvidenceGameCard
                                  key={g.package_name}
                                  game={g}
                                  onSelect={setSelectedGame}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* SUB-TAB 1: TITLE TRENDS */}
          {activeSubTab === "trends" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                  <SegmentedPills
                    ariaLabel="Title trend ranking mode"
                    options={[
                      { value: "emerging", label: "Emerging Waves" },
                      { value: "repeated", label: "Most Repeated" }
                    ]}
                    value={trendMode}
                    onChange={setTrendMode}
                  />

                  <div className="relative min-w-[200px] flex-1 sm:w-64 sm:flex-initial">
                    <AtlasIcon
                      name="search"
                      size={14}
                      className="text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    />
                    <input
                      type="text"
                      value={phraseQuery}
                      onChange={(e) => setPhraseQuery(e.target.value)}
                      placeholder="Quick phrase or title lookup..."
                      aria-label="Quick phrase or title lookup"
                      className="w-full h-8 pl-8 pr-7 rounded-lg bg-surface-solid border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-accent"
                    />
                    {phraseQuery && (
                      <button
                        type="button"
                        onClick={() => setPhraseQuery("")}
                        aria-label="Clear lookup"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5 cursor-pointer"
                      >
                        <AtlasIcon name="close" size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Quiet Secondary Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    aria-pressed={showSingleCompetitor}
                    onClick={() => setShowSingleCompetitor((v) => !v)}
                    className={`h-8 px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                      showSingleCompetitor
                        ? "bg-primary-container text-on-primary-container border-border-subtle"
                        : "bg-surface-solid text-text-muted hover:text-text-main border-border-subtle"
                    }`}
                    title="Toggle single-competitor repetitive clusters"
                  >
                    <AtlasIcon name="groups" size={14} />
                    <span className="tabular-nums">
                      Single-comp ({data.titleTrends?.singleCompetitor?.length || 0})
                    </span>
                  </button>

                  {excludedPhrases.length > 0 && (
                    <div className="relative" ref={hiddenPopoverRef}>
                      <button
                        type="button"
                        aria-expanded={showHiddenPopover}
                        onClick={() => setShowHiddenPopover((v) => !v)}
                        title="Manage hidden phrases"
                        aria-label={`Manage ${excludedPhrases.length} hidden phrases`}
                        className="h-8 px-2.5 rounded-lg bg-surface-solid border border-border-subtle text-xs font-medium text-text-muted hover:text-text-main inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <AtlasIcon name="visibility_off" size={14} />
                        <span className="tabular-nums">{excludedPhrases.length}</span>
                      </button>

                      {showHiddenPopover && (
                        <div className="atlas-popover-in absolute right-0 mt-1.5 w-72 max-w-[calc(100vw-2rem)] bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-3 z-30 flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-text-main">
                              Hidden Phrases
                            </span>
                            <button
                              type="button"
                              onClick={handleClearExcluded}
                              className="text-xs text-link hover:underline cursor-pointer"
                            >
                              Restore all
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                            {excludedPhrases.map((phrase) => (
                              <button
                                key={phrase}
                                type="button"
                                onClick={() => handleRestorePhrase(phrase)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-input-bg border border-border-subtle text-xs text-text-main hover:border-accent cursor-pointer"
                                title="Click to restore"
                              >
                                <span>{phrase}</span>
                                <AtlasIcon name="close" size={12} className="text-text-muted" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {filteredTrends.length === 0 ? (
                <EmptyState
                  icon="search_off"
                  title="No multi-competitor title trends match"
                  description={
                    phraseQuery
                      ? `No recurring title phrases matched "${phraseQuery}". Check direct recent titles below or clear your filter.`
                      : `Analyzed ${data.titleTrends?.recentTitlesAnalyzed || 0} recent titles against ${
                          data.titleTrends?.baselineTitlesAnalyzed || 0
                        } earlier titles.`
                  }
                  actions={
                    phraseQuery ? (
                      <button
                        type="button"
                        onClick={() => setPhraseQuery("")}
                        className="h-8 px-3 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-main cursor-pointer"
                      >
                        Clear search
                      </button>
                    ) : null
                  }
                />
              ) : (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[760px]">
                      <thead>
                        <tr className="border-b border-border-subtle bg-input-bg/35 text-xs font-medium text-text-muted">
                          <th className="py-2.5 px-4">Title Phrase</th>
                          <th className="py-2.5 px-3">Spread</th>
                          <th className="py-2.5 px-3">Matches</th>
                          <th className="py-2.5 px-3">7d Pace</th>
                          <th className="py-2.5 px-3">First Seen</th>
                          <th className="py-2.5 px-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle text-xs">
                        {filteredTrends.map((t) => {
                          const isExpanded = expandedTrendKey === t.phrase;
                          const statusMeta = getTrendBadgeMeta(t.status);
                          return (
                            <React.Fragment key={t.phrase}>
                              <tr
                                onClick={() =>
                                  setExpandedTrendKey(isExpanded ? null : t.phrase)
                                }
                                className={`cursor-pointer transition-colors ${
                                  isExpanded ? "bg-input-bg/40" : "hover:bg-input-bg/25"
                                }`}
                              >
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[13px] font-semibold text-text-main">
                                      &ldquo;{t.displayPhrase}&rdquo;
                                    </span>
                                    <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                                    {t.hasRepeatedVariations && (
                                      <span className="text-[11px] text-sem-warning font-medium">
                                        Repeated variations
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.distinctCompetitors} competitors
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    {t.distinctPublishers} accounts
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.matchingGamesCount} recent
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    {t.baselineGamesCount} prior
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.last7dCount} in 7d
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    vs {t.prev7dCount} prior
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main">
                                    {t.firstDetectedDaysAgo}d ago
                                  </div>
                                  <div className="text-[11px] text-text-muted font-mono">
                                    {t.firstDetectedAt}
                                  </div>
                                </td>
                                <td className="py-3 px-4 text-right whitespace-nowrap">
                                  <div
                                    className="inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {typeof onSearchInPlayStore === "function" && (
                                      <button
                                        type="button"
                                        onClick={() => onSearchInPlayStore(t.displayPhrase)}
                                        className="h-7 px-2 rounded-md hover:bg-input-bg text-xs text-text-muted hover:text-text-main inline-flex items-center gap-1 cursor-pointer"
                                        title={`Search "${t.displayPhrase}" in Play Store`}
                                      >
                                        <AtlasIcon name="open_in_new" size={13} />
                                        <span className="hidden xl:inline">Play Store</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => handleHidePhrase(t.phrase)}
                                      className="h-7 w-7 rounded-md hover:bg-input-bg text-text-muted hover:text-text-main inline-flex items-center justify-center cursor-pointer"
                                      aria-label={`Hide ${t.displayPhrase}`}
                                      title="Hide noise phrase"
                                    >
                                      <AtlasIcon name="visibility_off" size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedTrendKey(isExpanded ? null : t.phrase)
                                      }
                                      className="h-7 w-7 rounded-md hover:bg-input-bg text-text-muted hover:text-text-main inline-flex items-center justify-center cursor-pointer"
                                      aria-label={isExpanded ? "Collapse details" : "Expand details"}
                                    >
                                      <AtlasIcon
                                        name={isExpanded ? "expand_less" : "expand_more"}
                                        size={15}
                                      />
                                    </button>
                                  </div>
                                </td>
                              </tr>

                              {isExpanded && (
                                <tr className="bg-input-bg/25">
                                  <td colSpan={6} className="px-4 py-4">
                                    <div className="flex flex-col gap-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          {(t.competitorBreakdown || []).map((c) => (
                                            <span
                                              key={c.competitorName}
                                              className="px-2 py-0.5 rounded-md bg-surface-solid border border-border-subtle text-xs text-text-main tabular-nums"
                                            >
                                              {c.competitorName} ({c.titleCount})
                                            </span>
                                          ))}
                                        </div>
                                        <div className="text-xs text-text-muted tabular-nums">
                                          Combined tracked installs:{" "}
                                          <span className="font-semibold text-text-main">
                                            {formatCompact(t.combinedInstalls)}
                                          </span>
                                          {" · "}Daily pace:{" "}
                                          <span className="font-semibold text-text-main">
                                            +{formatCompact(t.combinedDailyDelta)}/d
                                          </span>
                                        </div>
                                      </div>

                                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                                        {(t.matchingGames || []).map((g) => (
                                          <EvidenceGameCard
                                            key={g.package_name}
                                            game={g}
                                            onSelect={setSelectedGame}
                                          />
                                        ))}
                                      </div>

                                      {Array.isArray(t.baselineExamples) &&
                                        t.baselineExamples.length > 0 && (
                                          <div className="pt-2 border-t border-border-subtle flex flex-wrap items-center gap-1.5">
                                            <span className="text-xs text-text-muted mr-1">
                                              Prior baseline examples:
                                            </span>
                                            {t.baselineExamples.map((g) => (
                                              <GameChipButton
                                                key={g.package_name}
                                                game={g}
                                                onSelect={setSelectedGame}
                                                extraLabel={g.release_date?.slice(0, 10)}
                                              />
                                            ))}
                                          </div>
                                        )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {showSingleCompetitor && filteredSingleComp.length > 0 && (
                <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle bg-input-bg/30">
                    <h3 className="text-xs font-semibold text-text-main">
                      Single-Competitor Repetitive Clusters
                    </h3>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      Terms repeated across multiple titles by a single competitor only (excluded from cross-market trends).
                    </p>
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {filteredSingleComp.map((t) => (
                      <div key={t.phrase} className="px-4 py-3 flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-text-main">
                              &ldquo;{t.displayPhrase}&rdquo;
                            </span>
                            <span className="text-xs text-text-muted tabular-nums">
                              {t.competitorBreakdown?.[0]?.competitorName || "1 competitor"} ·{" "}
                              {t.matchingGamesCount} titles
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleHidePhrase(t.phrase)}
                            className="text-xs text-text-muted hover:text-text-main inline-flex items-center gap-1 cursor-pointer"
                          >
                            <AtlasIcon name="visibility_off" size={13} />
                            <span>Hide</span>
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {(t.matchingGames || []).slice(0, 5).map((g) => (
                            <GameChipButton
                              key={g.package_name}
                              game={g}
                              onSelect={setSelectedGame}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {phraseQuery.trim().length >= 2 && (
                <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text-main">
                      Recent Titles Matching &ldquo;{phraseQuery.trim()}&rdquo;
                    </span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {directRecentTitleMatches.length} shown
                    </span>
                  </div>
                  {directRecentTitleMatches.length === 0 ? (
                    <div className="px-4 py-5 text-xs text-text-muted">
                      No recent window titles matched &ldquo;{phraseQuery.trim()}&rdquo;.
                    </div>
                  ) : (
                    <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {directRecentTitleMatches.map((g) => (
                        <EvidenceGameCard
                          key={g.package_name}
                          game={g}
                          onSelect={setSelectedGame}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* SUB-TAB 2: GENRE GROWTH */}
          {activeSubTab === "genres" && (
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <SegmentedPills
                  ariaLabel="Genre grouping mode"
                  options={[
                    { value: "primary", label: "Primary Genres" },
                    { value: "subgenres", label: "Sub-Genres & Mechanics" }
                  ]}
                  value={genreMode}
                  onChange={(val) => {
                    setGenreMode(val);
                    setExpandedGenreKey(null);
                  }}
                />

                <AtlasSelect
                  value={genreSignalFilter}
                  onChange={(val) => setGenreSignalFilter(String(val))}
                  options={GENRE_SIGNAL_OPTIONS}
                  searchable={false}
                  ariaLabel="Filter genres by signal"
                  align="right"
                  buttonClassName="min-w-[160px]"
                />
              </div>

              {coverage && coverage.comparisonStatus !== "full" && (
                <p className="text-xs text-text-muted px-0.5">
                  {coverage.comparisonNote} Period velocity change stays blank (&mdash;) without multi-day scans in both windows.
                </p>
              )}

              {filteredGenres.length === 0 ? (
                <EmptyState
                  icon="filter_alt_off"
                  title="No genres match this signal filter"
                  description="Switch back to All Signals or toggle between Primary Genres and Sub-Genres."
                  actions={
                    <button
                      type="button"
                      onClick={() => setGenreSignalFilter("all")}
                      className="h-8 px-3 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-main cursor-pointer"
                    >
                      Show all signals
                    </button>
                  }
                />
              ) : (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[860px]">
                      <thead>
                        <tr className="border-b border-border-subtle bg-input-bg/35 text-xs font-medium text-text-muted">
                          <th className="py-2.5 px-4">Genre</th>
                          <th className="py-2.5 px-3 text-right">Tracked Install Gain</th>
                          <th className="py-2.5 px-3 text-right">Median / Game / Day</th>
                          <th className="py-2.5 px-3">Breadth (Growing / Declining)</th>
                          <th className="py-2.5 px-3 text-right">Period Velocity &Delta;</th>
                          <th className="py-2.5 px-4 text-right">New Releases</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle text-xs">
                        {filteredGenres.map((g) => {
                          const isExpanded = expandedGenreKey === g.genre;
                          const sigMeta = getGenreSignalMeta(g.signal);
                          const velClass =
                            g.velocityChangePct == null
                              ? "text-text-muted"
                              : g.velocityChangePct >= 10
                              ? "text-sem-success"
                              : g.velocityChangePct <= -10
                              ? "text-sem-danger"
                              : "text-text-main";

                          return (
                            <React.Fragment key={`${g.mode}:${g.genre}`}>
                              <tr
                                onClick={() =>
                                  setExpandedGenreKey(isExpanded ? null : g.genre)
                                }
                                className={`cursor-pointer transition-colors ${
                                  isExpanded ? "bg-input-bg/40" : "hover:bg-input-bg/25"
                                }`}
                              >
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <AtlasIcon
                                      name={isExpanded ? "expand_less" : "expand_more"}
                                      size={14}
                                      className="text-text-muted shrink-0"
                                    />
                                    <span className="text-[13px] font-semibold text-text-main">
                                      {g.genre}
                                    </span>
                                    <Badge tone={sigMeta.tone}>{sigMeta.label}</Badge>
                                  </div>
                                  <div className="text-[11px] text-text-muted pl-5 mt-0.5 tabular-nums">
                                    {g.trackedGamesCount} tracked · {g.snapshotBackedCount} multi-scan
                                  </div>
                                </td>
                                <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-medium text-text-main">
                                  {formatSignedCompact(g.totalInstallGrowth)}
                                </td>
                                <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                                  <span className="font-semibold text-text-main">
                                    {formatCompact(g.medianDailyGrowthPerGame)}/d
                                  </span>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sem-success font-medium">
                                      {g.growingGamesCount} up
                                    </span>
                                    <span className="text-text-muted">/</span>
                                    <span className="text-sem-danger font-medium">
                                      {g.decliningGamesCount} down
                                    </span>
                                    <span className="text-[11px] text-text-muted">
                                      ({g.growingSharePct}%)
                                    </span>
                                  </div>
                                </td>
                                <td className={`py-3 px-3 text-right tabular-nums whitespace-nowrap font-semibold ${velClass}`}>
                                  {g.velocityChangePct != null
                                    ? `${g.velocityChangePct > 0 ? `+${g.velocityChangePct}%` : `${g.velocityChangePct}%`}`
                                    : "—"}
                                </td>
                                <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {g.newReleasesCount} new
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    vs {g.prevReleasesCount} prior · {g.distinctCompetitorsShipping} comps
                                  </div>
                                </td>
                              </tr>

                              {isExpanded && (
                                <tr className="bg-input-bg/25">
                                  <td colSpan={6} className="px-4 py-4">
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                      <div className="flex flex-col gap-2">
                                        <h4 className="text-xs font-semibold text-text-main">
                                          Top Growing Titles in {g.genre}
                                        </h4>
                                        {(g.topGrowingGames || []).length === 0 ? (
                                          <div className="text-xs text-text-muted">
                                            No snapshot velocity data yet for this genre.
                                          </div>
                                        ) : (
                                          <div className="flex flex-col gap-1.5">
                                            {g.topGrowingGames.map((title) => (
                                              <EvidenceGameCard
                                                key={title.package_name}
                                                game={title}
                                                onSelect={setSelectedGame}
                                                metricNote={
                                                  title.genreDailyRate > 0
                                                    ? `+${formatCompact(title.genreDailyRate)}/d`
                                                    : null
                                                }
                                              />
                                            ))}
                                          </div>
                                        )}
                                      </div>

                                      <div className="flex flex-col gap-2">
                                        <h4 className="text-xs font-semibold text-text-main">
                                          Newest Releases in {g.genre}
                                        </h4>
                                        {(g.newestReleases || []).length === 0 ? (
                                          <div className="text-xs text-text-muted">
                                            No recent launches in the selected window.
                                          </div>
                                        ) : (
                                          <div className="flex flex-col gap-1.5">
                                            {g.newestReleases.map((title) => (
                                              <EvidenceGameCard
                                                key={title.package_name}
                                                game={title}
                                                onSelect={setSelectedGame}
                                              />
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SUB-TAB 3: COMPETITORS */}
          {activeSubTab === "competitors" && (
            <div className="flex flex-col gap-4">
              {shifts.length > 0 && (
                <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-xs font-semibold text-text-main">
                        Strategy Shifts
                      </h3>
                      <span className="text-xs text-text-muted tabular-nums">
                        {showAllShifts || shifts.length <= 3
                          ? `${shifts.length} detected`
                          : `Top 3 of ${shifts.length}`}
                      </span>
                    </div>
                    {shifts.length > 3 && (
                      <button
                        type="button"
                        onClick={() => setShowAllShifts((v) => !v)}
                        className="text-xs font-medium text-link hover:underline cursor-pointer"
                      >
                        {showAllShifts ? "Show top 3" : `View all (${shifts.length})`}
                      </button>
                    )}
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {visibleShifts.map((shift, idx) => {
                      const shiftTone =
                        shift.type === "cross_category"
                          ? "warning"
                          : shift.type === "new_genre"
                          ? "accent"
                          : "neutral";
                      const shiftKey = `${shift.competitorKey}:${shift.type}:${idx}`;
                      const shiftExpanded = expandedShiftKeys.has(shiftKey);
                      const evidence = Array.isArray(shift.evidenceGames) ? shift.evidenceGames : [];
                      return (
                        <div key={shiftKey} className="px-4 py-3 flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[13px] font-semibold text-text-main">
                                {shift.competitorName}
                              </span>
                              <Badge tone={shiftTone}>{shift.badge}</Badge>
                            </div>
                            {evidence.length > 0 && (
                              <button
                                type="button"
                                aria-expanded={shiftExpanded}
                                onClick={() => toggleShiftEvidence(shiftKey)}
                                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-main font-medium cursor-pointer"
                              >
                                <AtlasIcon
                                  name={shiftExpanded ? "expand_less" : "expand_more"}
                                  size={14}
                                />
                                <span className="tabular-nums">
                                  {evidence.length} {evidence.length === 1 ? "title" : "titles"}
                                </span>
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-text-muted">{shift.summary}</p>
                          {shiftExpanded && evidence.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                              {evidence.map((g) => (
                                <GameChipButton
                                  key={g.package_name}
                                  game={g}
                                  onSelect={setSelectedGame}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {(data.competitorActivity?.activeCompetitors || []).length === 0 ? (
                <EmptyState
                  icon="groups"
                  title="No competitor releases in this window"
                  description="Try expanding the time window or switching Date Basis in More filters."
                />
              ) : (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[820px]">
                      <thead>
                        <tr className="border-b border-border-subtle bg-input-bg/35 text-xs font-medium text-text-muted">
                          <th className="py-2.5 px-4">Competitor</th>
                          <th className="py-2.5 px-3 text-right">Recent Releases</th>
                          <th className="py-2.5 px-3 text-right">Active Accounts</th>
                          <th className="py-2.5 px-3">Top Genres</th>
                          <th className="py-2.5 px-3">Monetization</th>
                          <th className="py-2.5 px-4 text-right">Active Ads</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle text-xs">
                        {data.competitorActivity.activeCompetitors.map((comp) => {
                          const isExpanded =
                            expandedCompetitorKey === comp.key ||
                            expandedCompetitorKey === comp.competitorName;
                          return (
                            <React.Fragment key={comp.key}>
                              <tr
                                onClick={() =>
                                  setExpandedCompetitorKey(isExpanded ? null : comp.key)
                                }
                                className={`cursor-pointer transition-colors ${
                                  isExpanded ? "bg-input-bg/40" : "hover:bg-input-bg/25"
                                }`}
                              >
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <AtlasIcon
                                      name={isExpanded ? "expand_less" : "expand_more"}
                                      size={14}
                                      className="text-text-muted shrink-0"
                                    />
                                    <span className="text-[13px] font-semibold text-text-main">
                                      {comp.competitorName}
                                    </span>
                                    {(comp.shifts || []).slice(0, 1).map((s, sIdx) => (
                                      <Badge
                                        key={sIdx}
                                        tone={s.type === "cross_category" ? "warning" : "accent"}
                                      >
                                        {s.badge}
                                      </Badge>
                                    ))}
                                  </div>
                                  <div className="text-[11px] text-text-muted pl-5 mt-0.5 tabular-nums">
                                    {comp.totalCatalogCount} tracked titles total
                                  </div>
                                </td>
                                <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                                  <div className="font-semibold text-text-main">
                                    {comp.recentReleaseCount}
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    vs {comp.prevReleasesCount} prior
                                    {comp.releaseDeltaPct != null
                                      ? ` (${comp.releaseDeltaPct > 0 ? `+${comp.releaseDeltaPct}%` : `${comp.releaseDeltaPct}%`})`
                                      : ""}
                                  </div>
                                </td>
                                <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap text-text-main">
                                  {comp.activePublisherAccounts} / {comp.totalPublisherAccounts}
                                </td>
                                <td className="py-3 px-3">
                                  <div className="flex flex-wrap gap-1">
                                    {(comp.topGenres || []).slice(0, 3).map((tg) => (
                                      <span
                                        key={tg.genre}
                                        className="px-2 py-0.5 rounded-md bg-input-bg/70 border border-border-subtle text-xs text-text-main tabular-nums"
                                      >
                                        {tg.genre} · {tg.count}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap text-text-muted">
                                  {comp.freeCount} Free / {comp.paidCount} Paid
                                </td>
                                <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap font-medium text-text-main">
                                  {comp.campaignCount}
                                </td>
                              </tr>

                              {isExpanded && (
                                <tr className="bg-input-bg/25">
                                  <td colSpan={6} className="px-4 py-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                                      {(comp.recentReleases || []).map((g) => (
                                        <EvidenceGameCard
                                          key={g.package_name}
                                          game={g}
                                          onSelect={setSelectedGame}
                                        />
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SUB-TAB 4: NEWCOMERS */}
          {activeSubTab === "newcomers" && (
            <div className="flex flex-col gap-4">
              {(data.newcomers || []).length === 0 ? (
                <EmptyState
                  icon="sports_esports"
                  title="No high-velocity newcomers detected"
                  description="Try expanding the time window to 30d or 90d, or clearing competitor filters."
                />
              ) : (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[780px]">
                      <thead>
                        <tr className="border-b border-border-subtle bg-input-bg/35 text-xs font-medium text-text-muted">
                          <th className="py-2.5 px-4">Title</th>
                          <th className="py-2.5 px-3 whitespace-nowrap">Released</th>
                          <th className="py-2.5 px-3 text-right whitespace-nowrap">
                            Total Installs
                          </th>
                          <th className="py-2.5 px-3 text-right whitespace-nowrap">
                            Installs / Day
                          </th>
                          <th className="py-2.5 px-3 text-right whitespace-nowrap">
                            Daily Velocity
                          </th>
                          <th className="py-2.5 px-4 text-right whitespace-nowrap">
                            Traction vs Median
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle text-xs">
                        {data.newcomers.map((item) => {
                          const isHighlighted = highlightedNewcomerPkg === item.package_name;
                          const multTone =
                            item.tractionMultiple >= 5
                              ? "accent"
                              : item.tractionMultiple >= 2
                              ? "success"
                              : "neutral";
                          return (
                            <tr
                              key={item.package_name}
                              onClick={() => setSelectedGame(item)}
                              className={`cursor-pointer transition-colors ${
                                isHighlighted
                                  ? "bg-primary-container/25 hover:bg-primary-container/35"
                                  : "hover:bg-input-bg/30"
                              }`}
                            >
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  {item.icon ? (
                                    <img
                                      src={item.icon}
                                      alt=""
                                      loading="lazy"
                                      className="w-9 h-9 rounded-lg object-cover shrink-0 border border-border-subtle"
                                    />
                                  ) : (
                                    <div className="w-9 h-9 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center shrink-0 text-text-muted">
                                      <AtlasIcon name="sports_esports" size={16} />
                                    </div>
                                  )}
                                  <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-text-main truncate max-w-[260px]">
                                      {item.title || item.package_name}
                                    </div>
                                    <div className="text-[11px] text-text-muted truncate max-w-[260px]">
                                      {[item.primaryGenre, item.competitor_name || item.publisher_name]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                <div className="text-text-main font-mono">
                                  {item.effectiveDate}
                                </div>
                                <div className="text-[11px] text-text-muted">
                                  {item.daysLive}d live
                                </div>
                              </td>
                              <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-medium text-text-main">
                                {formatCompact(item.real_installs)}
                              </td>
                              <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-semibold text-sem-success">
                                {formatCompact(item.installsPerDaySinceLaunch)}/d
                              </td>
                              <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap text-text-main">
                                {item.dailyVelocity > 0
                                  ? `+${formatCompact(item.dailyVelocity)}/d`
                                  : "—"}
                              </td>
                              <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap">
                                <Badge tone={multTone}>{item.tractionMultiple}x median</Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}

      {selectedGame && (
        <UniversalGameDetailDrawer
          game={selectedGame}
          onClose={() => setSelectedGame(null)}
          onSelectGame={(g) => setSelectedGame(g)}
          onOpenCountryScan={onOpenCountryScan}
          allGames={drawerPool}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}
