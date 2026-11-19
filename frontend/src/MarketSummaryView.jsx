import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { API_BASE } from "./apiConfig";
import AtlasSelect from "./AtlasSelect";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";
import { AtlasFeedback } from "./AtlasFeedback.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import {
  Badge,
  EmptyState,
  KpiStrip,
  PageHeader,
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

const SUB_TABS = [
  { id: "trends", label: "Title Trends", icon: "trending_up" },
  { id: "genres", label: "Genre Growth", icon: "layers" },
  { id: "competitors", label: "Competitors", icon: "groups" },
  { id: "newcomers", label: "Newcomers", icon: "sports_esports" }
];

const GENRE_SIGNAL_FILTERS = [
  { value: "all", label: "All Signals" },
  { value: "hot_wave", label: "Hot Wave" },
  { value: "rising_demand", label: "Rising" },
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

function getCoverageBadgeMeta(status) {
  if (status === "full") return { tone: "success", label: "Full baseline" };
  if (status === "partial") return { tone: "warning", label: "Partial baseline" };
  return { tone: "neutral", label: "Growing history" };
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
          <div className="text-xs font-medium text-text-main truncate group-hover:text-accent transition-colors">
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

  const [activeSubTab, setActiveSubTab] = useState("trends");
  const [trendMode, setTrendMode] = useState("emerging"); // 'emerging' | 'repeated'
  const [showSingleCompetitor, setShowSingleCompetitor] = useState(false);
  const [phraseQuery, setPhraseQuery] = useState("");
  const [excludedPhrases, setExcludedPhrases] = useState(loadStoredExcludedPhrases);
  const [showHiddenPopover, setShowHiddenPopover] = useState(false);
  const [expandedTrendKey, setExpandedTrendKey] = useState(null);

  const [genreMode, setGenreMode] = useState("primary"); // 'primary' | 'subgenres'
  const [genreSignalFilter, setGenreSignalFilter] = useState("all");
  const [expandedGenreKey, setExpandedGenreKey] = useState(null);

  const [expandedCompetitorKey, setExpandedCompetitorKey] = useState(null);
  const [highlightedNewcomerPkg, setHighlightedNewcomerPkg] = useState(null);

  const [selectedGame, setSelectedGame] = useState(null);
  const freshNextRef = useRef(false);

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

  const handleFilterUpdate = useCallback((setter, nextVal) => {
    setError(null);
    setLoading(true);
    setter(nextVal);
  }, []);

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
      if (!normalized) return;
      if (excludedPhrases.includes(normalized)) return;
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

  const handleObservationSelect = useCallback((obs) => {
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

  const kpiItems = useMemo(() => {
    if (!data?.kpis) return [];
    const k = data.kpis;
    const m = data.meta || {};
    const relTone =
      k.releaseDeltaPct == null
        ? "neutral"
        : k.releaseDeltaPct >= 10
        ? "success"
        : k.releaseDeltaPct <= -15
        ? "danger"
        : "neutral";
    const velTone =
      k.installVelocityDeltaPct == null
        ? "neutral"
        : k.installVelocityDeltaPct >= 10
        ? "success"
        : k.installVelocityDeltaPct <= -10
        ? "danger"
        : "neutral";

    return [
      {
        key: "releases",
        label: "New Releases",
        value: Number(k.newReleasesCount || 0).toLocaleString(),
        badge:
          k.releaseDeltaPct != null ? (
            <Badge tone={relTone}>
              {k.releaseDeltaPct > 0 ? `+${k.releaseDeltaPct}%` : `${k.releaseDeltaPct}%`}
            </Badge>
          ) : null,
        note: `${Number(k.prevReleasesCount || 0).toLocaleString()} in prior ${m.windowDays || 30}d`
      },
      {
        key: "installGrowth",
        label: "Tracked Install Growth",
        value: formatSignedCompact(k.trackedInstallGrowth || 0),
        badge: (
          <Badge tone={velTone}>
            {k.installVelocityDeltaPct != null
              ? `${k.installVelocityDeltaPct > 0 ? `+${k.installVelocityDeltaPct}%` : `${k.installVelocityDeltaPct}%`} pace`
              : "Baseline building"}
          </Badge>
        ),
        note: `${Number(m.activeSnapshotBackedGames || 0).toLocaleString()} multi-scan titles`
      },
      {
        key: "trends",
        label: "Emerging Title Trends",
        value: Number(k.emergingPhrasesCount || 0).toLocaleString(),
        note: `Across up to ${Number(k.emergingCompetitorsSpread || 0)} competitors`,
        onClick: () => setActiveSubTab("trends")
      },
      {
        key: "newcomers",
        label: "Breakout Newcomers",
        value: Number(k.breakoutNewcomersCount || 0).toLocaleString(),
        note: `Of ${Number(k.totalNewcomersEvaluated || 0).toLocaleString()} recent launches`,
        onClick: () => setActiveSubTab("newcomers")
      }
    ];
  }, [data]);

  const meta = data?.meta;
  const coverage = meta?.coverage;
  const coverageBadge = getCoverageBadgeMeta(coverage?.comparisonStatus);

  const subTabCounts = {
    trends: filteredTrends.length,
    genres: filteredGenres.length,
    competitors: data?.competitorActivity?.activeCompetitorsCount ?? 0,
    newcomers: data?.newcomers?.length ?? 0
  };

  return (
    <div className="atlas-tab-swap flex flex-col gap-5 pb-12">
      <PageHeader
        title="Summary"
        subtitle={
          meta
            ? `Tracked Play Store catalogue signals across ${Number(
                meta.trackedCatalogCount || 0
              ).toLocaleString()} titles (${meta.windowStart} to ${meta.windowEnd}).`
            : "Market movement across Atlas's tracked Play Store catalogue."
        }
        badge={
          coverage ? (
            <Badge tone={coverageBadge.tone} title={coverage.comparisonNote}>
              <AtlasIcon
                name={
                  coverage.comparisonStatus === "full"
                    ? "check_circle"
                    : coverage.comparisonStatus === "partial"
                    ? "warning"
                    : "info"
                }
                size={12}
              />
              {coverageBadge.label}
            </Badge>
          ) : null
        }
        actions={
          <button
            type="button"
            disabled={refreshing}
            onClick={handleRefresh}
            className="h-9 px-3.5 rounded-lg bg-surface-solid border border-border-subtle hover:bg-input-bg text-text-main text-xs font-medium transition-colors inline-flex items-center gap-1.5 disabled:opacity-60 cursor-pointer"
          >
            <AtlasIcon
              name="refresh"
              size={14}
              className={`text-text-muted ${refreshing ? "animate-spin" : ""}`}
            />
            <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        }
      />

      {/* Inline Filter Bar */}
      <div className="bg-surface-solid border border-border-subtle rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
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
          <SegmentedPills
            ariaLabel="Date basis"
            options={DATE_BASIS_OPTIONS}
            value={dateBasis}
            onChange={(val) => handleFilterUpdate(setDateBasis, val)}
          />
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {loading && data && (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <AtlasIcon name="progress_activity" size={14} className="animate-spin" />
              <span>Updating...</span>
            </span>
          )}
          <AtlasSelect
            value={competitorId}
            onChange={(val) => handleFilterUpdate(setCompetitorId, String(val))}
            groups={competitorSelectGroups}
            icon="groups"
            ariaLabel="Filter by competitor or group"
            placeholder="All Competitors"
            searchPlaceholder="Search competitors or groups..."
            align="right"
            buttonClassName="min-w-[180px]"
          />
        </div>
      </div>

      {meta && dateBasis === "release_date" && meta.missingLaunchDateCount > 0 && (
        <div className="text-xs text-text-muted -mt-2.5 px-1 flex items-center gap-1.5">
          <AtlasIcon name="info" size={13} className="shrink-0" />
          <span>
            {meta.missingLaunchDateCount.toLocaleString()} tracked titles are missing a Play launch date; switch to{" "}
            <button
              type="button"
              onClick={() => handleFilterUpdate(setDateBasis, "first_seen_at")}
              className="text-accent hover:underline font-medium cursor-pointer"
            >
              Discovered in Atlas
            </button>{" "}
            to inspect everything newly scanned into Atlas.
          </span>
        </div>
      )}

      {/* Initial Loading or Error */}
      {loading && !data ? (
        <div className="flex flex-col gap-4">
          <TableSkeleton rows={2} cols={4} />
          <TableSkeleton rows={6} cols={5} />
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
          <KpiStrip items={kpiItems} />

          {/* Market Observations */}
          {Array.isArray(data.observations) && data.observations.length > 0 && (
            <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <AtlasIcon name="monitoring" size={16} className="text-text-muted shrink-0" />
                  <h2 className="text-sm font-semibold text-text-main truncate">
                    Market Observations
                  </h2>
                </div>
                <span className="text-xs text-text-muted hidden sm:inline">
                  Click a signal to inspect supporting titles
                </span>
              </div>

              <div className="divide-y divide-border-subtle">
                {data.observations.map((obs) => (
                  <div
                    key={obs.id}
                    className="px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:bg-input-bg/35 transition-colors"
                  >
                    <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge tone={obs.badgeTone || "neutral"}>{obs.badge}</Badge>
                        <span className="text-[13px] font-semibold text-text-main">
                          {obs.subject}
                        </span>
                        <span className="text-xs text-text-muted">{obs.summary}</span>
                      </div>

                      {Array.isArray(obs.evidenceGames) && obs.evidenceGames.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {obs.evidenceGames.slice(0, 3).map((g) => (
                            <GameChipButton
                              key={g.package_name}
                              game={g}
                              onSelect={setSelectedGame}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleObservationSelect(obs)}
                      className="h-8 px-3 rounded-lg bg-input-bg/70 hover:bg-input-bg border border-border-subtle text-xs font-medium text-text-main inline-flex items-center gap-1 shrink-0 self-start lg:self-center transition-colors cursor-pointer"
                    >
                      <span>Inspect</span>
                      <AtlasIcon name="chevron_right" size={14} className="text-text-muted" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 4 Sub-Tab Bar */}
          <div className="flex items-center gap-1.5 border-b border-border-subtle pb-2 overflow-x-auto custom-scrollbar">
            {SUB_TABS.map((tab) => {
              const active = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`px-3.5 h-9 rounded-lg text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? "bg-primary-container text-on-primary-container border border-border-subtle"
                      : "text-text-muted hover:text-text-main hover:bg-input-bg/60 border border-transparent"
                  }`}
                >
                  <AtlasIcon name={tab.icon} size={15} />
                  <span>{tab.label}</span>
                  <span className="text-[11px] font-mono opacity-80 tabular-nums">
                    {subTabCounts[tab.id]}
                  </span>
                </button>
              );
            })}
          </div>

          {/* SUB-TAB 1: TITLE TRENDS */}
          {activeSubTab === "trends" && (
            <div className="flex flex-col gap-4">
              <div className="bg-surface-solid border border-border-subtle rounded-xl p-3 flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedPills
                    ariaLabel="Title trend ranking mode"
                    options={[
                      { value: "emerging", label: "Emerging Waves" },
                      { value: "repeated", label: "Most Repeated" }
                    ]}
                    value={trendMode}
                    onChange={setTrendMode}
                  />

                  <button
                    type="button"
                    aria-pressed={showSingleCompetitor}
                    onClick={() => setShowSingleCompetitor((v) => !v)}
                    className={`h-8 px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                      showSingleCompetitor
                        ? "bg-primary-container text-on-primary-container border-border-subtle"
                        : "bg-input-bg/60 text-text-muted hover:text-text-main border-border-subtle"
                    }`}
                  >
                    <AtlasIcon name="groups" size={14} />
                    <span>
                      Single-competitor clusters ({data.titleTrends?.singleCompetitor?.length || 0})
                    </span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 flex-1 sm:flex-initial justify-end">
                  <div className="relative min-w-[220px] flex-1 sm:w-64 sm:flex-initial">
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
                      className="w-full h-8 pl-8 pr-7 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-accent"
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

                  {excludedPhrases.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowHiddenPopover((v) => !v)}
                        className="h-8 px-2.5 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-muted hover:text-text-main inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <AtlasIcon name="visibility" size={14} />
                        <span>Hidden ({excludedPhrases.length})</span>
                      </button>

                      {showHiddenPopover && (
                        <div className="absolute right-0 mt-1.5 w-72 bg-surface-solid border border-border-subtle rounded-xl shadow-lg p-3 z-30 flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-text-main">
                              Hidden Phrases
                            </span>
                            <button
                              type="button"
                              onClick={handleClearExcluded}
                              className="text-xs text-accent hover:underline cursor-pointer"
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
                        <tr className="border-b border-border-subtle bg-input-bg/40 text-xs font-medium text-text-muted">
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
                                  isExpanded ? "bg-input-bg/45" : "hover:bg-input-bg/30"
                                }`}
                              >
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[13px] font-semibold text-text-main">
                                      &ldquo;{t.displayPhrase}&rdquo;
                                    </span>
                                    <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                                    {t.hasRepeatedVariations && (
                                      <Badge tone="warning">Repeated variations</Badge>
                                    )}
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.distinctCompetitors} competitors
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    {t.distinctPublishers} publisher accounts
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.matchingGamesCount} recent
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    {t.baselineGamesCount} prior baseline
                                  </div>
                                </td>
                                <td className="py-3 px-3 tabular-nums whitespace-nowrap">
                                  <div className="text-text-main font-medium">
                                    {t.last7dCount} in last 7d
                                  </div>
                                  <div className="text-[11px] text-text-muted">
                                    vs {t.prev7dCount} prior 7d
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
                                            <Badge key={c.competitorName} tone="neutral">
                                              {c.competitorName} ({c.titleCount})
                                            </Badge>
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

              {/* Optional Separate Single-Competitor Clusters Panel */}
              {showSingleCompetitor && filteredSingleComp.length > 0 && (
                <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2 bg-input-bg/35">
                    <div>
                      <h3 className="text-xs font-semibold text-text-main">
                        Single-Competitor Repetitive Clusters
                      </h3>
                      <p className="text-[11px] text-text-muted mt-0.5">
                        Terms repeated across multiple titles by a single competitor only (excluded from cross-market trends).
                      </p>
                    </div>
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {filteredSingleComp.map((t) => (
                      <div
                        key={t.phrase}
                        className="px-4 py-3 flex flex-col gap-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-text-main">
                              &ldquo;{t.displayPhrase}&rdquo;
                            </span>
                            <Badge tone="warning">
                              {t.competitorBreakdown?.[0]?.competitorName || "1 competitor"} ·{" "}
                              {t.matchingGamesCount} titles
                            </Badge>
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

              {/* Direct Recent Title Lookup Results (catches 1-off emerging terms like Gugu Gaga before reaching 2+ count) */}
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
            <div className="flex flex-col gap-4">
              {coverage && coverage.comparisonStatus !== "full" && (
                <div className="bg-surface-solid border border-border-subtle rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs">
                  <AtlasIcon name="info" size={15} className="text-text-muted shrink-0 mt-0.5" />
                  <div className="text-text-muted">
                    <span className="font-semibold text-text-main">Tracked-catalogue baseline note: </span>
                    {coverage.comparisonNote} Period velocity change stays blank (&mdash;) for genres without matched multi-day scans in both windows.
                  </div>
                </div>
              )}

              <div className="bg-surface-solid border border-border-subtle rounded-xl p-3 flex flex-wrap items-center justify-between gap-2.5">
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

                <div className="flex flex-wrap items-center gap-1.5">
                  {GENRE_SIGNAL_FILTERS.map((sig) => {
                    const active = genreSignalFilter === sig.value;
                    return (
                      <button
                        key={sig.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setGenreSignalFilter(sig.value)}
                        className={`h-7 px-2.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                          active
                            ? "bg-primary-container text-on-primary-container border-border-subtle"
                            : "bg-input-bg/60 text-text-muted hover:text-text-main border-border-subtle"
                        }`}
                      >
                        {sig.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {filteredGenres.length === 0 ? (
                <EmptyState
                  icon="filter_alt_off"
                  title="No genres match this signal filter"
                  description="Try switching back to All Signals or switching between Primary Genres and Sub-Genres."
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
                        <tr className="border-b border-border-subtle bg-input-bg/40 text-xs font-medium text-text-muted">
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
                                  isExpanded ? "bg-input-bg/45" : "hover:bg-input-bg/30"
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
              {Array.isArray(data.competitorActivity?.strategyShifts) &&
                data.competitorActivity.strategyShifts.length > 0 && (
                  <section className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-text-main">
                        Competitor Strategy Shifts
                      </h3>
                      <span className="text-xs text-text-muted tabular-nums">
                        {data.competitorActivity.strategyShifts.length} detected
                      </span>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:gap-px bg-border-subtle">
                      {data.competitorActivity.strategyShifts.map((shift, idx) => {
                        const shiftTone =
                          shift.type === "cross_category"
                            ? "warning"
                            : shift.type === "new_genre"
                            ? "accent"
                            : "neutral";
                        return (
                          <div
                            key={`${shift.competitorKey}:${shift.type}:${idx}`}
                            className="bg-surface-solid p-3.5 flex flex-col gap-2"
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="text-[13px] font-semibold text-text-main">
                                {shift.competitorName}
                              </span>
                              <Badge tone={shiftTone}>{shift.badge}</Badge>
                            </div>
                            <p className="text-xs text-text-muted">{shift.summary}</p>
                            {Array.isArray(shift.evidenceGames) && shift.evidenceGames.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-0.5">
                                {shift.evidenceGames.slice(0, 4).map((g) => (
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
                  description="Try expanding the time window or switching Date Basis to Discovered in Atlas."
                />
              ) : (
                <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[820px]">
                      <thead>
                        <tr className="border-b border-border-subtle bg-input-bg/40 text-xs font-medium text-text-muted">
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
                                  isExpanded ? "bg-input-bg/45" : "hover:bg-input-bg/30"
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
                                      <Badge key={tg.genre} tone="neutral">
                                        {tg.genre} · {tg.count}
                                      </Badge>
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
                        <tr className="border-b border-border-subtle bg-input-bg/40 text-xs font-medium text-text-muted">
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
                                  : "hover:bg-input-bg/35"
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
