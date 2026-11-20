import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { API_BASE } from "./apiConfig";
import AtlasSelect from "./AtlasSelect";
import { KeywordPanel } from "./KeywordPanel.jsx";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";
import {
  getCachedCatalogue,
  getMemoryCatalogue,
  getViewUiState,
  markCatalogueValidated,
  setCachedCatalogue,
  setViewUiState,
  broadcastCatalogueUpdate,
  onCatalogueUpdate
} from "./lib/atlasCache.js";
import { AtlasFeedback } from "./AtlasFeedback.jsx";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import {
  Badge,
  KpiStrip,
  PageHeader,
  ScanProgressBanner,
  TableSkeleton
} from "./components/ui/UiPrimitives.jsx";

const SAMPLE_PLAY_LINKS = [
  "https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio",
  "https://play.google.com/store/apps/developer?id=Desert+Safari+Studios",
  "https://play.google.com/store/apps/developer?id=OZI+Apps",
  "https://play.google.com/store/apps/developer?id=Giochi+Studios",
  "https://play.google.com/store/apps/developer?id=Crushiz"
];

const PUB_COMPARISON_STORAGE_KEY = "atlas_play_publisher_comparison_open_v1";

function formatRelativeTime(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toISOString().slice(0, 10);
}

function formatDurationSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function formatCompactNumber(num) {
  const n = Number(num || 0);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

const GAME_CATEGORIES = new Set([
  "game", "games", "simulation", "puzzle", "role playing", "strategy", "action",
  "adventure", "casual", "sports", "racing", "arcade", "board", "card", "trivia",
  "word", "casino", "music games", "educational games"
]);

function isGameItem(item) {
  const cat = String(item?.category || "").trim().toLowerCase();
  if (!cat) return true;
  if (cat.includes("game")) return true;
  if (GAME_CATEGORIES.has(cat)) return true;
  return false;
}

/**
 * Separate data availability ("Synced") from latest refresh attempt ("Retry Needed").
 * A publisher with synced games in Atlas is never marked broken just because a later refresh hit a transient error.
 */
function getPublisherSyncState(pub) {
  const hasGames = Number(pub.total_games || 0) > 0;
  const lastSuccess = pub.last_successful_scan_at || (hasGames ? pub.last_scanned_at : null);
  const latestStatus = String(pub.last_scan_status || "unscanned").toLowerCase();
  const latestAttemptFailed = latestStatus === "blocked" || latestStatus === "error";

  if (hasGames) {
    return {
      dataLabel: "Synced",
      textTone: "text-sem-success",
      lastSyncedText: formatRelativeTime(lastSuccess),
      hasRefreshWarning: latestAttemptFailed,
      warningText: latestAttemptFailed
        ? `Latest refresh attempt (${formatRelativeTime(pub.last_scanned_at)}) did not complete (${pub.last_scan_detail || latestStatus}). Showing preserved data from last successful sync.`
        : null
    };
  }

  if (latestStatus === "error") {
    return {
      dataLabel: "Retry Needed",
      textTone: "text-sem-warning",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Developer page scan did not return apps."
    };
  }

  if (latestStatus === "complete") {
    return {
      dataLabel: "Synced",
      textTone: "text-sem-success",
      lastSyncedText: formatRelativeTime(lastSuccess || pub.last_scanned_at),
      hasRefreshWarning: false,
      warningText: pub.last_scan_detail || null
    };
  }

  return {
    dataLabel: "Unscanned",
    textTone: "text-text-muted",
    lastSyncedText: "Never",
    hasRefreshWarning: false,
    warningText: null
  };
}

function PlayStoreIntelligenceView({
  onOpenCountryScan,
  initialSearchQuery = "",
  isAdmin = false
}) {
  const fetcher = useCallback((url, options = {}) => {
    const token = localStorage.getItem("atlas_auth_token");
    return fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        "ngrok-skip-browser-warning": "true",
        ...(token ? { "x-atlas-token": token } : {}),
        ...(options.headers || {})
      }
    });
  }, []);

  const initialMem = getMemoryCatalogue("play_overview");
  const initialUi = getViewUiState("play_view", {});

  const [overview, setOverview] = useState(
    () =>
      initialMem?.data || {
        summary: {
          publisherCount: 0,
          listCount: 0,
          uniqueGames: 0,
          totalListings: 0,
          totalGames: 0,
          freeGames: 0,
          paidGames: 0,
          freeShare: 0,
          totalInstalls: 0,
          totalReviews: 0,
          countryScannedGames: 0
        },
        lists: [],
        publishers: [],
        games: [],
        snapshots: [],
        competitorGroups: []
      }
  );
  const [loading, setLoading] = useState(() => !initialMem?.data);

  // App vs Game Top-Level Category Filter state
  const [appTypeFilter, setAppTypeFilter] = useState(() => initialUi.appTypeFilter || "all"); // "all" | "game" | "app"

  // Competitor List & Account Filter state
  const [selectedListId, setSelectedListId] = useState(() => initialUi.selectedListId ?? "all"); // "all" | "ungrouped" | number | "group_<id>"
  const [selectedPublisher, setSelectedPublisher] = useState(() => initialUi.selectedPublisher || "all");
  const [selectedPricing, setSelectedPricing] = useState(() => initialUi.selectedPricing || "all"); // all | free | paid | tba
  const [selectedStatus, setSelectedStatus] = useState(() => initialUi.selectedStatus || "all"); // all | prereg | live | early_access
  const [searchQuery, setSearchQuery] = useState(() => initialSearchQuery || initialUi.searchQuery || "");
  const [sortBy, setSortBy] = useState(() => initialUi.sortBy || "installs"); // installs | delta | release | first_seen | reviews | rating

  useEffect(() => {
    if (initialSearchQuery) {
      setSearchQuery(initialSearchQuery);
    }
  }, [initialSearchQuery]);

  // Launch Duration / Date Filter state (separating Play Store Launch Date vs. First Discovered in Atlas)
  const [dateBasis, setDateBasis] = useState(() => initialUi.dateBasis || "release_date"); // "release_date" | "first_seen_at"
  const [durationPreset, setDurationPreset] = useState(() => initialUi.durationPreset || "all"); // "all" | "today" | "7d" | "14d" | "30d" | "90d" | "6m" | "1y" | "custom"
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [includeUnknownDates, setIncludeUnknownDates] = useState(false);
  const [showDateFilterPopover, setShowDateFilterPopover] = useState(false);
  const dateFilterPopoverRef = useRef(null);

  // Drawers & Modals (Layered z-index: Drawer z-[90], Modals z-[100], Confirmations z-[110])
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [showSheetModal, setShowSheetModal] = useState(false);
  const [showCountryBatchModal, setShowCountryBatchModal] = useState(false);
  const [listModal, setListModal] = useState(null); // { mode: 'create' | 'edit', listId: 'new' | number, name, description, publisherIds: number[] }
  const [groupModal, setGroupModal] = useState(null); // { mode: 'create' | 'edit', groupId: 'new' | number, name, description, competitorIds: number[] }
  const [editingPublisher, setEditingPublisher] = useState(null); // { id, publisher_name, display_name, list_ids: number[] }
  const [confirmDeletePub, setConfirmDeletePub] = useState(null);

  // Scanner & validation state
  const [linksInput, setLinksInput] = useState("");
  const [scanTargetListIds, setScanTargetListIds] = useState([]);
  const [scanNewListName, setScanNewListName] = useState("");
  const [validationResult, setValidationResult] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [scanStatus, setScanStatus] = useState({ running: false, state: "idle", log: "" });
  const [elapsedSec, setElapsedSec] = useState(0);

  // Multi-Scope Scanner State
  const [scanModalTab, setScanModalTab] = useState("links"); // 'links' | 'single_game' | 'competitor' | 'publisher'
  const [singleGameInput, setSingleGameInput] = useState("");
  const [singleGameListId, setSingleGameListId] = useState("");
  const [scannerCompetitorId, setScannerCompetitorId] = useState("all");
  const [selectedCompetitorPubIds, setSelectedCompetitorPubIds] = useState([]);
  const [competitorPubFilter, setCompetitorPubFilter] = useState("");
  const [selectedSinglePubId, setSelectedSinglePubId] = useState("");
  const [publisherFilterQuery, setPublisherFilterQuery] = useState("");
  const [isSyncingCampaigns, setIsSyncingCampaigns] = useState(false);
  const [campaignSyncResult, setCampaignSyncResult] = useState(null);

  // Google Sheet Preview & New-Only Importer state
  const [sheetPreview, setSheetPreview] = useState(null);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [sheetPreviewError, setSheetPreviewError] = useState("");
  const [sheetSelectedLists, setSheetSelectedLists] = useState([]);
  const [sheetAutoScanNew, setSheetAutoScanNew] = useState(true);
  const [sheetShowOnlyNewCols, setSheetShowOnlyNewCols] = useState(true);
  const [sheetBannerDismissed, setSheetBannerDismissed] = useState(false);
  const [sheetElapsedSec, setSheetElapsedSec] = useState(0);
  const [isStartingSheetImport, setIsStartingSheetImport] = useState(false);
  const [sheetImportStatus, setSheetImportStatus] = useState({
    running: false,
    state: "idle",
    phase: "idle",
    autoScanNew: true,
    totalColumnsChecked: 0,
    totalInSheet: 0,
    skippedExisting: 0,
    totalNewAccounts: 0,
    importedCount: 0,
    scannedCount: 0,
    failedCount: 0,
    listsCreated: 0,
    membershipsAdded: 0,
    gamesDiscovered: 0,
    currentAccount: null,
    currentCompetitor: null,
    startedAt: null,
    finishedAt: null,
    failedLinks: [],
    log: ""
  });

  // Resumable Batch Country Scanner Queue state
  const [countryQueueStatus, setCountryQueueStatus] = useState({
    running: false,
    paused: false,
    state: "idle",
    totalPackages: 0,
    completedPackages: 0,
    skippedPackages: 0,
    failedCount: 0,
    log: ""
  });
  const [countryBatchScope, setCountryBatchScope] = useState("all"); // 'all' | 'list' | 'publisher'
  const [countryBatchSkipDays, setCountryBatchSkipDays] = useState(7);

  // Progressive table & publisher rendering state for instant UI responsiveness
  const [visibleRowCount, setVisibleRowCount] = useState(100);
  const [showAllPublishers, setShowAllPublishers] = useState(() => Boolean(initialUi.showAllPublishers));
  const [publisherComparisonOpen, setPublisherComparisonOpen] = useState(() => {
    try {
      return localStorage.getItem(PUB_COMPARISON_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const togglePublisherComparison = useCallback(() => {
    setPublisherComparisonOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PUB_COMPARISON_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setViewUiState("play_view", {
      appTypeFilter,
      selectedListId,
      selectedPublisher,
      selectedPricing,
      selectedStatus,
      searchQuery,
      sortBy,
      dateBasis,
      durationPreset,
      showAllPublishers
    });
  }, [
    appTypeFilter,
    selectedListId,
    selectedPublisher,
    selectedPricing,
    selectedStatus,
    searchQuery,
    sortBy,
    dateBasis,
    durationPreset,
    showAllPublishers
  ]);

  // Single-game refresh state + Keyword Intelligence + tactile action states
  const [refreshingPkg, setRefreshingPkg] = useState(null);
  const [queueingCountryPkg, setQueueingCountryPkg] = useState(null);
  const [removingPublisherId, setRemovingPublisherId] = useState(null);
  const [copiedPkg, setCopiedPkg] = useState(null);
  const [isRefreshingOverview, setIsRefreshingOverview] = useState(false);
  const [isDeletingList, setIsDeletingList] = useState(false);
  const [isDeletingPub, setIsDeletingPub] = useState(false);
  const [keywordTarget, setKeywordTarget] = useState(null);
  const [isSavingList, setIsSavingList] = useState(false);
  const [isSavingPublisher, setIsSavingPublisher] = useState(false);
  const cachedEtagRef = useRef(initialMem?.etag || null);
  const catalogSectionRef = useRef(null);
  const overviewLengthRef = useRef(0);
  overviewLengthRef.current = (overview?.games || []).length;

  const scrollToCatalogIfBelowFold = useCallback(() => {
    if (typeof window === "undefined" || !catalogSectionRef.current) return;
    const rect = catalogSectionRef.current.getBoundingClientRect();
    if (rect.top > window.innerHeight - 100) {
      catalogSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const handleCopyPackageId = useCallback(async (pkg, e) => {
    if (e) e.stopPropagation();
    if (!pkg) return;
    const ok = await AtlasFeedback.copy(pkg, "Copied package ID");
    if (ok) {
      setCopiedPkg(pkg);
      window.setTimeout(() => {
        setCopiedPkg((prev) => (prev === pkg ? null : prev));
      }, 1400);
    }
  }, []);

  const loadOverview = useCallback(async (_options = {}) => {
    const hasExistingData = overviewLengthRef.current > 0;
    if (hasExistingData) setIsRefreshingOverview(true);
    try {
      const headers = {};
      if (cachedEtagRef.current) {
        headers["If-None-Match"] = cachedEtagRef.current;
      }

      const res = await fetcher(`${API_BASE}/api/play/overview`, {
        headers
      });

      // 304 Not Modified: Cache is 100% up to date! 0 byte body transferred
      if (res.status === 304) {
        markCatalogueValidated("play_overview");
        setLoading(false);
        return;
      }

      if (res.ok) {
        const data = await res.json();
        const newEtag = res.headers.get("ETag");
        if (newEtag) cachedEtagRef.current = newEtag;

        const normalized = {
          summary: data.summary || {
            publisherCount: 0,
            listCount: 0,
            uniqueGames: 0,
            totalListings: 0,
            totalGames: 0,
            freeGames: 0,
            paidGames: 0,
            freeShare: 0,
            totalInstalls: 0,
            totalReviews: 0,
            countryScannedGames: 0
          },
          lists: data.lists || [],
          competitorGroups: data.competitorGroups || [],
          publishers: data.publishers || [],
          games: data.games || [],
          snapshots: data.snapshots || []
        };

        setOverview(normalized);
        setActiveGameDrawer((prev) => {
          if (!prev?.package_name) return prev;
          const updated = (normalized.games || []).find((g) => g.package_name === prev.package_name);
          return updated ? { ...prev, ...updated } : prev;
        });
        void setCachedCatalogue("play_overview", normalized, newEtag);
        broadcastCatalogueUpdate("play", newEtag);
      }
    } catch (err) {
      console.error("Failed to load Play Store overview:", err);
    } finally {
      setLoading(false);
      setIsRefreshingOverview(false);
    }
  }, [fetcher]);

  // Instant render from L1 Memory / IndexedDB + Stale-While-Revalidate + Multi-tab sync
  useEffect(() => {
    let isMounted = true;

    (async () => {
      const mem = getMemoryCatalogue("play_overview");
      if (mem?.data) {
        if (mem.etag && !cachedEtagRef.current) cachedEtagRef.current = mem.etag;
        if (Date.now() - (mem.lastValidatedAt || 0) >= 15000) {
          void loadOverview();
        }
        return;
      }

      // Cold start: hydrate from IndexedDB BEFORE firing network request so ETag is included
      const cached = await getCachedCatalogue("play_overview");
      if (isMounted && cached?.data) {
        setOverview(cached.data);
        if (cached.etag) cachedEtagRef.current = cached.etag;
        setLoading(false);
      }
      if (isMounted) {
        void loadOverview();
      }
    })();

    // Multi-tab synchronization: if another tab updates the data, refresh silently
    const unsubscribe = onCatalogueUpdate((msg) => {
      if (msg.platform === "play") {
        getCachedCatalogue("play_overview").then((fresh) => {
          if (isMounted && fresh?.data) {
            setOverview(fresh.data);
            if (fresh.etag) cachedEtagRef.current = fresh.etag;
          }
        });
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [loadOverview]);

  const lastCompletedPublishersRef = useRef(0);
  const lastCompletedCountriesRef = useRef(0);
  const lastMidScanRefreshAtRef = useRef(0);
  const consecutivePollErrorsRef = useRef(0);
  const wasScanRunningRef = useRef(false);
  const wasQueueRunningRef = useRef(false);
  const pollInFlightRef = useRef(false);

  // Adaptive scan status polling: 1.5s while actively scanning, 20s while idle, paused when tab is hidden
  useEffect(() => {
    let disposed = false;
    let timerId = null;

    const checkStatuses = async () => {
      if (disposed || document.hidden || pollInFlightRef.current) return;
      pollInFlightRef.current = true;

      let isActive = false;
      let hadError = false;
      try {
        const [scanRes, cqRes] = await Promise.all([
          fetcher(`${API_BASE}/api/play/scan-status`),
          fetcher(`${API_BASE}/api/play/country-queue/status`)
        ]);
        let refreshedThisTick = false;
        if (scanRes.ok) {
          const st = await scanRes.json();
          if (st.running) isActive = true;
          const completedNow = Number(st.completedPublishers || 0);
          const scanJustFinished = wasScanRunningRef.current && !st.running;
          wasScanRunningRef.current = Boolean(st.running);
          const midScanReady =
            st.running &&
            completedNow > lastCompletedPublishersRef.current &&
            Date.now() - lastMidScanRefreshAtRef.current >= 30000;
          if (scanJustFinished || midScanReady) {
            lastCompletedPublishersRef.current = completedNow;
            lastMidScanRefreshAtRef.current = Date.now();
            refreshedThisTick = true;
            loadOverview();
          } else if (st.running && completedNow > lastCompletedPublishersRef.current) {
            lastCompletedPublishersRef.current = completedNow;
          } else if (!st.running) {
            lastCompletedPublishersRef.current = 0;
          }
          setScanStatus(st);
        } else {
          hadError = true;
        }
        if (cqRes.ok) {
          const cq = await cqRes.json();
          if (cq.running) isActive = true;
          const completedCountriesNow = Number(cq.completedPackages || 0);
          const queueJustFinished = wasQueueRunningRef.current && !cq.running;
          wasQueueRunningRef.current = Boolean(cq.running);
          const midQueueReady =
            !refreshedThisTick &&
            cq.running &&
            completedCountriesNow > lastCompletedCountriesRef.current &&
            Date.now() - lastMidScanRefreshAtRef.current >= 30000;
          if (queueJustFinished || midQueueReady) {
            lastCompletedCountriesRef.current = completedCountriesNow;
            lastMidScanRefreshAtRef.current = Date.now();
            loadOverview();
          } else if (cq.running && completedCountriesNow > lastCompletedCountriesRef.current) {
            lastCompletedCountriesRef.current = completedCountriesNow;
          } else if (!cq.running) {
            lastCompletedCountriesRef.current = 0;
          }
          setCountryQueueStatus(cq);
        } else {
          hadError = true;
        }
        consecutivePollErrorsRef.current = hadError ? consecutivePollErrorsRef.current + 1 : 0;
      } catch {
        consecutivePollErrorsRef.current += 1;
        hadError = true;
      } finally {
        pollInFlightRef.current = false;
      }

      if (!disposed && !document.hidden) {
        const nextDelay = isActive
          ? 1500
          : hadError
            ? Math.min(60000, 10000 * Math.pow(2, Math.max(0, consecutivePollErrorsRef.current - 1)))
            : 20000;
        clearTimeout(timerId);
        timerId = setTimeout(checkStatuses, nextDelay);
      }
    };

    checkStatuses();

    // Wake up immediately when user switches back to tab
    const handleVisibility = () => {
      if (!document.hidden && !disposed) {
        clearTimeout(timerId);
        checkStatuses();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetcher, loadOverview]);

  // Live elapsed timer during active publisher scan
  useEffect(() => {
    if (!scanStatus.running || !scanStatus.startedAt) {
      if (scanStatus.startedAt && scanStatus.finishedAt) {
        const diff = (new Date(scanStatus.finishedAt).getTime() - new Date(scanStatus.startedAt).getTime()) / 1000;
        setElapsedSec(Math.max(0, Math.round(diff)));
      }
      return;
    }
    const updateElapsed = () => {
      const diff = (Date.now() - new Date(scanStatus.startedAt).getTime()) / 1000;
      setElapsedSec(Math.max(0, Math.round(diff)));
    };
    updateElapsed();
    const iv = setInterval(updateElapsed, 1000);
    return () => clearInterval(iv);
  }, [scanStatus.running, scanStatus.startedAt, scanStatus.finishedAt]);

  // Fetch Google Sheets import status once on mount (in case an import is already running)
  useEffect(() => {
    let active = true;
    fetcher(`${API_BASE}/api/play/sheet-import-status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && data.state && data.state !== "idle") {
          setSheetImportStatus(data);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [fetcher]);

  const wasSheetImportRunningRef = useRef(false);
  const lastSheetOverviewSyncRef = useRef(0);
  const showSheetModalRef = useRef(showSheetModal);
  showSheetModalRef.current = showSheetModal;

  // Dedicated polling loop active ONLY while Google Sheets import/scan is running
  useEffect(() => {
    if (!sheetImportStatus.running) {
      if (wasSheetImportRunningRef.current) {
        wasSheetImportRunningRef.current = false;
      }
      return undefined;
    }

    wasSheetImportRunningRef.current = true;
    let disposed = false;
    let inFlight = false;
    let timerId = null;

    const pollSheetImport = async () => {
      if (disposed || document.hidden || inFlight) return;
      inFlight = true;
      let stillRunning = true;
      try {
        const res = await fetcher(`${API_BASE}/api/play/sheet-import-status`);
        if (res.ok && !disposed) {
          const nextStatus = await res.json();
          setSheetImportStatus(nextStatus);
          stillRunning = Boolean(nextStatus?.running);

          if (!stillRunning) {
            wasSheetImportRunningRef.current = false;
            void loadOverview({ fresh: true });
            if (showSheetModalRef.current) {
              fetcher(`${API_BASE}/api/play/sheet-preview`)
                .then((pRes) => (pRes.ok ? pRes.json() : null))
                .then((pData) => {
                  if (!disposed && pData) {
                    setSheetPreview(pData);
                    setSheetSelectedLists((pData.columns || []).filter((c) => c.newAccountCount > 0).map((c) => c.listName));
                  }
                })
                .catch(() => {});
            }
          } else if (nextStatus.phase === "scanning" && Date.now() - lastSheetOverviewSyncRef.current >= 20000) {
            lastSheetOverviewSyncRef.current = Date.now();
            void loadOverview({ fresh: true });
          }
        }
      } catch {
      } finally {
        inFlight = false;
        if (!disposed && stillRunning && !document.hidden) {
          clearTimeout(timerId);
          timerId = setTimeout(pollSheetImport, 1200);
        }
      }
    };

    const handleVisibility = () => {
      if (!document.hidden && !disposed) {
        clearTimeout(timerId);
        void pollSheetImport();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    timerId = setTimeout(pollSheetImport, 900);

    return () => {
      disposed = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sheetImportStatus.running, fetcher, loadOverview]);

  // Live elapsed timer during Google Sheets import/scan
  useEffect(() => {
    if (!sheetImportStatus.running || !sheetImportStatus.startedAt) {
      if (sheetImportStatus.startedAt && sheetImportStatus.finishedAt) {
        const diff = (new Date(sheetImportStatus.finishedAt).getTime() - new Date(sheetImportStatus.startedAt).getTime()) / 1000;
        setSheetElapsedSec(Math.max(0, Math.round(diff)));
      }
      return undefined;
    }
    const updateElapsed = () => {
      const diff = (Date.now() - new Date(sheetImportStatus.startedAt).getTime()) / 1000;
      setSheetElapsedSec(Math.max(0, Math.round(diff)));
    };
    updateElapsed();
    const iv = setInterval(updateElapsed, 1000);
    return () => clearInterval(iv);
  }, [sheetImportStatus.running, sheetImportStatus.startedAt, sheetImportStatus.finishedAt]);

  // Reset visible row count when filters change
  useEffect(() => {
    setVisibleRowCount(100);
  }, [appTypeFilter, selectedListId, selectedPublisher, selectedPricing, selectedStatus, searchQuery, sortBy, durationPreset, dateBasis]);

  // Close date filter popover when clicking outside
  useEffect(() => {
    if (!showDateFilterPopover) return;
    const handleClickOutside = (e) => {
      if (dateFilterPopoverRef.current && !dateFilterPopoverRef.current.contains(e.target)) {
        setShowDateFilterPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDateFilterPopover]);

  // Keyboard Escape dismissal & body scroll lock ONLY for full-screen modals/drawer (floating Sheet panel stays non-blocking)
  useEffect(() => {
    const anyBlockingOpen = Boolean(
      activeGameDrawer ||
        keywordTarget ||
        showScannerModal ||
        showCountryBatchModal ||
        listModal ||
        groupModal ||
        editingPublisher ||
        confirmDeletePub
    );
    const anyDismissibleOpen = anyBlockingOpen || showSheetModal || showDateFilterPopover;
    if (!anyDismissibleOpen) return;

    const prevOverflow = document.body.style.overflow;
    if (anyBlockingOpen) {
      document.body.style.overflow = "hidden";
    }
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (showDateFilterPopover) setShowDateFilterPopover(false);
        else if (keywordTarget) setKeywordTarget(null);
        else if (confirmDeletePub) setConfirmDeletePub(null);
        else if (editingPublisher) setEditingPublisher(null);
        else if (groupModal) setGroupModal(null);
        else if (listModal) setListModal(null);
        else if (showCountryBatchModal) setShowCountryBatchModal(false);
        else if (showSheetModal) setShowSheetModal(false);
        else if (showScannerModal) setShowScannerModal(false);
        else if (activeGameDrawer) setActiveGameDrawer(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (anyBlockingOpen) {
        document.body.style.overflow = prevOverflow;
      }
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activeGameDrawer,
    keywordTarget,
    showScannerModal,
    showSheetModal,
    showCountryBatchModal,
    listModal,
    groupModal,
    editingPublisher,
    confirmDeletePub,
    showDateFilterPopover
  ]);

  // Map publisher_name -> publisher record
  const publisherByRawName = useMemo(() => {
    const map = new Map();
    for (const p of overview.publishers || []) {
      map.set(p.publisher_name, p);
    }
    return map;
  }, [overview.publishers]);

  // Map list_id -> list name (parent competitor name)
  const listNameById = useMemo(() => {
    const map = new Map();
    for (const l of overview.lists || []) {
      map.set(Number(l.id), l.name);
    }
    return map;
  }, [overview.lists]);

  const getDisplayName = useCallback(
    (rawName) => {
      const pub = publisherByRawName.get(rawName);
      if (!pub) return rawName;
      return pub.display_name && pub.display_name.trim() ? pub.display_name.trim() : pub.publisher_name;
    },
    [publisherByRawName]
  );

  const getCompetitorNamesForGame = useCallback(
    (g) => {
      if (!g) return [];
      if (Array.isArray(g.competitor_names) && g.competitor_names.length > 0) {
        return g.competitor_names;
      }
      if (g.competitor_name) {
        return [g.competitor_name];
      }
      const pub = publisherByRawName.get(g.publisher_name);
      if (pub && Array.isArray(pub.list_ids) && pub.list_ids.length > 0) {
        return pub.list_ids.map((id) => listNameById.get(Number(id))).filter(Boolean);
      }
      return [];
    },
    [publisherByRawName, listNameById]
  );

  const getAppReleaseStatus = useCallback((g) => {
    if (!g) return "LIVE";
    if (g.is_suspended === true || g.release_status === "SUSPENDED") {
      return "SUSPENDED";
    }
    const isPreReg =
      g.release_status === "PRE_REGISTERED" ||
      g.pricing === "tba" ||
      g.price_status === "PRICE_TBA" ||
      (Number(g.country_scan?.preRegisterCount || 0) > 0 && Number(g.country_scan?.liveCount || 0) === 0);

    const isEarlyAccess =
      !isPreReg &&
      Number(g.country_scan?.earlyAccessCount || 0) > 0 &&
      Number(g.country_scan?.liveCount || 0) === 0;

    if (isPreReg) return "PRE_REGISTERED";
    if (isEarlyAccess) return "EARLY_ACCESS";
    return "LIVE";
  }, []);

  // Active Competitor Group (Batch) if selected (e.g. "group_1")
  const activeGroupObj = useMemo(() => {
    if (typeof selectedListId === "string" && selectedListId.startsWith("group_")) {
      const gId = Number(selectedListId.replace("group_", ""));
      return (overview.competitorGroups || []).find((g) => g.id === gId) || null;
    }
    return null;
  }, [overview.competitorGroups, selectedListId]);

  // Publishers visible under the active Competitor List or Competitor Group filter
  const visiblePublishers = useMemo(() => {
    return (overview.publishers || []).filter((p) => {
      if (selectedListId === "all") return true;
      if (activeGroupObj) {
        const pubId = Number(p.id);
        const lIds = Array.isArray(p.list_ids) ? p.list_ids : [];
        if (activeGroupObj.publisher_ids && activeGroupObj.publisher_ids.includes(pubId)) return true;
        if (activeGroupObj.list_ids && lIds.some((lid) => activeGroupObj.list_ids.includes(lid))) return true;
        return false;
      }
      const lIds = Array.isArray(p.list_ids) ? p.list_ids : [];
      if (selectedListId === "ungrouped") return lIds.length === 0;
      return lIds.includes(Number(selectedListId));
    });
  }, [overview.publishers, selectedListId, activeGroupObj]);

  const visiblePublisherNames = useMemo(
    () => new Set(visiblePublishers.map((p) => p.publisher_name)),
    [visiblePublishers]
  );

  const activeListObj = useMemo(() => {
    if (selectedListId === "all" || selectedListId === "ungrouped" || String(selectedListId).startsWith("group_")) return null;
    return (overview.lists || []).find((l) => l.id === Number(selectedListId)) || null;
  }, [overview.lists, selectedListId]);

  // Total games vs apps counts for header tabs
  const appCounts = useMemo(() => {
    let games = 0;
    let apps = 0;
    for (const g of overview.games || []) {
      if (isGameItem(g)) games++;
      else apps++;
    }
    return { games, apps, total: (overview.games || []).length };
  }, [overview.games]);

  const ungroupedCount = useMemo(
    () => (overview.publishers || []).filter((p) => !p.list_ids || p.list_ids.length === 0).length,
    [overview.publishers]
  );

  const unscannedPublisherCount = useMemo(
    () =>
      (overview.publishers || []).filter(
        (p) => !p.last_scanned_at || p.last_scan_status === "unscanned"
      ).length,
    [overview.publishers]
  );

  // Compute active date window bounds
  const dateWindow = useMemo(() => {
    if (durationPreset === "all") return { active: false, startMs: null, endMs: null, label: "All Time" };
    const now = new Date();
    const endOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

    if (durationPreset === "today") {
      const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
      return { active: true, startMs: startOfTodayMs, endMs: endOfTodayMs, label: "Today (Last 24h)" };
    }

    if (durationPreset === "custom") {
      const sMs = customStartDate ? new Date(`${customStartDate}T00:00:00Z`).getTime() : null;
      const eMs = customEndDate ? new Date(`${customEndDate}T23:59:59Z`).getTime() : null;
      if (!sMs && !eMs) return { active: false, startMs: null, endMs: null, label: "Custom Range" };
      return {
        active: true,
        startMs: sMs,
        endMs: eMs,
        label: `${customStartDate || "Start"} → ${customEndDate || "Now"}`
      };
    }

    const daysMap = { "7d": 7, "14d": 14, "30d": 30, "90d": 90, "6m": 182, "1y": 365 };
    const labelsMap = {
      "7d": "Last 7 Days",
      "14d": "Last 14 Days",
      "30d": "Last 30 Days",
      "90d": "Last 90 Days",
      "6m": "Last 6 Months",
      "1y": "Last 1 Year"
    };
    const days = daysMap[durationPreset] || 30;
    const startMs = endOfTodayMs - days * 86400 * 1000;
    return { active: true, startMs, endMs: endOfTodayMs, label: labelsMap[durationPreset] || "Selected Period" };
  }, [durationPreset, customStartDate, customEndDate]);

  // Helper to evaluate whether a game matches the selected date filter
  const evaluateGameDate = useCallback(
    (g) => {
      const rawDate = dateBasis === "first_seen_at" ? g.first_seen_at : g.release_date;
      if (!rawDate) {
        return { known: false, inRange: !dateWindow.active || includeUnknownDates };
      }
      const ms = new Date(rawDate).getTime();
      if (Number.isNaN(ms)) {
        return { known: false, inRange: !dateWindow.active || includeUnknownDates };
      }
      if (!dateWindow.active) return { known: true, inRange: true };
      if (dateWindow.startMs !== null && ms < dateWindow.startMs) return { known: true, inRange: false };
      if (dateWindow.endMs !== null && ms > dateWindow.endMs) return { known: true, inRange: false };
      return { known: true, inRange: true };
    },
    [dateBasis, dateWindow, includeUnknownDates]
  );

  // Scope games to current list AND/OR selected account, then compute both all-time and period metrics
  const scopedStats = useMemo(() => {
    const inScopeGames = (overview.games || []).filter((g) => {
      if (appTypeFilter === "game" && !isGameItem(g)) return false;
      if (appTypeFilter === "app" && isGameItem(g)) return false;
      if (!visiblePublisherNames.has(g.publisher_name)) return false;
      if (selectedPublisher !== "all" && g.publisher_name !== selectedPublisher) return false;
      return true;
    });

    const uniqueAllTimeByPkg = new Map();
    const uniqueMatchingByPkg = new Map();
    let knownDateCount = 0;
    let unknownDateCount = 0;

    for (const g of inScopeGames) {
      if (!uniqueAllTimeByPkg.has(g.package_name)) {
        uniqueAllTimeByPkg.set(g.package_name, g);
        const dEval = evaluateGameDate(g);
        if (dEval.known) knownDateCount += 1;
        else unknownDateCount += 1;
        if (dEval.inRange) {
          uniqueMatchingByPkg.set(g.package_name, g);
        }
      }
    }

    const matchingArr = [...uniqueMatchingByPkg.values()];
    const allTimeArr = [...uniqueAllTimeByPkg.values()];
    const freeMatching = matchingArr.filter((g) => g.pricing === "free").length;
    const paidMatching = matchingArr.filter((g) => g.pricing === "paid").length;
    const tbaMatching = matchingArr.filter((g) => g.pricing === "tba").length;
    const totalInstalls = matchingArr.reduce((s, g) => s + (Number(g.real_installs ?? g.min_installs) || 0), 0);
    const totalDailyDelta = matchingArr.reduce((s, g) => s + (Number(g.installs_delta_1d) || 0), 0);
    const countryScannedCount = matchingArr.filter((g) => Boolean(g.country_scan)).length;

    return {
      allTimeUnique: allTimeArr.length,
      totalListings: inScopeGames.length,
      matchingUnique: matchingArr.length,
      freeMatching,
      paidMatching,
      tbaMatching,
      freeShare: matchingArr.length ? freeMatching / matchingArr.length : 0,
      totalInstalls,
      totalDailyDelta,
      countryScannedCount,
      knownDateCount,
      unknownDateCount
    };
  }, [overview.games, visiblePublisherNames, selectedPublisher, evaluateGameDate, appTypeFilter]);

  // Per-publisher stats dynamically computed for the active date filter and app/game mode
  const publisherStatsByName = useMemo(() => {
    const map = new Map();
    for (const pub of visiblePublishers) {
      map.set(pub.publisher_name, {
        total: 0,
        free: 0,
        paid: 0,
        installs: 0,
        dailyDelta: 0,
        unknownDate: 0,
        allTimeMatching: 0,
        allTimeTotal: Number(pub.total_games) || 0
      });
    }
    for (const g of overview.games || []) {
      if (appTypeFilter === "game" && !isGameItem(g)) continue;
      if (appTypeFilter === "app" && isGameItem(g)) continue;
      const entry = map.get(g.publisher_name);
      if (!entry) continue;
      entry.allTimeMatching += 1;
      const dEval = evaluateGameDate(g);
      if (!dEval.known) entry.unknownDate += 1;
      if (dEval.inRange) {
        entry.total += 1;
        if (g.pricing === "paid" || Number(g.price) > 0 || g.is_paid === true) {
          entry.paid += 1;
        } else {
          entry.free += 1;
        }
        entry.installs += Number(g.real_installs ?? g.min_installs) || 0;
        entry.dailyDelta += Number(g.installs_delta_1d) || 0;
      }
    }
    return map;
  }, [visiblePublishers, overview.games, evaluateGameDate, appTypeFilter]);

  // When filtering by Game or App, omit publishers that have 0 titles in this category
  const comparisonPublishers = useMemo(() => {
    return visiblePublishers.filter((pub) => {
      const st = publisherStatsByName.get(pub.publisher_name);
      if (!st) return false;
      if (appTypeFilter !== "all" && st.allTimeMatching === 0) return false;
      return true;
    });
  }, [visiblePublishers, publisherStatsByName, appTypeFilter]);

  const maxPublisherGames = useMemo(() => {
    return Math.max(
      1,
      ...comparisonPublishers.map((p) => {
        const st = publisherStatsByName.get(p.publisher_name);
        return st ? st.total : 0;
      })
    );
  }, [comparisonPublishers, publisherStatsByName]);

  const filteredGames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (overview.games || [])
      .filter((g) => {
        if (appTypeFilter === "game" && !isGameItem(g)) return false;
        if (appTypeFilter === "app" && isGameItem(g)) return false;
        if (!visiblePublisherNames.has(g.publisher_name)) return false;
        if (selectedPublisher !== "all" && g.publisher_name !== selectedPublisher) return false;
        if (selectedPricing !== "all" && g.pricing !== selectedPricing) return false;
        if (selectedStatus === "prereg" && getAppReleaseStatus(g) !== "PRE_REGISTERED") return false;
        if (selectedStatus === "live" && getAppReleaseStatus(g) !== "LIVE") return false;
        if (selectedStatus === "early_access" && getAppReleaseStatus(g) !== "EARLY_ACCESS") return false;
        if (selectedStatus === "suspended" && getAppReleaseStatus(g) !== "SUSPENDED") return false;
        const dEval = evaluateGameDate(g);
        if (!dEval.inRange) return false;
        if (q) {
          const disp = getDisplayName(g.publisher_name);
          const compStr = getCompetitorNamesForGame(g).join(" ");
          const hay = `${g.title || ""} ${g.package_name || ""} ${g.publisher_name || ""} ${disp} ${compStr}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "delta") return (Number(b.installs_delta_1d) || 0) - (Number(a.installs_delta_1d) || 0);
        if (sortBy === "release") return String(b.release_date || "").localeCompare(String(a.release_date || ""));
        if (sortBy === "first_seen") return String(b.first_seen_at || "").localeCompare(String(a.first_seen_at || ""));
        if (sortBy === "reviews") return (Number(b.review_count) || 0) - (Number(a.review_count) || 0);
        if (sortBy === "rating") return (Number(b.rating) || 0) - (Number(a.rating) || 0);
        return (
          (Number(b.real_installs ?? b.min_installs) || 0) -
          (Number(a.real_installs ?? a.min_installs) || 0)
        );
      });
  }, [
    overview.games,
    visiblePublisherNames,
    selectedPublisher,
    selectedPricing,
    selectedStatus,
    searchQuery,
    sortBy,
    getDisplayName,
    getCompetitorNamesForGame,
    getAppReleaseStatus,
    evaluateGameDate,
    appTypeFilter
  ]);

  const gamesByPublisher = useMemo(() => {
    const map = new Map();
    for (const g of overview.games || []) {
      if (!map.has(g.publisher_name)) map.set(g.publisher_name, []);
      map.get(g.publisher_name).push(g);
    }
    return map;
  }, [overview.games]);

  const selectedPublisherObj = useMemo(
    () => (overview.publishers || []).find((p) => p.publisher_name === selectedPublisher) || null,
    [overview.publishers, selectedPublisher]
  );

  const competitorSelectOptions = useMemo(() => {
    const list = [
      {
        value: "all",
        label: `All Competitors (${overview.publishers.length} accounts)`,
        icon: "public"
      }
    ];

    if ((overview.competitorGroups || []).length > 0) {
      overview.competitorGroups.forEach((grp) => {
        const compCount = Array.isArray(grp.competitor_names) ? grp.competitor_names.length : (grp.competitor_ids?.length || 0);
        list.push({
          value: `group_${grp.id}`,
          label: grp.name,
          group: "Competitor Batches (Groups)",
          badge: `${compCount} ${compCount === 1 ? "comp" : "comps"} · ${grp.account_count || 0} accts`,
          icon: "folder_special"
        });
      });
    }

    (overview.lists || []).forEach((item) => {
      list.push({
        value: item.id,
        label: item.name,
        group: "Individual Competitors",
        badge: `${item.account_count || 0} accounts`,
        icon: "folder"
      });
    });

    if (ungroupedCount > 0) {
      list.push({
        value: "ungrouped",
        label: `Ungrouped Accounts (${ungroupedCount})`,
        icon: "folder_open"
      });
    }

    return list;
  }, [overview.publishers.length, overview.competitorGroups, overview.lists, ungroupedCount]);

  const publisherSelectOptions = useMemo(() => {
    const list = [
      {
        value: "all",
        label: `All Accounts (${visiblePublishers.length})`,
        icon: "storefront"
      }
    ];

    visiblePublishers.forEach((pub) => {
      const gCount = gamesByPublisher.get(pub.publisher_name)?.length ?? pub.total_games ?? pub.game_count ?? 0;
      list.push({
        value: pub.publisher_name,
        label: getDisplayName(pub.publisher_name),
        badge: `${gCount} ${gCount === 1 ? "game" : "games"}`,
        icon: "storefront"
      });
    });

    return list;
  }, [visiblePublishers, gamesByPublisher, getDisplayName]);

  const pricingSelectOptions = useMemo(
    () => [
      { value: "all", label: "All Pricing", icon: "payments" },
      { value: "free", label: "Free Games Only", icon: "check_circle" },
      { value: "paid", label: "Paid Games Only", icon: "monetization_on" },
      { value: "tba", label: "Price TBA (Pre-reg)", icon: "schedule" }
    ],
    []
  );

  const statusSelectOptions = useMemo(
    () => [
      { value: "all", label: "All Statuses", icon: "rule" },
      { value: "live", label: "Live Only", icon: "sensors" },
      { value: "prereg", label: "Pre-Register Only", icon: "app_registration" },
      { value: "early_access", label: "Early Access Only", icon: "schedule" },
      { value: "suspended", label: "Unpublished / Suspended", icon: "block" }
    ],
    []
  );

  const sortSelectOptions = useMemo(
    () => [
      { value: "installs", label: "Sort: Highest Installs", icon: "download" },
      { value: "release", label: "Sort: Newest Play Launch Date", icon: "calendar_today" },
      { value: "first_seen", label: "Sort: Newly Discovered in Atlas", icon: "visibility" },
      { value: "reviews", label: "Sort: Most Reviews", icon: "rate_review" },
      { value: "rating", label: "Sort: Highest Rating", icon: "star" }
    ],
    []
  );

  // Open Competitor Batch modal (e.g. "Bahria" grouping Trenzy + Gaminator)
  const openBatchManager = useCallback((targetGroup = null) => {
    if (targetGroup) {
      const compIds = Array.isArray(targetGroup.competitor_ids) && targetGroup.competitor_ids.length > 0
        ? targetGroup.competitor_ids.map(Number)
        : [];
      setGroupModal({
        mode: "edit",
        groupId: targetGroup.id,
        name: targetGroup.name,
        description: targetGroup.description || "",
        competitorIds: compIds,
        searchQuery: "",
        saving: false,
        error: null
      });
    } else {
      setGroupModal({
        mode: "create",
        groupId: "new",
        name: "",
        description: "",
        competitorIds: [],
        searchQuery: "",
        saving: false,
        error: null
      });
    }
  }, []);

  const handleSelectBatchInModal = (val) => {
    if (val === "new") {
      openBatchManager(null);
      return;
    }
    const gId = Number(val);
    const found = (overview.competitorGroups || []).find((g) => Number(g.id) === gId);
    if (found) openBatchManager(found);
  };

  // Map each canonical competitor_id -> the batch { id, name } it belongs to
  const competitorBatchAssignmentMap = useMemo(() => {
    const map = new Map();
    for (const grp of overview.competitorGroups || []) {
      for (const cId of grp.competitor_ids || []) {
        map.set(Number(cId), { id: Number(grp.id), name: grp.name });
      }
    }
    return map;
  }, [overview.competitorGroups]);

  const handleSaveBatch = async (e) => {
    e?.preventDefault();
    if (!groupModal || !groupModal.name.trim() || groupModal.saving) return;
    setGroupModal((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const isCreate = groupModal.mode === "create";
      const url = isCreate
        ? `${API_BASE}/api/competitor-groups`
        : `${API_BASE}/api/competitor-groups/${groupModal.groupId}`;
      const method = isCreate ? "POST" : "PUT";
      const res = await fetcher(url, {
        method,
        body: JSON.stringify({
          name: groupModal.name.trim(),
          description: groupModal.description?.trim() || "",
          competitor_ids: groupModal.competitorIds,
          competitorIds: groupModal.competitorIds,
          idSource: "competitor"
        })
      });
      if (res.ok) {
        const saved = await res.json();
        const savedName = groupModal.name.trim();
        const isCreateMode = groupModal.mode === "create";
        setGroupModal(null);
        await loadOverview({ fresh: true });
        const targetId = saved?.id || saved?.group?.id;
        if (targetId) {
          setSelectedListId(`group_${targetId}`);
        }
        AtlasFeedback.toast(
          `${isCreateMode ? "Created" : "Updated"} competitor batch "${savedName}".`,
          { tone: "success" }
        );
      } else {
        const err = await res.json().catch(() => ({}));
        setGroupModal((prev) => ({
          ...prev,
          saving: false,
          error: err.error || "Failed to save competitor batch."
        }));
      }
    } catch (err) {
      console.error("Save batch error:", err);
      setGroupModal((prev) => ({
        ...prev,
        saving: false,
        error: err.message || "Failed to save competitor batch."
      }));
    }
  };

  const handleDeleteBatch = async (groupId) => {
    const ok = await AtlasFeedback.confirm(
      "Are you sure you want to delete this competitor batch? Competitors and publisher accounts will NOT be deleted.",
      { title: "Delete Competitor Batch", confirmLabel: "Delete Batch", destructive: true }
    );
    if (!ok) return;
    try {
      const res = await fetcher(`${API_BASE}/api/competitor-groups/${groupId}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedListId === `group_${groupId}`) setSelectedListId("all");
        setGroupModal(null);
        await loadOverview({ fresh: true });
        AtlasFeedback.toast("Competitor batch deleted.", { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        AtlasFeedback.toast(errData?.error || "Failed to delete competitor batch.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Delete batch error:", err);
      AtlasFeedback.toast(err?.message || "Failed to delete competitor batch.", { tone: "danger" });
    }
  };

  // Open Manage Lists modal for a specific list or new list
  const openListManager = useCallback((targetList = null) => {
    if (targetList) {
      setListModal({
        mode: "edit",
        listId: targetList.id,
        name: targetList.name,
        description: targetList.description || "",
        publisherIds: Array.isArray(targetList.publisher_ids) ? [...targetList.publisher_ids] : []
      });
    } else {
      setListModal({
        mode: "create",
        listId: "new",
        name: "",
        description: "",
        publisherIds: []
      });
    }
  }, []);

  const handleSelectListInModal = (val) => {
    if (val === "new") {
      setListModal({
        mode: "create",
        listId: "new",
        name: "",
        description: "",
        publisherIds: []
      });
      return;
    }
    const found = (overview.lists || []).find((l) => Number(l.id) === Number(val));
    if (found) {
      openListManager(found);
    }
  };

  // Synchronize selected accounts when competitor scope changes in Modal
  useEffect(() => {
    if (!scannerCompetitorId || scannerCompetitorId === "all") {
      setSelectedCompetitorPubIds((overview.publishers || []).map((p) => p.id));
    } else {
      const idNum = Number(scannerCompetitorId);
      const matching = (overview.publishers || []).filter(
        (p) => Array.isArray(p.list_ids) && p.list_ids.includes(idNum)
      );
      setSelectedCompetitorPubIds(matching.map((p) => p.id));
    }
  }, [scannerCompetitorId, overview.publishers]);

  const handleSyncSheetCampaigns = async () => {
    setIsSyncingCampaigns(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/sync-sheet-campaigns`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCampaignSyncResult(data);
        await loadOverview({ fresh: true });
        AtlasFeedback.toast("Google Sheets campaigns synced.", { tone: "success" });
      } else {
        AtlasFeedback.toast(`Campaign sync error: ${data?.error || "Unknown error"}`, { tone: "danger" });
      }
    } catch (err) {
      AtlasFeedback.toast(`Campaign sync failed: ${err?.message || "Network error"}`, { tone: "danger" });
    } finally {
      setIsSyncingCampaigns(false);
    }
  };

  const singleGameValidation = useMemo(() => {
    const raw = singleGameInput.trim();
    if (!raw) return { valid: false, message: "" };
    if (/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(raw)) {
      return { valid: true, type: "package", normalized: raw.toLowerCase() };
    }
    try {
      const url = new URL(raw);
      if (/\/store\/apps\/details/i.test(url.pathname) && url.searchParams.get("id")) {
        return { valid: true, type: "url", normalized: url.searchParams.get("id").toLowerCase() };
      }
    } catch {}
    return { valid: false, message: "Enter a valid package ID (e.g. com.voodoo.game) or Play Store details URL." };
  }, [singleGameInput]);

  const competitorPubsList = useMemo(() => {
    let list = overview.publishers || [];
    if (scannerCompetitorId && scannerCompetitorId !== "all") {
      const idNum = Number(scannerCompetitorId);
      list = list.filter((p) => Array.isArray(p.list_ids) && p.list_ids.includes(idNum));
    }
    if (competitorPubFilter.trim()) {
      const q = competitorPubFilter.trim().toLowerCase();
      list = list.filter((p) => (p.display_name || p.publisher_name).toLowerCase().includes(q));
    }
    return list;
  }, [overview.publishers, scannerCompetitorId, competitorPubFilter]);

  const searchablePublishers = useMemo(() => {
    const list = overview.publishers || [];
    if (!publisherFilterQuery.trim()) return list;
    const q = publisherFilterQuery.trim().toLowerCase();
    return list.filter((p) => (p.display_name || p.publisher_name).toLowerCase().includes(q));
  }, [overview.publishers, publisherFilterQuery]);

  const selectedPubObj = useMemo(() => {
    if (!selectedSinglePubId) return null;
    return (overview.publishers || []).find((p) => p.id === Number(selectedSinglePubId)) || null;
  }, [overview.publishers, selectedSinglePubId]);

  // Validate Play Store developer links
  const handleValidateLinks = async (rawText = linksInput) => {
    setIsValidating(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/validate`, {
        method: "POST",
        body: JSON.stringify({ links: rawText })
      });
      if (res.ok) {
        const data = await res.json();
        setValidationResult(data);
        return data;
      }
    } catch (err) {
      console.error("Validation error:", err);
    } finally {
      setIsValidating(false);
    }
    return null;
  };

  const handleRemoveInvalidAndDuplicates = () => {
    if (!validationResult?.validation) return;
    const cleanLinks = validationResult.validation
      .filter((v) => v.valid && !v.duplicate)
      .map((v) => v.normalizedUrl);
    const joined = cleanLinks.join("\n");
    setLinksInput(joined);
    handleValidateLinks(joined);
  };

  const handleStartScan = async (overridePayload = null) => {
    try {
      const payload = overridePayload || {
        mode: "batch",
        links: linksInput,
        listIds: scanTargetListIds,
        newListName: scanNewListName.trim() || undefined
      };
      // Optimistically show the progress banner immediately at 0ms
      setScanStatus((prev) => ({
        ...prev,
        running: true,
        state: "scanning",
        phase: "starting",
        completedPublishers: 0,
        totalPublishers: payload.mode === "update_all" ? overview.publishers.length : (Array.isArray(payload.links) ? payload.links.length : prev.totalPublishers || 1),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: "Starting Play Store catalogue scan..."
      }));
      const res = await fetcher(`${API_BASE}/api/play/scan`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        if (data?.scanStatus) {
          setScanStatus(data.scanStatus);
        }
        setValidationResult(null);
        setScanNewListName("");
        setShowScannerModal(false);
        if (data?.createdList?.id) {
          await loadOverview({ fresh: true });
          setSelectedListId(data.createdList.id);
        }
        AtlasFeedback.toast("Play Store scan started.", { tone: "success" });
      } else {
        setScanStatus((prev) => ({ ...prev, running: false, state: "idle", log: "" }));
        AtlasFeedback.toast(data?.error || "Failed to start Play Store scan.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Play scan start failed:", err);
      setScanStatus((prev) => ({ ...prev, running: false, state: "idle", log: "" }));
      AtlasFeedback.toast(err?.message || "Failed to start Play Store scan.", { tone: "danger" });
    }
  };

  const handleRescanList = async (listObj) => {
    if (!listObj || scanStatus.running) return;
    const memberPubs = (overview.publishers || []).filter(
      (p) => Array.isArray(p.list_ids) && p.list_ids.includes(listObj.id)
    );
    if (memberPubs.length === 0) return;
    const urls = memberPubs.map((p) => p.source_url || p.publisher_name).filter(Boolean);
    await handleStartScan({
      mode: "batch",
      links: urls,
      listIds: [listObj.id]
    });
  };

  const handleRescanPublisher = async (pub) => {
    if (!pub || scanStatus.running) return;
    await handleStartScan({
      mode: "batch",
      links: [pub.source_url || pub.publisher_name],
      listIds: Array.isArray(pub.list_ids) ? pub.list_ids : []
    });
  };

  const handleCancelScan = async () => {
    try {
      await fetcher(`${API_BASE}/api/play/cancel-scan`, { method: "POST" });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  };

  // Single Game 1-Click Refresh (patches local state & IndexedDB in-place without re-downloading 3,500+ games)
  const handleRefreshSingleGame = async (pkgOrGame, e) => {
    if (e) e.stopPropagation();
    const pkg = typeof pkgOrGame === "string" ? pkgOrGame : pkgOrGame?.package_name;
    if (!pkg || refreshingPkg) return;
    setRefreshingPkg(pkg);
    try {
      const res = await fetcher(`${API_BASE}/api/play/games/${encodeURIComponent(pkg)}/refresh`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data?.game) {
          const freshGame = data.game;
          setOverview((prev) => {
            const nextGames = (prev.games || []).map((g) => {
              if (g.package_name !== pkg) return g;
              const nextPricing =
                freshGame.manual_price_status === "FREE"
                  ? "free"
                  : freshGame.manual_price_status === "PAID" || freshGame.is_paid === true
                    ? "paid"
                    : freshGame.price_status === "FREE"
                      ? "free"
                      : freshGame.price_status === "PRICE_TBA"
                        ? "tba"
                        : g.pricing;
              return {
                ...g,
                ...freshGame,
                pricing: nextPricing,
                is_manual_price: Boolean(freshGame.manual_price_status || g.is_manual_price),
                rating: freshGame.rating != null ? Number(freshGame.rating) : g.rating,
                review_count: Number(freshGame.ratings_count ?? g.review_count) || 0,
                real_installs: freshGame.real_installs != null ? Number(freshGame.real_installs) : g.real_installs,
                min_installs: Number(freshGame.min_installs ?? g.min_installs) || 0,
                installs_delta_1d: Number(freshGame.installs_delta_1d ?? g.installs_delta_1d) || 0,
                release_date: freshGame.release_date || g.release_date,
                is_suspended: Boolean(freshGame.is_suspended) || freshGame.release_status === "SUSPENDED"
              };
            });
            const nextOverview = { ...prev, games: nextGames };
            void setCachedCatalogue("play_overview", nextOverview, cachedEtagRef.current);
            return nextOverview;
          });
          setActiveGameDrawer((prev) => (prev && prev.package_name === pkg ? { ...prev, ...freshGame } : prev));
          await loadOverview();
        } else {
          await loadOverview();
        }
        AtlasFeedback.toast(`Refreshed ${data?.game?.title || pkg}.`, { tone: "success" });
      } else {
        AtlasFeedback.toast(data?.error || `Failed to refresh ${pkg}.`, { tone: "danger" });
      }
    } catch (err) {
      console.error("Game refresh failed:", err);
      AtlasFeedback.toast(err?.message || `Failed to refresh ${pkg}.`, { tone: "danger" });
    } finally {
      setRefreshingPkg(null);
    }
  };

  // Google Sheet Preview & New-Only Import
  const loadSheetPreview = useCallback(async () => {
    setSheetPreviewError("");
    setIsLoadingSheet(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/sheet-preview`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSheetPreview(data);
        const colsWithNew = (data.columns || [])
          .filter((c) => Number(c.newAccountCount) > 0)
          .map((c) => c.listName);
        setSheetSelectedLists(colsWithNew);
        setSheetShowOnlyNewCols(colsWithNew.length > 0);
      } else {
        setSheetPreviewError(data?.error || "Could not load Google Sheet preview.");
      }
    } catch (err) {
      console.error("Sheet preview error:", err);
      setSheetPreviewError(err?.message || "Could not reach backend to read Google Sheets.");
    } finally {
      setIsLoadingSheet(false);
    }
  }, [fetcher]);

  const openSheetImporter = async () => {
    if (showSheetModal) {
      setShowSheetModal(false);
      return;
    }
    setShowSheetModal(true);
    await loadSheetPreview();
  };

  const handleConfirmSheetImport = async () => {
    if (!sheetPreview || isStartingSheetImport || sheetImportStatus.running) return;
    if (sheetSelectionSummary.newCount === 0) {
      AtlasFeedback.toast("All accounts in the selected sheet columns are already in Atlas.", { tone: "info" });
      return;
    }
    setIsStartingSheetImport(true);
    setSheetPreviewError("");
    try {
      const res = await fetcher(`${API_BASE}/api/play/sheet-import`, {
        method: "POST",
        body: JSON.stringify({
          listNames: sheetSelectedLists,
          autoScanNew: sheetAutoScanNew
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data?.sheetImportStatus) {
          setSheetImportStatus(data.sheetImportStatus);
        }
        setSheetBannerDismissed(false);
        AtlasFeedback.toast(
          sheetAutoScanNew
            ? `Importing & scanning ${sheetSelectionSummary.newCount} new account(s)...`
            : `Importing ${sheetSelectionSummary.newCount} new account(s)...`,
          { tone: "info" }
        );
      } else {
        const msg = data?.error || "Failed to start Google Sheets import.";
        setSheetPreviewError(msg);
        AtlasFeedback.toast(msg, { tone: "danger" });
      }
    } catch (err) {
      console.error("Sheet import failed:", err);
      const msg = err?.message || "Failed to start Google Sheets import.";
      setSheetPreviewError(msg);
      AtlasFeedback.toast(msg, { tone: "danger" });
    } finally {
      setIsStartingSheetImport(false);
    }
  };

  const handleCancelSheetImport = async () => {
    try {
      await fetcher(`${API_BASE}/api/play/sheet-import-cancel`, { method: "POST" });
    } catch (err) {
      console.error("Cancel sheet import failed:", err);
    }
  };

  const handleRetrySheetFailed = async () => {
    if (isStartingSheetImport || sheetImportStatus.running) return;
    const links = Array.isArray(sheetImportStatus.failedLinks) ? sheetImportStatus.failedLinks : [];
    if (links.length === 0) return;
    setIsStartingSheetImport(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/sheet-import`, {
        method: "POST",
        body: JSON.stringify({
          retryLinks: links,
          autoScanNew: true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.sheetImportStatus) {
        setSheetImportStatus(data.sheetImportStatus);
        setSheetBannerDismissed(false);
        AtlasFeedback.toast(`Retrying scan for ${links.length} failed account(s)...`, { tone: "info" });
      } else {
        AtlasFeedback.toast(data?.error || "Failed to retry failed sheet scans.", { tone: "danger" });
      }
    } catch (err) {
      AtlasFeedback.toast(err?.message || "Failed to retry failed sheet scans.", { tone: "danger" });
    } finally {
      setIsStartingSheetImport(false);
    }
  };

  // Batch Country Scanner Queue Controls
  const handleStartCountryQueue = async (overridePayload = null) => {
    const isSingle = overridePayload?.scope === "single" && overridePayload?.packageName;
    if (isSingle) setQueueingCountryPkg(overridePayload.packageName);
    try {
      const payload = overridePayload || {
        scope: countryBatchScope,
        listId: countryBatchScope === "list" && activeListObj ? activeListObj.id : undefined,
        publisherId: countryBatchScope === "publisher" && selectedPublisherObj ? selectedPublisherObj.id : undefined,
        skipDays: countryBatchSkipDays
      };
      setCountryQueueStatus((prev) => ({
        ...prev,
        running: true,
        paused: false,
        state: "running",
        completedPackages: 0,
        totalPackages: Math.max(1, prev.totalPackages || 1),
        log: "Starting batch country availability scan..."
      }));
      const res = await fetcher(`${API_BASE}/api/play/country-queue/start`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data?.status === "nothing_to_scan") {
          setCountryQueueStatus((prev) => ({ ...prev, running: false, state: "idle", totalPackages: 0 }));
          AtlasFeedback.toast("All games in this scope were recently country-scanned.", { tone: "info" });
        } else if (data?.totalPackages) {
          setCountryQueueStatus((prev) => ({
            ...prev,
            running: true,
            state: "running",
            scopeLabel: data.scopeLabel || prev.scopeLabel,
            totalPackages: data.totalPackages,
            skippedPackages: data.skippedPackages || 0
          }));
          AtlasFeedback.toast(`Queued ${data.totalPackages} title${data.totalPackages === 1 ? "" : "s"} for country scan.`, { tone: "success" });
        } else {
          AtlasFeedback.toast("Country availability scan queued.", { tone: "success" });
        }
        setShowCountryBatchModal(false);
      } else {
        setCountryQueueStatus((prev) => ({ ...prev, running: false, state: "idle" }));
        AtlasFeedback.toast(data?.error || "Failed to start country availability scan.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Failed to start country queue:", err);
      setCountryQueueStatus((prev) => ({ ...prev, running: false, state: "idle" }));
      AtlasFeedback.toast(err?.message || "Failed to start country availability scan.", { tone: "danger" });
    } finally {
      if (isSingle) setQueueingCountryPkg(null);
    }
  };

  const handleControlCountryQueue = async (action) => {
    try {
      await fetcher(`${API_BASE}/api/play/country-queue/control`, {
        method: "POST",
        body: JSON.stringify({ action })
      });
      const cqRes = await fetcher(`${API_BASE}/api/play/country-queue/status`);
      if (cqRes.ok) {
        setCountryQueueStatus(await cqRes.json());
      }
    } catch (err) {
      console.error("Country queue control error:", err);
    }
  };

  // Save Create / Edit List modal
  const handleSaveListModal = async (e, openScannerAfter = false) => {
    if (e) e.preventDefault();
    if (!listModal || !listModal.name.trim() || isSavingList) return;
    setIsSavingList(true);
    setListModal((prev) => (prev ? { ...prev, error: null } : null));
    try {
      let targetListId = listModal.listId;
      const savedName = listModal.name.trim();
      const isCreate = listModal.mode === "create";
      if (isCreate) {
        const res = await fetcher(`${API_BASE}/api/play/lists`, {
          method: "POST",
          body: JSON.stringify({
            name: savedName,
            description: listModal.description?.trim() || null,
            publisherIds: listModal.publisherIds || []
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          targetListId = data?.list?.id;
          await loadOverview({ fresh: true });
          if (targetListId) setSelectedListId(targetListId);
          setListModal(null);
          AtlasFeedback.toast(`Created competitor list "${savedName}".`, { tone: "success" });
        } else {
          setListModal((prev) => (prev ? { ...prev, error: data?.error || "Failed to create list." } : null));
          return;
        }
      } else {
        const patchRes = await fetcher(`${API_BASE}/api/play/lists/${listModal.listId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: savedName,
            description: listModal.description?.trim() || null
          })
        });
        if (!patchRes.ok) {
          const patchErr = await patchRes.json().catch(() => ({}));
          setListModal((prev) => (prev ? { ...prev, error: patchErr?.error || "Failed to save list details." } : null));
          return;
        }
        const pubRes = await fetcher(`${API_BASE}/api/play/lists/${listModal.listId}/publishers`, {
          method: "POST",
          body: JSON.stringify({
            action: "set",
            publisherIds: listModal.publisherIds || []
          })
        });
        if (!pubRes.ok) {
          const pubErr = await pubRes.json().catch(() => ({}));
          setListModal((prev) => (prev ? { ...prev, error: pubErr?.error || "Failed to update list publishers." } : null));
          return;
        }
        await loadOverview({ fresh: true });
        setListModal(null);
        AtlasFeedback.toast(`Saved changes to "${savedName}".`, { tone: "success" });
      }

      if (openScannerAfter && targetListId && targetListId !== "new") {
        setScanTargetListIds([Number(targetListId)]);
        setScanNewListName("");
        setShowScannerModal(true);
      }
    } catch (err) {
      console.error("Save list failed:", err);
      setListModal((prev) => (prev ? { ...prev, error: err?.message || "Failed to save list." } : null));
    } finally {
      setIsSavingList(false);
    }
  };

  const handleDeleteList = async (listId) => {
    const ok = await AtlasFeedback.confirm(
      "Delete this competitor list? Publisher accounts and games will remain in Atlas.",
      { title: "Delete Competitor List", confirmLabel: "Delete List", destructive: true }
    );
    if (!ok) return;
    setIsDeletingList(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/lists/${listId}`, { method: "DELETE" });
      if (res.ok) {
        if (Number(selectedListId) === Number(listId)) setSelectedListId("all");
        setListModal(null);
        await loadOverview({ fresh: true });
        AtlasFeedback.toast("Competitor list deleted.", { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        setListModal((prev) => (prev ? { ...prev, error: errData?.error || "Failed to delete list." } : null));
      }
    } catch (err) {
      console.error("Delete list failed:", err);
      setListModal((prev) => (prev ? { ...prev, error: err?.message || "Failed to delete list." } : null));
    } finally {
      setIsDeletingList(false);
    }
  };

  const handleSavePublisherModal = async (e) => {
    e.preventDefault();
    if (!editingPublisher || isSavingPublisher) return;
    setIsSavingPublisher(true);
    setEditingPublisher((prev) => (prev ? { ...prev, error: null } : null));
    try {
      const res = await fetcher(`${API_BASE}/api/play/publishers/${editingPublisher.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editingPublisher.display_name,
          listIds: editingPublisher.list_ids || []
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const label = editingPublisher.display_name?.trim() || editingPublisher.publisher_name;
        await loadOverview({ fresh: true });
        setEditingPublisher(null);
        AtlasFeedback.toast(`Updated publisher "${label}".`, { tone: "success" });
      } else {
        setEditingPublisher((prev) => (prev ? { ...prev, error: data?.error || "Failed to save publisher." } : null));
      }
    } catch (err) {
      console.error("Save publisher failed:", err);
      setEditingPublisher((prev) => (prev ? { ...prev, error: err?.message || "Failed to save publisher." } : null));
    } finally {
      setIsSavingPublisher(false);
    }
  };

  const handleRemoveFromCurrentList = async (pubId, listId = activeListObj?.id) => {
    if (!pubId || !listId || removingPublisherId) return;
    setRemovingPublisherId(pubId);
    try {
      const res = await fetcher(`${API_BASE}/api/play/lists/${listId}/publishers`, {
        method: "POST",
        body: JSON.stringify({
          action: "remove",
          publisherIds: [pubId]
        })
      });
      if (res.ok) {
        if (editingPublisher && editingPublisher.id === pubId) {
          setEditingPublisher((prev) =>
            prev ? { ...prev, list_ids: (prev.list_ids || []).filter((id) => Number(id) !== Number(listId)) } : null
          );
        }
        await loadOverview({ fresh: true });
        AtlasFeedback.toast("Removed publisher from list.", { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        AtlasFeedback.toast(errData?.error || "Failed to remove publisher from list.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Remove from list failed:", err);
      AtlasFeedback.toast(err?.message || "Failed to remove publisher from list.", { tone: "danger" });
    } finally {
      setRemovingPublisherId(null);
    }
  };

  const executeDeletePublisherFromAtlas = async (pub) => {
    if (!pub || !pub.id || isDeletingPub) return;
    setIsDeletingPub(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/publishers/${pub.id}`, { method: "DELETE" });
      if (res.ok) {
        const disp = getDisplayName(pub.publisher_name);
        if (selectedPublisher === pub.publisher_name) setSelectedPublisher("all");
        setConfirmDeletePub(null);
        setEditingPublisher(null);
        await loadOverview({ fresh: true });
        AtlasFeedback.toast(`Deleted "${disp}" from Atlas.`, { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        AtlasFeedback.toast(errData?.error || "Failed to delete publisher.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Delete publisher failed:", err);
      AtlasFeedback.toast(err?.message || "Failed to delete publisher.", { tone: "danger" });
    } finally {
      setIsDeletingPub(false);
    }
  };

  const exportCsv = () => {
    const headers = [
      "Display Name",
      "Play Store Publisher",
      "Package Name",
      "Title",
      "Status",
      "Pricing",
      "Price (USD)",
      "Real Installs",
      "Daily Delta",
      "Rating",
      "Reviews",
      "Countries Live",
      "Play Launch Date",
      "First Discovered (Atlas)",
      "URL"
    ];
    const rows = filteredGames.map((g) => [
      `"${String(getDisplayName(g.publisher_name)).replace(/"/g, '""')}"`,
      `"${String(g.publisher_name || "").replace(/"/g, '""')}"`,
      g.package_name,
      `"${String(g.title || "").replace(/"/g, '""')}"`,
      getAppReleaseStatus(g),
      g.pricing,
      g.price ?? 0,
      g.real_installs ?? g.min_installs ?? 0,
      g.installs_delta_1d ?? 0,
      g.rating ?? "",
      g.review_count ?? 0,
      g.country_scan ? g.country_scan.liveCount : "",
      g.release_date ? String(g.release_date).slice(0, 10) : "",
      g.first_seen_at ? String(g.first_seen_at).slice(0, 10) : "",
      g.url || `https://play.google.com/store/apps/details?id=${encodeURIComponent(g.package_name)}`
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-playstore-games.csv`;
    a.click();
    URL.revokeObjectURL(url);
    AtlasFeedback.toast(`Exported ${rows.length.toLocaleString()} rows to CSV.`, { tone: "success" });
  };

  const scanProgressPct = useMemo(() => {
    const total = Number(scanStatus.totalPublishers) || 0;
    if (!total) return 0;
    const completed = Number(scanStatus.completedPublishers) || 0;
    if (!scanStatus.running && scanStatus.isComplete) return 100;
    const activeFraction = scanStatus.running ? 0.35 : 0.1;
    return Math.min(98, Math.round(((completed + activeFraction) / total) * 100));
  }, [scanStatus]);

  const sheetSelectionSummary = useMemo(() => {
    const cols = sheetPreview?.columns || [];
    const selectedSet = new Set(sheetSelectedLists);
    const uniqueNewUrls = new Set();
    let existingInSelected = 0;
    for (const col of cols) {
      if (!selectedSet.has(col.listName)) continue;
      existingInSelected += Number(col.existingAccountCount || 0);
      for (const acc of col.newAccounts || []) {
        if (acc?.normalizedUrl) uniqueNewUrls.add(acc.normalizedUrl);
      }
    }
    return {
      selectedColsCount: cols.filter((c) => selectedSet.has(c.listName)).length,
      newCount: uniqueNewUrls.size,
      existingCount: existingInSelected
    };
  }, [sheetPreview, sheetSelectedLists]);

  const sheetVisibleColumns = useMemo(() => {
    const cols = [...(sheetPreview?.columns || [])];
    cols.sort((a, b) => {
      const aNew = Number(a.newAccountCount) || 0;
      const bNew = Number(b.newAccountCount) || 0;
      if ((bNew > 0) !== (aNew > 0)) return bNew > 0 ? 1 : -1;
      return bNew - aNew;
    });
    if (sheetShowOnlyNewCols) {
      return cols.filter((c) => Number(c.newAccountCount) > 0);
    }
    return cols;
  }, [sheetPreview, sheetShowOnlyNewCols]);

  const sheetProgressPct = useMemo(() => {
    const { running, state, phase, autoScanNew, totalNewAccounts, importedCount, scannedCount } = sheetImportStatus;
    if (!running && (state === "complete" || state === "cancelled" || state === "error")) return 100;
    if (!running) return 0;
    if (phase === "reading_sheet") return 10;
    const total = Math.max(1, Number(totalNewAccounts) || 1);
    if (phase === "importing") {
      const weight = autoScanNew ? 35 : 95;
      return Math.min(weight, 10 + Math.round((Number(importedCount || 0) / total) * (weight - 10)));
    }
    if (phase === "scanning") {
      return Math.min(98, 35 + Math.round(((Number(scannedCount || 0) + 0.3) / total) * 63));
    }
    return 15;
  }, [sheetImportStatus]);

  const countryQueuePct = useMemo(() => {
    const total = Number(countryQueueStatus.totalPackages) || 0;
    if (!total) return 0;
    const completed = Number(countryQueueStatus.completedPackages) || 0;
    if (countryQueueStatus.state === "complete") return 100;
    const subFraction =
      countryQueueStatus.running && countryQueueStatus.currentCountryTotal > 0
        ? (countryQueueStatus.currentCountryChecked || 0) / countryQueueStatus.currentCountryTotal
        : 0;
    return Math.min(99, Math.round(((completed + subFraction) / total) * 100));
  }, [countryQueueStatus]);

  return (
    <div className="flex flex-col w-full gap-5 atlas-page-enter">
      {/* ALL / GAMES / APPS SEGMENT SWITCHER */}
      <div className="flex items-center gap-1 border-b border-border-subtle pb-1 -mt-1">
        <button
          type="button"
          onClick={() => setAppTypeFilter("all")}
          className={`h-9 px-3.5 text-[13px] font-medium rounded-lg transition-colors relative tabular-nums ${
            appTypeFilter === "all"
              ? "text-text-main font-semibold after:absolute after:bottom-[-5px] after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-btn-primary"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          All ({overview.games.length.toLocaleString()})
        </button>
        <button
          type="button"
          onClick={() => setAppTypeFilter("game")}
          className={`h-9 px-3.5 text-[13px] font-medium rounded-lg transition-colors relative flex items-center gap-1.5 tabular-nums ${
            appTypeFilter === "game"
              ? "text-text-main font-semibold after:absolute after:bottom-[-5px] after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-btn-primary"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          <AtlasIcon name="sports_esports" size={15} />
          Games ({appCounts.games.toLocaleString()})
        </button>
        <button
          type="button"
          onClick={() => setAppTypeFilter("app")}
          className={`h-9 px-3.5 text-[13px] font-medium rounded-lg transition-colors relative flex items-center gap-1.5 tabular-nums ${
            appTypeFilter === "app"
              ? "text-text-main font-semibold after:absolute after:bottom-[-5px] after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-btn-primary"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          <AtlasIcon name="apps" size={15} />
          Apps ({appCounts.apps.toLocaleString()})
        </button>
      </div>

      {/* HEADER */}
      <PageHeader
        title="Play Store Intelligence"
        badge={
          isRefreshingOverview && !loading ? (
            <Badge tone="accent">
              <AtlasIcon name="progress_activity" size={12} className="animate-spin" />
              Syncing
            </Badge>
          ) : null
        }
        actions={
          <>
            {isAdmin && (
              <>
                <button
                  type="button"
                  disabled={scanStatus.running}
                  onClick={() => handleStartScan({ mode: "update_all" })}
                  title={`Refresh all ${overview.publishers.length} Play Store publisher accounts`}
                  className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition disabled:opacity-50"
                >
                  <AtlasIcon name="sync" size={15} className="text-sem-success" />
                  Update all ({overview.publishers.length})
                </button>

                {unscannedPublisherCount > 0 && (
                  <button
                    type="button"
                    disabled={scanStatus.running}
                    onClick={() => handleStartScan({ mode: "unscanned_only" })}
                    title={`Scan ${unscannedPublisherCount} unscanned publisher accounts first`}
                    className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition disabled:opacity-50"
                  >
                    <AtlasIcon name="cloud_sync" size={15} className="text-sem-warning" />
                    Scan Unscanned ({unscannedPublisherCount})
                  </button>
                )}

                <button
                  type="button"
                  onClick={openSheetImporter}
                  title="Import new accounts from Google Sheets and scan them"
                  className={`h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border text-xs font-medium transition ${
                    showSheetModal || sheetImportStatus.running
                      ? "bg-accent/10 border-accent text-text-main"
                      : "bg-surface-solid border-border-subtle text-text-main hover:border-border-strong hover:bg-input-bg"
                  }`}
                >
                  <AtlasIcon name="table_view" size={15} className="text-link" />
                  <span>Google Sheets</span>
                  {sheetImportStatus.running && (
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (selectedPublisherObj) setCountryBatchScope("publisher");
                    else if (activeListObj) setCountryBatchScope("list");
                    else setCountryBatchScope("all");
                    setShowCountryBatchModal(true);
                  }}
                  className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition"
                >
                  <AtlasIcon name="public" size={15} className="text-text-muted" />
                  Country Scan
                </button>

                <button
                  type="button"
                  onClick={() => openListManager(activeListObj || null)}
                  className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition"
                >
                  <AtlasIcon name="folder_managed" size={15} className="text-text-muted" />
                  Lists ({overview.lists.length})
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (activeListObj) {
                      setScanTargetListIds([activeListObj.id]);
                      setScannerCompetitorId(activeListObj.id);
                    } else {
                      setScanTargetListIds([]);
                      setScannerCompetitorId("all");
                    }
                    setScanModalTab("links");
                    setShowScannerModal(true);
                  }}
                  className="h-9 inline-flex items-center gap-1.5 px-3.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition"
                  title="Import and scan individual games, publisher catalogues, or competitor accounts"
                >
                  <AtlasIcon name="travel_explore" size={15} />
                  <span>Import &amp; Scan</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={exportCsv}
              className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition"
            >
              <AtlasIcon name="download" size={15} className="text-text-muted" />
              Export CSV
            </button>
          </>
        }
      />

      {/* LIVE PROGRESS BAR 1: PLAY STORE PUBLISHER SCANNER */}
      {(scanStatus.running ||
        scanStatus.state === "complete" ||
        scanStatus.state === "cancelled" ||
        scanStatus.state === "error") &&
        scanStatus.log && (
          <ScanProgressBanner
            running={scanStatus.running}
            state={scanStatus.state}
            title={
              scanStatus.running
                ? `Scanning ${scanStatus.currentPublisher || "..."} (${scanStatus.completedPublishers || 0}/${scanStatus.totalPublishers || 1} completed)`
                : scanStatus.state === "cancelled"
                ? "Scan Aborted · Partial Results Saved"
                : scanStatus.state === "error"
                ? "Scan Finished with Errors"
                : "Play Store Catalogue Scan Complete"
            }
            phase={scanStatus.running ? scanStatus.phase : null}
            meta={`Elapsed ${formatDurationSec(elapsedSec)} · Synced ${scanStatus.totalGamesSaved || 0} · New ${scanStatus.newGamesDiscovered || 0}`}
            log={scanStatus.log}
            progressPct={scanStatus.totalPublishers > 0 ? (scanStatus.running ? scanProgressPct : 100) : 100}
            onCancel={isAdmin ? handleCancelScan : undefined}
            cancelLabel="Abort & Save"
            onRetryFailed={
              isAdmin
                ? () => handleStartScan({ mode: "batch", links: scanStatus.failedLinks })
                : undefined
            }
            failedCount={
              isAdmin && !scanStatus.running && Array.isArray(scanStatus.failedLinks)
                ? scanStatus.failedLinks.length
                : 0
            }
          />
        )}

      {/* LIVE PROGRESS BAR 1B: DEDICATED GOOGLE SHEETS IMPORT & SCAN PROGRESS */}
      {!sheetBannerDismissed &&
        (sheetImportStatus.running ||
          sheetImportStatus.state === "complete" ||
          sheetImportStatus.state === "cancelled" ||
          sheetImportStatus.state === "error") &&
        sheetImportStatus.log && (
          <ScanProgressBanner
            running={sheetImportStatus.running}
            state={sheetImportStatus.state}
            title={
              sheetImportStatus.running
                ? sheetImportStatus.phase === "reading_sheet"
                  ? "Google Sheets: Reading Competitor Analysis..."
                  : sheetImportStatus.phase === "importing"
                  ? `Importing New Accounts (${sheetImportStatus.importedCount || 0}/${sheetImportStatus.totalNewAccounts || 0})`
                  : `Scanning New Accounts (${sheetImportStatus.scannedCount || 0}/${sheetImportStatus.totalNewAccounts || 0})`
                : sheetImportStatus.state === "cancelled"
                ? "Google Sheets Import Aborted"
                : sheetImportStatus.state === "error"
                ? "Google Sheets Import Finished with Errors"
                : "Google Sheets Import Complete"
            }
            phase={sheetImportStatus.phase}
            meta={`Elapsed ${formatDurationSec(sheetElapsedSec)} · Imported ${sheetImportStatus.importedCount || 0}${
              sheetImportStatus.skippedExisting > 0 ? ` · Skipped ${sheetImportStatus.skippedExisting}` : ""
            }${sheetImportStatus.gamesDiscovered > 0 ? ` · Synced ${sheetImportStatus.gamesDiscovered}` : ""}`}
            log={sheetImportStatus.log}
            progressPct={sheetProgressPct}
            onCancel={isAdmin ? handleCancelSheetImport : undefined}
            cancelLabel="Abort Import"
            onRetryFailed={isAdmin ? handleRetrySheetFailed : undefined}
            failedCount={
              isAdmin && !sheetImportStatus.running && Array.isArray(sheetImportStatus.failedLinks)
                ? sheetImportStatus.failedLinks.length
                : 0
            }
            retryDisabled={isStartingSheetImport}
            onDismiss={!sheetImportStatus.running ? () => setSheetBannerDismissed(true) : undefined}
          />
        )}

      {/* LIVE PROGRESS BAR 2: RESUMABLE BATCH COUNTRY SCANNER QUEUE */}
      {(countryQueueStatus.running ||
        countryQueueStatus.paused ||
        countryQueueStatus.state === "complete" ||
        countryQueueStatus.state === "cancelled" ||
        countryQueueStatus.state === "error") &&
        countryQueueStatus.totalPackages > 0 && (
          <ScanProgressBanner
            running={countryQueueStatus.running}
            state={countryQueueStatus.paused ? "paused" : countryQueueStatus.state}
            title={`Batch Country Scanner (${countryQueueStatus.scopeLabel || "Atlas"}): ${countryQueueStatus.completedPackages}/${countryQueueStatus.totalPackages} games`}
            phase={
              countryQueueStatus.skippedPackages > 0
                ? `${countryQueueStatus.skippedPackages} skipped as fresh`
                : null
            }
            meta={
              countryQueueStatus.running && countryQueueStatus.currentAppTitle
                ? `Current: ${countryQueueStatus.currentAppTitle} (${countryQueueStatus.currentCountryChecked}/${countryQueueStatus.currentCountryTotal} countries)`
                : null
            }
            log={countryQueueStatus.log}
            progressPct={countryQueuePct}
            onCancel={isAdmin && countryQueueStatus.running ? () => handleControlCountryQueue("cancel") : undefined}
            cancelLabel="Cancel Queue"
            onRetryFailed={
              isAdmin
                ? () => handleStartCountryQueue({ scope: "retry_failed", skipDays: 0 })
                : undefined
            }
            failedCount={
              isAdmin && !countryQueueStatus.running ? countryQueueStatus.failedCount || 0 : 0
            }
            actionsExtra={
              isAdmin ? (
                <>
                  {countryQueueStatus.running && (
                    <button
                      type="button"
                      onClick={() => handleControlCountryQueue("pause")}
                      className="h-8 px-3 rounded-lg atlas-badge-warning border text-xs font-medium hover:opacity-90"
                    >
                      Pause
                    </button>
                  )}
                  {countryQueueStatus.paused && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleControlCountryQueue("resume")}
                        className="h-8 px-3 rounded-lg atlas-badge-success border text-xs font-medium hover:opacity-90"
                      >
                        Resume ({countryQueueStatus.remainingPackages} left)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleControlCountryQueue("cancel")}
                        className="h-8 px-3 rounded-lg atlas-badge-danger border text-xs font-medium hover:opacity-90"
                      >
                        Cancel Queue
                      </button>
                    </>
                  )}
                </>
              ) : null
            }
          />
        )}

      {/* INLINE FILTER & SCOPE TOOLBAR (Borderless top strip + hairline dividers) */}
      <div className="flex flex-col gap-3 border-y border-border-subtle py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Competitor List Dropdown */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-1">
                <AtlasIcon name="folder" size={14} />
                Competitor:
              </span>
              <AtlasSelect
                value={selectedListId}
                onChange={(val) => {
                  setSelectedListId(val === "all" || val === "ungrouped" || String(val).startsWith("group_") ? val : Number(val));
                  setSelectedPublisher("all");
                }}
                options={competitorSelectOptions}
                ariaLabel="Select competitor"
                placeholder="All Competitors"
                searchPlaceholder="Search competitors & batches..."
                buttonClassName="max-w-[260px]"
              />
            </div>

            {/* Publisher Account Dropdown */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-1">
                <AtlasIcon name="storefront" size={14} />
                Publisher:
              </span>
              <AtlasSelect
                value={selectedPublisher}
                onChange={(val) => setSelectedPublisher(val)}
                options={publisherSelectOptions}
                ariaLabel="Select publisher"
                placeholder="All Accounts"
                searchPlaceholder="Search publisher accounts..."
                buttonClassName="max-w-[260px]"
              />
            </div>

            {/* Date Range Popover Filter */}
            <div className="relative" ref={dateFilterPopoverRef}>
              <button
                type="button"
                onClick={() => setShowDateFilterPopover((prev) => !prev)}
                className={`h-9 px-3 rounded-lg border text-xs font-medium transition flex items-center gap-1.5 ${
                  durationPreset !== "all"
                    ? "bg-accent/10 text-link border-accent font-semibold"
                    : "bg-surface-solid text-text-main border-border-subtle hover:border-border-strong"
                }`}
                title="Filter games by launch date or discovery date"
              >
                <AtlasIcon name="calendar_today" size={14} className={durationPreset !== "all" ? "text-link" : "text-text-muted"} />
                <span>{durationPreset === "all" ? "Date: All Time" : `Date: ${dateWindow.label}`}</span>
                <AtlasIcon name={showDateFilterPopover ? "expand_less" : "expand_more"} size={14} className="text-text-muted" />
              </button>

              <AnimatePresence>
                {showDateFilterPopover && (
                  <motion.div
                    initial={{ opacity: 0, y: 4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute left-0 top-full mt-1.5 z-50 w-80 sm:w-96 bg-surface-solid border border-border-subtle rounded-xl p-4 shadow-xl flex flex-col gap-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between border-b border-border-subtle pb-2">
                      <span className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                        <AtlasIcon name="calendar_today" size={14} className="text-link" />
                        Date Range Filter
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowDateFilterPopover(false)}
                        aria-label="Close date filter"
                        className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                      >
                        <AtlasIcon name="close" size={15} />
                      </button>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Date Basis</label>
                      <select
                        value={dateBasis}
                        onChange={(e) => setDateBasis(e.target.value)}
                        className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs font-medium text-text-main focus:outline-none focus:border-accent cursor-pointer"
                      >
                        <option value="release_date">Play Store Launch Date</option>
                        <option value="first_seen_at">First Discovered in Atlas</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Presets</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { id: "all", label: "All Time" },
                          { id: "today", label: "Today" },
                          { id: "7d", label: "7 Days" },
                          { id: "14d", label: "14 Days" },
                          { id: "30d", label: "30 Days" },
                          { id: "90d", label: "90 Days" },
                          { id: "6m", label: "6 Months" },
                          { id: "1y", label: "1 Year" },
                          { id: "custom", label: "Custom Range" }
                        ].map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setDurationPreset(p.id);
                              if (p.id !== "custom") setShowDateFilterPopover(false);
                            }}
                            className={`py-1.5 px-2 rounded-lg text-xs font-medium transition ${
                              durationPreset === p.id
                                ? "bg-btn-primary text-btn-primary-fg font-semibold"
                                : "bg-input-bg text-text-muted hover:text-text-main border border-border-subtle"
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {durationPreset === "custom" && (
                      <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                        <label className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Custom Date Range</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="date"
                            value={customStartDate}
                            onChange={(e) => setCustomStartDate(e.target.value)}
                            className="h-9 rounded-lg bg-input-bg border border-border-subtle px-2.5 text-xs text-text-main flex-1 focus:outline-none focus:border-accent"
                          />
                          <span className="text-xs text-text-muted">to</span>
                          <input
                            type="date"
                            value={customEndDate}
                            onChange={(e) => setCustomEndDate(e.target.value)}
                            className="h-9 rounded-lg bg-input-bg border border-border-subtle px-2.5 text-xs text-text-main flex-1 focus:outline-none focus:border-accent"
                          />
                        </div>
                      </div>
                    )}

                    {dateWindow.active && scopedStats.unknownDateCount > 0 && (
                      <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-text-muted pt-1">
                        <input
                          type="checkbox"
                          checked={includeUnknownDates}
                          onChange={(e) => setIncludeUnknownDates(e.target.checked)}
                          className="rounded border-border-subtle"
                        />
                        <span>Include {scopedStats.unknownDateCount} games with unknown dates</span>
                      </label>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t border-border-subtle text-xs text-text-muted">
                      <span className="tabular-nums">
                        Known: <strong className="text-text-main">{scopedStats.knownDateCount.toLocaleString()}</strong>
                        {scopedStats.unknownDateCount > 0 && ` · Unknown: ${scopedStats.unknownDateCount.toLocaleString()}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDurationPreset("all");
                          setShowDateFilterPopover(false);
                        }}
                        className="text-link hover:underline font-medium"
                      >
                        Reset to All Time
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {(selectedListId !== "all" || selectedPublisher !== "all" || durationPreset !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setSelectedListId("all");
                  setSelectedPublisher("all");
                  setDurationPreset("all");
                }}
                className="h-9 px-2.5 rounded-lg bg-surface-solid border border-border-subtle hover:border-sem-danger text-text-muted hover:text-sem-danger text-xs font-medium transition flex items-center gap-1"
                title="Reset all filters to show everything"
              >
                <AtlasIcon name="filter_alt_off" size={14} />
                Reset
              </button>
            )}

            {/* Admin Shortcuts: Competitor Batches + Lists */}
            {isAdmin && (
              <div className="flex items-center gap-1.5">
                {activeGroupObj && (
                  <button
                    type="button"
                    onClick={() => openBatchManager(activeGroupObj)}
                    title={`Edit competitor batch "${activeGroupObj.name}"`}
                    className="h-9 px-2.5 rounded-lg bg-surface-solid border border-border-subtle hover:border-border-strong text-text-main text-xs font-medium transition flex items-center gap-1"
                  >
                    <AtlasIcon name="edit" size={14} />
                    Edit Batch
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openBatchManager(null)}
                  title="Group competitors under a batch (e.g. Trenzy & Gaminator into Bahria)"
                  className="h-9 px-2.5 rounded-lg bg-surface-solid border border-dashed border-border-subtle text-text-muted hover:text-text-main hover:border-border-strong transition flex items-center gap-1 text-xs font-medium"
                >
                  <AtlasIcon name="folder_special" size={14} />
                  + Batch
                </button>
                {activeListObj && (
                  <button
                    type="button"
                    onClick={() => openListManager(activeListObj)}
                    title={`Edit list "${activeListObj.name}"`}
                    className="h-9 px-2.5 rounded-lg bg-surface-solid border border-border-subtle hover:border-border-strong text-text-main text-xs font-medium transition flex items-center gap-1"
                  >
                    <AtlasIcon name="edit" size={14} />
                    Edit List
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openListManager(null)}
                  className="h-9 px-2.5 rounded-lg bg-surface-solid border border-dashed border-border-subtle text-text-muted hover:text-text-main hover:border-border-strong transition flex items-center gap-1 text-xs font-medium"
                >
                  <AtlasIcon name="add" size={14} />
                  New List
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Active Batch Member Competitors Strip */}
        {activeGroupObj && (
          <div className="pt-2.5 border-t border-border-subtle flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-text-muted flex items-center gap-1 mr-1">
                <AtlasIcon name="folder_special" size={14} className="text-link" />
                Batch &ldquo;{activeGroupObj.name}&rdquo; ({(activeGroupObj.competitor_names || []).length}):
              </span>
              {(overview.lists || [])
                .filter((l) => l.competitor_id && (activeGroupObj.competitor_ids || []).map(Number).includes(Number(l.competitor_id)))
                .map((comp) => (
                  <button
                    key={comp.id}
                    type="button"
                    onClick={() => {
                      setSelectedListId(comp.id);
                      setSelectedPublisher("all");
                    }}
                    title={`Switch filter to competitor "${comp.name}" (${comp.account_count || 0} accounts)`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md atlas-badge-accent border text-xs font-medium hover:opacity-90 transition"
                  >
                    <AtlasIcon name="folder" size={12} />
                    <span>{comp.name}</span>
                    <span className="opacity-75 tabular-nums">({comp.account_count || 0})</span>
                  </button>
                ))}
              {(activeGroupObj.competitor_names || []).length === 0 && (
                <span className="text-xs text-text-muted">No competitors assigned to this batch yet.</span>
              )}
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => openBatchManager(activeGroupObj)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-solid border border-border-subtle hover:border-border-strong text-text-main text-xs font-medium transition shrink-0"
              >
                <AtlasIcon name="edit" size={13} />
                Manage Batch Members
              </button>
            )}
          </div>
        )}

        {/* Admin List Quick Action buttons */}
        {isAdmin && activeListObj && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setScanTargetListIds([activeListObj.id]);
                setShowScannerModal(true);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg atlas-badge-accent border text-xs font-medium hover:opacity-90"
            >
              <AtlasIcon name="add_link" size={13} />
              Add Accounts
            </button>
            <button
              type="button"
              disabled={scanStatus.running || !activeListObj.account_count}
              onClick={() => handleRescanList(activeListObj)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg atlas-badge-success border text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <AtlasIcon name="refresh" size={13} />
              Re-scan ({activeListObj.account_count})
            </button>
            <button
              type="button"
              disabled={countryQueueStatus.running || !activeListObj.unique_games}
              onClick={() =>
                handleStartCountryQueue({
                  scope: "list",
                  listId: activeListObj.id,
                  skipDays: countryBatchSkipDays
                })
              }
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg atlas-badge-warning border text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <AtlasIcon name="public" size={13} />
              Scan Countries ({activeListObj.unique_games})
            </button>
          </div>
        )}
      </div>

      {/* 4 CLEAN KPI STRIP (De-cardified single flat panel) */}
      <KpiStrip
        items={[
          {
            key: "total-unique",
            label:
              selectedPublisher !== "all"
                ? `Total Games (${getDisplayName(selectedPublisher)})`
                : activeListObj
                ? `Total Games in "${activeListObj.name}"`
                : "Total Unique Play Games",
            value: scopedStats.allTimeUnique.toLocaleString(),
            note: `${visiblePublishers.length} publisher account${visiblePublishers.length === 1 ? "" : "s"}${
              unscannedPublisherCount > 0 ? ` (${unscannedPublisherCount} unscanned)` : ""
            }`
          },
          {
            key: "period-games",
            label: dateWindow.active
              ? `${dateBasis === "first_seen_at" ? "Discovered" : "Launched"} (${dateWindow.label})`
              : "Games in Selected Period",
            value: scopedStats.matchingUnique.toLocaleString(),
            note: `${scopedStats.freeMatching.toLocaleString()} Free · ${scopedStats.paidMatching.toLocaleString()} Paid${
              scopedStats.tbaMatching > 0 ? ` · ${scopedStats.tbaMatching.toLocaleString()} TBA` : ""
            }`
          },
          {
            key: "real-installs",
            label: `Total Real Installs${dateWindow.active ? ` (${dateWindow.label})` : ""}`,
            value: formatCompactNumber(scopedStats.totalInstalls),
            note: `+${formatCompactNumber(scopedStats.totalDailyDelta)} / day velocity`,
            noteClass: "text-sem-success font-mono"
          },
          {
            key: "country-coverage",
            label: "Country Availability Coverage",
            value: scopedStats.countryScannedCount.toLocaleString(),
            suffix: `/ ${scopedStats.matchingUnique.toLocaleString()}`,
            note: "Queue batch country scan →",
            onClick: () => setShowCountryBatchModal(true)
          }
        ]}
      />

      {/* PUBLISHER COMPARISON (COLLAPSIBLE) */}
      <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden flex flex-col">
        <div
          className={`px-4 py-3 flex flex-wrap items-center justify-between gap-2 ${
            publisherComparisonOpen ? "border-b border-border-subtle" : ""
          }`}
        >
          <button
            type="button"
            aria-expanded={publisherComparisonOpen}
            onClick={togglePublisherComparison}
            className="flex items-center gap-2.5 text-left min-w-0 flex-1 group cursor-pointer"
          >
            <AtlasIcon
              name={publisherComparisonOpen ? "expand_less" : "expand_more"}
              size={16}
              className="text-text-muted group-hover:text-text-main shrink-0 transition-colors"
            />
            <span className="text-sm font-semibold text-text-main shrink-0">
              Publisher Comparison
            </span>
            <span className="text-xs text-text-muted tabular-nums shrink-0">
              {comparisonPublishers.length} accounts
            </span>
            {!publisherComparisonOpen &&
              (selectedPublisher !== "all" || selectedPricing !== "all" || dateWindow.active) && (
                <div className="hidden sm:flex items-center gap-1.5 min-w-0 flex-wrap pl-1">
                  {selectedPublisher !== "all" && (
                    <Badge tone="accent">{getDisplayName(selectedPublisher)}</Badge>
                  )}
                  {selectedPricing !== "all" && (
                    <Badge tone={selectedPricing === "free" ? "success" : "warning"}>
                      {selectedPricing === "free" ? "Free" : "Paid"}
                    </Badge>
                  )}
                  {dateWindow.active && <Badge tone="neutral">{dateWindow.label}</Badge>}
                </div>
              )}
          </button>

          <div className="flex items-center gap-3 text-xs shrink-0">
            {(selectedPublisher !== "all" || selectedPricing !== "all" || durationPreset !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setSelectedPublisher("all");
                  setSelectedPricing("all");
                  setDurationPreset("all");
                }}
                className="text-link font-medium hover:underline cursor-pointer"
              >
                Reset Filters
              </button>
            )}
            {publisherComparisonOpen && (
              <>
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" /> Free
                </span>
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <span className="w-2.5 h-2.5 rounded-sm bg-amber-600 inline-block" /> Paid
                </span>
              </>
            )}
            <button
              type="button"
              onClick={togglePublisherComparison}
              className="text-xs text-text-muted hover:text-text-main font-medium cursor-pointer hidden sm:inline"
            >
              {publisherComparisonOpen ? "Collapse" : "Expand"}
            </button>
          </div>
        </div>

        {publisherComparisonOpen && dateWindow.active && (
          <div className="px-4 py-2 bg-input-bg/25 border-b border-border-subtle text-xs text-text-muted">
            Showing games from: {dateWindow.label}
          </div>
        )}

        {publisherComparisonOpen && (
          <>
            {comparisonPublishers.length === 0 ? (
          <div className="py-10 px-4 text-center text-xs text-text-muted flex flex-col items-center gap-3">
            <span>
              {visiblePublishers.length === 0
                ? "No publisher accounts in this Competitor List yet."
                : `No publisher accounts found with ${appTypeFilter === "all" ? "titles" : appTypeFilter + "s"} in this view.`}
            </span>
            {activeListObj && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openListManager(activeListObj)}
                  className="h-9 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main font-medium hover:border-border-strong"
                >
                  Select Existing Accounts
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScanTargetListIds([activeListObj.id]);
                    setShowScannerModal(true);
                  }}
                  className="h-9 px-3.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg font-semibold"
                >
                  Add &amp; Scan New Links
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {(showAllPublishers ? comparisonPublishers : comparisonPublishers.slice(0, 35)).map((pub) => {
              const pSt = publisherStatsByName.get(pub.publisher_name) || {
                total: Number(pub.total_games) || 0,
                free: Number(pub.free_games) || 0,
                paid: Number(pub.paid_games) || 0,
                installs: Number(pub.total_installs) || 0,
                dailyDelta: Number(pub.daily_installs_delta) || 0,
                allTimeMatching: Number(pub.total_games) || 0,
                allTimeTotal: Number(pub.total_games) || 0
              };
              const effectiveAllTime = appTypeFilter !== "all" ? (pSt.allTimeMatching ?? 0) : (Number(pub.total_games) || 0);
              const total = pSt.total;
              const free = pSt.free === 0 && pSt.paid === 0 && total > 0 ? total : pSt.free;
              const paid = pSt.paid;
              const freeWidthPct = (free / maxPublisherGames) * 100;
              const paidWidthPct = (paid / maxPublisherGames) * 100;
              const isSelected = selectedPublisher === pub.publisher_name;
              const dispName = getDisplayName(pub.publisher_name);
              const hasCustomName = dispName !== pub.publisher_name;
              const syncMeta = getPublisherSyncState(pub);
              const isScanningThisPub =
                scanStatus.running &&
                String(scanStatus.currentPublisher || "").trim().toLowerCase() ===
                  String(pub.publisher_name || "").trim().toLowerCase();

              return (
                <div
                  key={pub.id}
                  className={`px-4 py-3 transition-colors ${
                    isSelected
                      ? "bg-accent/10 border-l-2 border-l-btn-primary"
                      : "hover:bg-input-bg/40"
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    {/* Account Identity & Status */}
                    <div className="md:w-72 shrink-0 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const clearing = isSelected && selectedPricing === "all";
                          setSelectedPublisher(clearing ? "all" : pub.publisher_name);
                          setSelectedPricing("all");
                          if (!clearing) scrollToCatalogIfBelowFold();
                        }}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="text-[13px] font-semibold text-text-main hover:text-link truncate">
                          {dispName}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-text-muted truncate mt-0.5">
                          <span
                            className={`font-medium ${syncMeta.textTone}`}
                            title={syncMeta.warningText || `Last synced: ${syncMeta.lastSyncedText}`}
                          >
                            {syncMeta.dataLabel}
                          </span>
                          <span>· {syncMeta.lastSyncedText}</span>
                          {syncMeta.hasRefreshWarning && (
                            <span title={syncMeta.warningText} className="text-sem-warning inline-flex items-center">
                              <AtlasIcon name="info" size={12} />
                            </span>
                          )}
                          {hasCustomName && <span className="truncate">· {pub.publisher_name}</span>}
                        </div>
                      </button>

                      {isAdmin && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            disabled={scanStatus.running}
                            onClick={() => handleRescanPublisher(pub)}
                            title={`Scan / Refresh Play Store catalogue for ${dispName}`}
                            className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-sem-success transition disabled:opacity-40"
                          >
                            <AtlasIcon
                              name="refresh"
                              size={14}
                              className={isScanningThisPub ? "animate-spin text-sem-success" : ""}
                            />
                          </button>
                          <button
                            type="button"
                            disabled={countryQueueStatus.running || pSt.allTimeTotal === 0}
                            onClick={() =>
                              handleStartCountryQueue({
                                scope: "publisher",
                                publisherId: pub.id,
                                skipDays: countryBatchSkipDays
                              })
                            }
                            title={`Scan Country Availability for all games of ${dispName}`}
                            className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-link transition disabled:opacity-40"
                          >
                            <AtlasIcon name="public" size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setEditingPublisher({
                                id: pub.id,
                                publisher_name: pub.publisher_name,
                                display_name: pub.display_name || "",
                                list_ids: Array.isArray(pub.list_ids) ? [...pub.list_ids] : []
                              })
                            }
                            title="Rename account or assign Parent Competitor"
                            className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main transition"
                          >
                            <AtlasIcon name="edit" size={14} />
                          </button>
                          {activeListObj && (
                            <button
                              type="button"
                              disabled={removingPublisherId === pub.id}
                              onClick={() => handleRemoveFromCurrentList(pub.id, activeListObj.id)}
                              title={`Remove "${dispName}" from list "${activeListObj.name}"`}
                              className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-sem-danger transition disabled:opacity-40"
                            >
                              <AtlasIcon
                                name={removingPublisherId === pub.id ? "progress_activity" : "folder_off"}
                                size={14}
                                className={removingPublisherId === pub.id ? "animate-spin text-sem-danger" : ""}
                              />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Stacked Bar */}
                    <div className="flex-1 flex items-center gap-1 h-7 bg-input-bg rounded-lg p-1 overflow-hidden">
                      {total === 0 ? (
                        <span className="text-[11px] text-text-muted px-2">
                          {effectiveAllTime === 0
                            ? "Unscanned — Click refresh icon to fetch catalogue"
                            : `No ${appTypeFilter === "app" ? "apps" : appTypeFilter === "game" ? "games" : "titles"} in selected period (${effectiveAllTime} all-time)`}
                        </span>
                      ) : (
                        <>
                          {free > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPublisher(pub.publisher_name);
                                setSelectedPricing("free");
                                scrollToCatalogIfBelowFold();
                              }}
                              style={{ width: `${Math.max(freeWidthPct, 3)}%` }}
                              title={`${dispName}: ${free} Free ${appTypeFilter === "app" ? "apps" : "games"} (click to filter)`}
                              className="h-full rounded-md bg-emerald-600 hover:bg-emerald-500 transition flex items-center justify-center text-[11px] font-semibold text-white overflow-hidden whitespace-nowrap px-1 select-none tabular-nums"
                            >
                              {freeWidthPct >= 18 ? `${free} Free` : freeWidthPct >= 10 ? `${free}F` : freeWidthPct >= 5 ? String(free) : ""}
                            </button>
                          )}
                          {paid > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPublisher(pub.publisher_name);
                                setSelectedPricing("paid");
                                scrollToCatalogIfBelowFold();
                              }}
                              style={{ width: `${Math.max(paidWidthPct, 3)}%` }}
                              title={`${dispName}: ${paid} Paid ${appTypeFilter === "app" ? "apps" : "games"} (click to filter)`}
                              className="h-full rounded-md bg-amber-600 hover:bg-amber-500 transition flex items-center justify-center text-[11px] font-semibold text-white overflow-hidden whitespace-nowrap px-1 select-none tabular-nums"
                            >
                              {paidWidthPct >= 18 ? `${paid} Paid` : paidWidthPct >= 10 ? `${paid}P` : paidWidthPct >= 5 ? String(paid) : ""}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {/* Compact Metrics */}
                    <div className="md:w-72 shrink-0 flex items-center justify-between md:justify-end gap-3 text-xs text-text-muted font-mono tabular-nums">
                      <span>
                        <strong className="text-text-main">{total}</strong>
                        {dateWindow.active ? `/${effectiveAllTime}` : (appTypeFilter === "app" ? " apps" : appTypeFilter === "game" ? " games" : " titles")}
                      </span>
                      <span title="Total Real Installs" className="text-sem-success font-semibold">
                        {formatCompactNumber(pSt.installs)}
                      </span>
                      {pSt.dailyDelta > 0 && (
                        <span title="Daily Install Velocity" className="text-link">
                          +{formatCompactNumber(pSt.dailyDelta)}/d
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <AtlasIcon name="star" size={12} className="text-sem-warning" />
                        {pub.avg_rating ? Number(pub.avg_rating).toFixed(1) : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {comparisonPublishers.length > 35 && (
          <div className="px-4 py-3 border-t border-border-subtle bg-input-bg/30 flex justify-center">
            <button
              type="button"
              onClick={() => setShowAllPublishers((prev) => !prev)}
              className="h-8 px-4 rounded-lg bg-surface-solid hover:bg-input-bg border border-border-subtle text-xs font-medium text-text-main transition"
            >
              {showAllPublishers
                ? "Show fewer accounts"
                : `Show all ${comparisonPublishers.length} accounts (+${comparisonPublishers.length - 35} more)`}
            </button>
          </div>
        )}
          </>
        )}
      </div>

      {/* SELECTED PUBLISHER SUMMARY BAR */}
      {selectedPublisherObj && (
        <div className="bg-surface-solid border border-border-subtle rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-main flex flex-wrap items-center gap-2.5">
              <span>Account: {getDisplayName(selectedPublisherObj.publisher_name)}</span>
              {selectedPublisherObj.display_name && (
                <span className="text-xs font-normal text-text-muted">(Play Store: {selectedPublisherObj.publisher_name})</span>
              )}
              {isAdmin && (
                <>
                  <button
                    type="button"
                    disabled={scanStatus.running}
                    onClick={() => handleRescanPublisher(selectedPublisherObj)}
                    className="text-xs text-sem-success hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <AtlasIcon name="refresh" size={13} /> Refresh Catalogue
                  </button>
                  <button
                    type="button"
                    disabled={countryQueueStatus.running}
                    onClick={() =>
                      handleStartCountryQueue({
                        scope: "publisher",
                        publisherId: selectedPublisherObj.id,
                        skipDays: countryBatchSkipDays
                      })
                    }
                    className="text-xs text-sem-warning hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <AtlasIcon name="public" size={13} /> Scan Countries
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingPublisher({
                        id: selectedPublisherObj.id,
                        publisher_name: selectedPublisherObj.publisher_name,
                        display_name: selectedPublisherObj.display_name || "",
                        list_ids: Array.isArray(selectedPublisherObj.list_ids) ? [...selectedPublisherObj.list_ids] : []
                      })
                    }
                    className="text-xs text-link hover:underline inline-flex items-center gap-1"
                  >
                    <AtlasIcon name="edit" size={13} /> Rename / Competitor
                  </button>
                </>
              )}
              <a
                href={selectedPublisherObj.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-link hover:underline inline-flex items-center gap-1"
              >
                Play Store Page <AtlasIcon name="open_in_new" size={13} />
              </a>
            </div>
            <div className="text-xs text-text-muted mt-1 tabular-nums">
              {selectedPublisherObj.total_games} all-time games ({selectedPublisherObj.free_games} Free ·{" "}
              {selectedPublisherObj.paid_games} Paid) ·{" "}
              {Number(selectedPublisherObj.total_installs || 0).toLocaleString()} total installs ·{" "}
              {Number(selectedPublisherObj.total_reviews || 0).toLocaleString()} reviews
            </div>
          </div>
          <div className="flex items-center gap-2">
            {["all", "free", "paid"].map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSelectedPricing(mode)}
                className={`h-8 px-3 rounded-lg text-xs font-medium capitalize transition ${
                  selectedPricing === mode
                    ? "bg-btn-primary text-btn-primary-fg font-semibold"
                    : "bg-input-bg text-text-muted border border-border-subtle hover:text-text-main"
                }`}
              >
                {mode}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSelectedPublisher("all")}
              className="h-8 px-3 rounded-lg text-xs font-medium bg-surface-solid text-text-main border border-border-subtle hover:border-border-strong"
            >
              Show All Accounts
            </button>
          </div>
        </div>
      )}

      {/* GAME DIRECTORY TABLE */}
      <div
        ref={catalogSectionRef}
        className="bg-surface-solid border border-border-subtle rounded-xl p-5 flex flex-col gap-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text-main flex flex-wrap items-center gap-2 tabular-nums">
              <span>
                {appTypeFilter === "app" ? "Play Store Apps" : appTypeFilter === "game" ? "Play Store Games" : "Play Store Catalog"}{" "}
                ({filteredGames.length.toLocaleString()})
              </span>
              {appTypeFilter !== "all" && (
                <Badge tone="success" className="capitalize">
                  {appTypeFilter}s only
                </Badge>
              )}
              {selectedPublisher !== "all" && (
                <Badge tone="accent">
                  <span>{getDisplayName(selectedPublisher)}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedPublisher("all")}
                    className="hover:underline font-semibold ml-1"
                    title="Clear account filter"
                  >
                    Clear
                  </button>
                </Badge>
              )}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <AtlasSelect
              value={selectedPricing}
              onChange={(val) => setSelectedPricing(val)}
              options={pricingSelectOptions}
              ariaLabel="Filter pricing"
              placeholder="All Pricing"
              searchable={false}
            />

            <AtlasSelect
              value={selectedStatus}
              onChange={(val) => setSelectedStatus(val)}
              options={statusSelectOptions}
              ariaLabel="Filter status"
              placeholder="All Statuses"
              searchable={false}
            />

            <AtlasSelect
              value={sortBy}
              onChange={(val) => setSortBy(val)}
              options={sortSelectOptions}
              ariaLabel="Sort catalog"
              placeholder="Sort by"
              searchable={false}
            />

            <div className="relative">
              <AtlasIcon
                name="search"
                size={15}
                className="text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search title, package, publisher..."
                className="h-9 pl-8 pr-3 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-main placeholder:text-text-muted focus:border-accent outline-none transition w-52 sm:w-64"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <TableSkeleton rows={8} cols={isAdmin ? 9 : 8} />
        ) : (
          <>
            <div className="overflow-x-auto border border-border-subtle rounded-xl max-h-[540px] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-input-bg text-text-muted uppercase tracking-wider text-[11px] sticky top-0 z-10 border-b border-border-subtle">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Game</th>
                    <th className="py-3 px-3 font-semibold">Account</th>
                    <th className="py-3 px-3 font-semibold">Competitor</th>
                    <th className="py-3 px-3 text-center font-semibold">Status</th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy("installs")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "installs" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>Real Installs</span>
                        {sortBy === "installs" && <AtlasIcon name="arrow_downward" size={12} />}
                      </button>
                    </th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy(sortBy === "reviews" ? "rating" : "reviews")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "reviews" || sortBy === "rating" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>{sortBy === "rating" ? "Rating (Sorted)" : "Rating & Reviews"}</span>
                        {(sortBy === "reviews" || sortBy === "rating") && <AtlasIcon name="arrow_downward" size={12} />}
                      </button>
                    </th>
                    <th className="py-3 px-3 text-center font-semibold">Countries</th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy("release")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "release" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>Launch Date</span>
                        {sortBy === "release" && <AtlasIcon name="arrow_downward" size={12} />}
                      </button>
                    </th>
                    {isAdmin && <th className="py-3 px-3 text-right font-semibold">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {filteredGames.slice(0, visibleRowCount).map((g) => {
                    const isRefreshing = refreshingPkg === g.package_name;
                    const releaseStatus = getAppReleaseStatus(g);
                    return (
                      <tr
                        key={`${g.package_name}-${g.publisher_id || g.publisher_name}`}
                        onClick={() => setActiveGameDrawer(g)}
                        className="hover:bg-input-bg/50 cursor-pointer transition-colors"
                      >
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-3 min-w-0">
                            {g.icon && (
                              <img
                                src={g.icon}
                                alt=""
                                className="w-9 h-9 rounded-lg object-cover shrink-0 border border-border-subtle"
                                loading="lazy"
                                decoding="async"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="text-[13px] font-semibold text-text-main truncate max-w-xs flex items-center gap-1.5">
                                <span className="truncate">{g.title}</span>
                                {releaseStatus === "PRE_REGISTERED" && (
                                  <Badge tone="accent" title="Google Play Pre-Registration title">
                                    Pre-Reg
                                  </Badge>
                                )}
                                {g.pricing === "paid" && (
                                  <Badge
                                    tone="warning"
                                    className="font-mono tabular-nums"
                                    title={
                                      g.is_manual_price
                                        ? `Paid (Manual override by ${g.manual_price_by || "admin"})`
                                        : Number(g.price || 0) > 0
                                        ? `Paid app · $${Number(g.price).toFixed(2)}`
                                        : `Paid app · ${g.price_text || "On Offer ($0.00)"}`
                                    }
                                  >
                                    {g.price != null && Number(g.price) > 0
                                      ? `$${Number(g.price).toFixed(2)}`
                                      : g.price_text && g.price_text.includes("Offer")
                                      ? "Offer"
                                      : "Paid"}
                                    {g.is_manual_price ? " · Manual" : ""}
                                  </Badge>
                                )}
                                {g.pricing === "tba" && (
                                  <Badge tone="neutral" title="Pre-registration title · Launch price TBA">
                                    Price TBA
                                  </Badge>
                                )}
                                {g.monetization_hint === "LIKELY_PAID" && (
                                  <Badge
                                    tone="neutral"
                                    className="cursor-help"
                                    title={g.monetization_hint_evidence ? `Likely Paid: "${g.monetization_hint_evidence}"` : "Likely Paid based on developer metadata"}
                                  >
                                    Likely Paid
                                  </Badge>
                                )}
                                {(g.has_campaign || g.campaign_active) && releaseStatus !== "SUSPENDED" && !g.is_suspended && (
                                  <Badge
                                    tone="accent"
                                    className="cursor-help"
                                    title={
                                      g.campaign_source === "transparency_center"
                                        ? "Advertising campaign detected via Google Ads Transparency Center."
                                        : "Advertising campaign record imported via Google Ads Transparency Center sheets."
                                    }
                                  >
                                    Ads
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-1 text-[11px] font-mono text-text-muted mt-0.5">
                                <span className="truncate max-w-[200px]">{g.package_name}</span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyPackageId(g.package_name, e)}
                                  title="Copy package ID"
                                  aria-label={`Copy ${g.package_name}`}
                                  className="p-0.5 rounded hover:bg-input-bg text-text-muted hover:text-link transition shrink-0"
                                >
                                  <AtlasIcon
                                    name={copiedPkg === g.package_name ? "check" : "content_copy"}
                                    size={12}
                                    className={copiedPkg === g.package_name ? "text-sem-success" : ""}
                                  />
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-text-muted">{getDisplayName(g.publisher_name)}</td>

                        <td className="py-2.5 px-3">
                          {(() => {
                            const compNames = getCompetitorNamesForGame(g);
                            const primaryComp = g.competitor_name || compNames[0];
                            if (!primaryComp) {
                              return <span className="text-text-muted text-xs">—</span>;
                            }
                            return (
                              <div className="inline-flex items-center gap-1">
                                <Badge
                                  tone="accent"
                                  title={
                                    compNames.length > 1
                                      ? `Parent Competitor: ${primaryComp} (Also listed in Google Sheet under: ${compNames.slice(1).join(", ")})`
                                      : `Parent Competitor: ${primaryComp}`
                                  }
                                >
                                  {primaryComp}
                                </Badge>
                                {compNames.length > 1 && (
                                  <span
                                    className="text-sem-warning cursor-help inline-flex items-center"
                                    title={`Account "${g.publisher_name}" is listed in multiple Google Sheet competitor columns (${compNames.join(" & ")}). Edit account to confirm single parent competitor.`}
                                  >
                                    <AtlasIcon name="warning" size={13} />
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        <td className="py-2.5 px-3 text-center">
                          {releaseStatus === "SUSPENDED" ? (
                            <Badge tone="danger" title="App is unpublished or suspended on Google Play">
                              Unpublished
                            </Badge>
                          ) : releaseStatus === "PRE_REGISTERED" ? (
                            <Badge tone="accent" title="App is currently in Pre-Registration on Google Play">
                              Pre-Reg
                            </Badge>
                          ) : releaseStatus === "EARLY_ACCESS" ? (
                            <Badge tone="warning" title="App is in Early Access on Google Play">
                              Early Access
                            </Badge>
                          ) : (
                            <Badge tone="success" title="App is Live on Google Play">
                              Live
                            </Badge>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono font-semibold text-text-main tabular-nums">
                          {releaseStatus === "PRE_REGISTERED" && !g.real_installs ? (
                            <span className="text-text-muted text-xs font-sans font-normal">Pre-Reg</span>
                          ) : g.real_installs != null
                            ? Number(g.real_installs).toLocaleString()
                            : g.installs || Number(g.min_installs || 0).toLocaleString()}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                          <span className="inline-flex items-center justify-end gap-1">
                            {g.rating ? (
                              <span className="inline-flex items-center gap-1 text-text-main font-medium">
                                <AtlasIcon name="star" size={12} className="text-sem-warning" />
                                {Number(g.rating).toFixed(1)}
                              </span>
                            ) : (
                              <span>—</span>
                            )}
                            <span className="text-text-muted text-[11px]">
                              ({Number(g.review_count || 0).toLocaleString()})
                            </span>
                          </span>
                        </td>

                        <td className="py-2.5 px-3 text-center">
                          {g.country_scan ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onOpenCountryScan) onOpenCountryScan(g.package_name);
                              }}
                              title="Click to open Country Availability breakdown"
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md atlas-badge-success border text-[11px] font-mono font-medium tabular-nums hover:opacity-90"
                            >
                              <AtlasIcon name="public" size={12} />
                              {g.country_scan.liveCount}/176
                            </button>
                          ) : isAdmin ? (
                            <button
                              type="button"
                              disabled={countryQueueStatus.running || queueingCountryPkg === g.package_name}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartCountryQueue({
                                  scope: "single",
                                  packageName: g.package_name,
                                  skipDays: 0
                                });
                              }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-input-bg border border-border-subtle text-text-muted hover:text-text-main hover:border-border-strong text-[11px] font-medium disabled:opacity-40"
                            >
                              {queueingCountryPkg === g.package_name && (
                                <AtlasIcon name="progress_activity" size={11} className="animate-spin" />
                              )}
                              {queueingCountryPkg === g.package_name ? "Queueing..." : "Scan Countries"}
                            </button>
                          ) : (
                            <span className="text-text-muted text-xs">—</span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-text-muted tabular-nums">
                          {g.release_date ? String(g.release_date).slice(0, 10) : "Unknown"}
                        </td>

                        {isAdmin && (
                          <td className="py-2.5 px-3 text-right">
                            <button
                              type="button"
                              disabled={isRefreshing}
                              onClick={(e) => handleRefreshSingleGame(g.package_name, e)}
                              title="Refresh game installs, velocity & release date"
                              className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-sem-success transition disabled:opacity-40"
                            >
                              <AtlasIcon
                                name="refresh"
                                size={14}
                                className={isRefreshing ? "animate-spin text-sem-success" : ""}
                              />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredGames.length > visibleRowCount && (
              <div className="flex items-center justify-between gap-2 pt-1 text-xs text-text-muted">
                <span className="tabular-nums">
                  Showing <strong className="text-text-main">{visibleRowCount}</strong> of{" "}
                  <strong className="text-text-main">{filteredGames.length.toLocaleString()}</strong> titles
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVisibleRowCount((c) => c + 150)}
                    className="h-8 px-3 rounded-lg bg-input-bg hover:bg-surface-solid border border-border-subtle text-text-main font-medium transition"
                  >
                    Show +150 More
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibleRowCount(filteredGames.length)}
                    className="h-8 px-3 rounded-lg bg-input-bg hover:bg-surface-solid border border-border-subtle text-text-muted hover:text-text-main font-medium transition"
                  >
                    Show All ({filteredGames.length.toLocaleString()})
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ===================================================================== */}
      {/* PORTAL MODALS & DRAWERS (Rendered at document.body above header z-50) */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {/* MODAL 1: MANAGE COMPETITOR LISTS (z-[100]) */}
          {listModal && (
            <motion.div
              key="play-list-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setListModal(null)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.form
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => handleSaveListModal(e, false)}
                className="w-full max-w-lg bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[15px] font-semibold text-text-main">Manage Play Store Competitor Lists</h3>
                  <button
                    type="button"
                    onClick={() => setListModal(null)}
                    aria-label="Close competitor list modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-text-muted">Select List to Edit or Create New</label>
                  <select
                    value={listModal.mode === "create" ? "new" : listModal.listId}
                    onChange={(e) => handleSelectListInModal(e.target.value)}
                    className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs font-medium text-text-main focus:outline-none focus:border-accent"
                  >
                    <option value="new">+ Create New Competitor List</option>
                    {(overview.lists || []).map((l) => (
                      <option key={l.id} value={l.id}>
                        Edit List: {l.name} ({l.account_count} accounts)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-text-muted">List Name</label>
                  <input
                    type="text"
                    required
                    value={listModal.name}
                    onChange={(e) => setListModal({ ...listModal, name: e.target.value, error: null })}
                    placeholder="e.g. Top Simulation Competitors"
                    className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs text-text-main focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-text-muted">Notes / Description (Optional)</label>
                  <input
                    type="text"
                    value={listModal.description || ""}
                    onChange={(e) => setListModal({ ...listModal, description: e.target.value })}
                    placeholder="Optional notes about this competitor group..."
                    className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs text-text-main focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-muted">
                      Existing Accounts in Atlas ({(listModal.publisherIds || []).length} selected)
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setListModal({
                            ...listModal,
                            publisherIds: (overview.publishers || []).map((p) => p.id)
                          })
                        }
                        className="text-xs text-link hover:underline"
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        onClick={() => setListModal({ ...listModal, publisherIds: [] })}
                        className="text-xs text-text-muted hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="max-h-48 overflow-y-auto border border-border-subtle rounded-xl divide-y divide-border-subtle bg-input-bg/40">
                    {(overview.publishers || []).map((p) => {
                      const checked = (listModal.publisherIds || []).includes(p.id);
                      const disp = getDisplayName(p.publisher_name);
                      return (
                        <label
                          key={p.id}
                          className="px-3.5 py-2 flex items-center justify-between gap-3 cursor-pointer hover:bg-input-bg text-xs"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const cur = listModal.publisherIds || [];
                                setListModal({
                                  ...listModal,
                                  publisherIds: checked ? cur.filter((id) => id !== p.id) : [...cur, p.id]
                                });
                              }}
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-text-main truncate">{disp}</div>
                              {disp !== p.publisher_name && (
                                <div className="text-[11px] text-text-muted truncate">Play Store: {p.publisher_name}</div>
                              )}
                            </div>
                          </div>
                          <span className="text-[11px] font-mono text-text-muted shrink-0 tabular-nums">
                            {p.total_games} games · {formatCompactNumber(p.total_installs)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-input-bg/60 border border-border-subtle flex items-center justify-between gap-3">
                  <div className="text-xs text-text-main">
                    Want to scan <strong>brand-new Play Store developer links</strong> into this list?
                  </div>
                  <button
                    type="button"
                    disabled={!listModal.name.trim() || isSavingList}
                    onClick={(e) => handleSaveListModal(e, true)}
                    className="h-8 px-3 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold shrink-0 disabled:opacity-50"
                  >
                    {listModal.mode === "create" ? "Create & Add Links →" : "Save & Add Links →"}
                  </button>
                </div>

                {listModal.error && (
                  <div className="p-3 rounded-xl atlas-badge-danger border text-xs font-medium">
                    {listModal.error}
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle">
                  {listModal.mode === "edit" ? (
                    <button
                      type="button"
                      disabled={isDeletingList || isSavingList}
                      onClick={() => handleDeleteList(listModal.listId)}
                      className="h-9 inline-flex items-center gap-1.5 px-3.5 rounded-lg atlas-badge-danger border text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                    >
                      {isDeletingList && <AtlasIcon name="progress_activity" size={14} className="animate-spin" />}
                      {isDeletingList ? "Deleting..." : "Delete List"}
                    </button>
                  ) : (
                    <div />
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setListModal(null)}
                      className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingList}
                      className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold disabled:opacity-50"
                    >
                      {isSavingList ? "Saving..." : listModal.mode === "create" ? "Create List" : "Save List"}
                    </button>
                  </div>
                </div>
              </motion.form>
            </motion.div>
          )}

          {/* MODAL 2: IMPORT & SCAN PLAY STORE (4-IN-1 MULTI-SCOPE SCANNER) (z-[100]) */}
          {isAdmin && showScannerModal && (
            <motion.div
              key="play-scanner-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setShowScannerModal(false)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-2xl bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-5 shadow-2xl max-h-[92vh] overflow-y-auto"
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-input-bg border border-border-subtle flex items-center justify-center text-text-main">
                      <AtlasIcon name="travel_explore" size={18} />
                    </div>
                    <div>
                      <h3 className="text-[15px] font-semibold text-text-main">Import &amp; Scan Play Store</h3>
                      <p className="text-xs text-text-muted">
                        Import new titles, refresh catalogues, or sync telemetry across multiple scopes.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowScannerModal(false)}
                    aria-label="Close scanner modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main transition"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                {/* 4 Scope Tabs */}
                <div className="flex items-center gap-1 p-1 bg-input-bg border border-border-subtle rounded-lg text-xs overflow-x-auto">
                  <button
                    type="button"
                    onClick={() => setScanModalTab("links")}
                    className={`flex-1 min-w-[120px] py-1.5 px-3 rounded-md font-medium transition flex items-center justify-center gap-1.5 ${
                      scanModalTab === "links"
                        ? "bg-surface-solid text-text-main font-semibold shadow-sm border border-border-subtle"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    <AtlasIcon name="link" size={15} />
                    <span>By Link / ID</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScanModalTab("single_game")}
                    className={`flex-1 min-w-[120px] py-1.5 px-3 rounded-md font-medium transition flex items-center justify-center gap-1.5 ${
                      scanModalTab === "single_game"
                        ? "bg-surface-solid text-text-main font-semibold shadow-sm border border-border-subtle"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    <AtlasIcon name="sports_esports" size={15} />
                    <span>Individual Game</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScanModalTab("competitor")}
                    className={`flex-1 min-w-[120px] py-1.5 px-3 rounded-md font-medium transition flex items-center justify-center gap-1.5 ${
                      scanModalTab === "competitor"
                        ? "bg-surface-solid text-text-main font-semibold shadow-sm border border-border-subtle"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    <AtlasIcon name="folder_shared" size={15} />
                    <span>By Competitor</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScanModalTab("publisher")}
                    className={`flex-1 min-w-[120px] py-1.5 px-3 rounded-md font-medium transition flex items-center justify-center gap-1.5 ${
                      scanModalTab === "publisher"
                        ? "bg-surface-solid text-text-main font-semibold shadow-sm border border-border-subtle"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    <AtlasIcon name="storefront" size={15} />
                    <span>Publisher Account</span>
                  </button>
                </div>

                {/* TAB 1: BY LINK OR PACKAGE ID */}
                {scanModalTab === "links" && (
                  <div className="flex flex-col gap-4 atlas-tab-swap">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-text-muted">
                        Paste Play Store URLs, Package IDs, or Developer Links (one per line):
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const sample = [
                            "https://play.google.com/store/apps/details?id=com.rovio.angrybirds",
                            "com.voodoo.paperio2",
                            "https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio"
                          ].join("\n");
                          setLinksInput(sample);
                          handleValidateLinks(sample);
                        }}
                        className="text-xs font-medium text-link hover:underline"
                      >
                        Load Sample Links
                      </button>
                    </div>

                    <textarea
                      rows={5}
                      value={linksInput}
                      onChange={(e) => setLinksInput(e.target.value)}
                      placeholder="https://play.google.com/store/apps/details?id=com.rovio.angrybirds&#10;com.supercell.clashroyale&#10;https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio"
                      className="w-full rounded-lg bg-input-bg border border-border-subtle p-3 text-xs font-mono text-text-main focus:outline-none focus:border-accent leading-relaxed"
                    />

                    {/* List Assignment */}
                    <div className="bg-input-bg/60 border border-border-subtle rounded-xl p-3.5 flex flex-col gap-2.5">
                      <div className="text-xs font-semibold text-text-main flex items-center justify-between">
                        <span>Assign Scanned Items to Competitor List(s)</span>
                        <span className="text-[11px] text-text-muted font-normal">Optional</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 max-h-24 overflow-y-auto">
                        {(overview.lists || []).map((list) => {
                          const checked = scanTargetListIds.includes(list.id);
                          return (
                            <button
                              key={list.id}
                              type="button"
                              onClick={() =>
                                setScanTargetListIds((prev) =>
                                  checked ? prev.filter((id) => id !== list.id) : [...prev, list.id]
                                )
                              }
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                                checked
                                  ? "atlas-badge-success border font-semibold"
                                  : "bg-surface-solid text-text-muted border-border-subtle hover:text-text-main"
                              }`}
                            >
                              <AtlasIcon
                                name={checked ? "check_box" : "check_box_outline_blank"}
                                size={13}
                              />
                              {list.name}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                        <span className="text-xs text-text-muted shrink-0">Or create &amp; assign to new list:</span>
                        <input
                          type="text"
                          value={scanNewListName}
                          onChange={(e) => setScanNewListName(e.target.value)}
                          placeholder="e.g. Trenzy / Bahria"
                          className="h-9 rounded-lg bg-surface-solid border border-border-subtle px-3 text-xs text-text-main flex-1 focus:outline-none focus:border-accent"
                        />
                      </div>
                    </div>

                    {/* Validation Preview Card */}
                    {validationResult && (
                      <div className="border border-border-subtle rounded-xl overflow-hidden">
                        <div className="bg-input-bg px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-text-main tabular-nums">
                            Validation: {validationResult.validCount} Valid ({validationResult.gamesCount || 0} Games, {validationResult.publishersCount || 0} Publishers) · {validationResult.duplicateCount} Duplicates · {validationResult.invalidCount} Invalid
                          </span>
                          {(validationResult.invalidCount > 0 || validationResult.duplicateCount > 0) && (
                            <button
                              type="button"
                              onClick={handleRemoveInvalidAndDuplicates}
                              className="text-xs text-sem-warning font-semibold hover:underline"
                            >
                              Clean Invalid/Duplicates
                            </button>
                          )}
                        </div>
                        <div className="max-h-36 overflow-y-auto divide-y divide-border-subtle text-xs">
                          {validationResult.validation.map((item, idx) => (
                            <div key={idx} className="px-4 py-2 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium text-text-main truncate flex items-center gap-1.5">
                                  <AtlasIcon
                                    name={item.type === "game" ? "sports_esports" : "storefront"}
                                    size={14}
                                    className="text-text-muted shrink-0"
                                  />
                                  {item.valid ? (item.type === "game" ? item.packageName : item.publisher) : item.raw}
                                </div>
                                <div className="text-[11px] text-text-muted truncate">
                                  {item.valid ? item.normalizedUrl : item.reason}
                                </div>
                              </div>
                              <Badge
                                tone={
                                  !item.valid
                                    ? "danger"
                                    : item.duplicate
                                    ? "warning"
                                    : "success"
                                }
                              >
                                {!item.valid ? "Invalid" : item.duplicate ? "Duplicate" : item.type === "game" ? "Game" : "Publisher"}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle">
                      <button
                        type="button"
                        disabled={!linksInput.trim() || isValidating}
                        onClick={() => handleValidateLinks(linksInput)}
                        className="h-9 px-3.5 rounded-lg bg-input-bg border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong transition disabled:opacity-50"
                      >
                        {isValidating ? "Validating..." : "Validate Links"}
                      </button>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowScannerModal(false)}
                          className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!linksInput.trim() || scanStatus.running}
                          onClick={() => handleStartScan()}
                          className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition disabled:opacity-50"
                        >
                          {scanStatus.running ? "Scan Running..." : "Validate & Start Scan"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 2: INDIVIDUAL GAME */}
                {scanModalTab === "single_game" && (
                  <div className="flex flex-col gap-4 atlas-tab-swap">
                    <div className="p-3.5 rounded-xl bg-input-bg/70 border border-border-subtle flex items-start gap-3">
                      <AtlasIcon name="info" size={18} className="text-link shrink-0 mt-0.5" />
                      <div className="text-xs text-text-muted leading-relaxed">
                        <strong className="text-text-main font-semibold">1-Click Game Telemetry Refresh:</strong>{" "}
                        Enter an individual package ID or Play Store game URL. Atlas will fetch the listing, link or create its publisher, update pricing/ratings, and refresh install velocity telemetry — without scanning the publisher&apos;s entire catalogue.
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-text-main">
                        Google Play Game Package ID or Listing URL
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={singleGameInput}
                          onChange={(e) => setSingleGameInput(e.target.value)}
                          placeholder="e.g. com.voodoo.paperio2 or https://play.google.com/store/apps/details?id=..."
                          className="h-10 w-full rounded-lg bg-input-bg border border-border-subtle pl-3 pr-28 text-xs font-mono text-text-main focus:outline-none focus:border-accent"
                        />
                        {singleGameInput.trim() && (
                          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                            <Badge tone={singleGameValidation.valid ? "success" : "warning"}>
                              {singleGameValidation.valid ? "Valid Package" : "Format Check"}
                            </Badge>
                          </div>
                        )}
                      </div>
                      {singleGameValidation.normalized && (
                        <div className="text-xs text-text-muted font-mono">
                          Target Package: <span className="text-link font-semibold">{singleGameValidation.normalized}</span>
                        </div>
                      )}
                    </div>

                    {/* Optional Competitor List */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-text-muted">
                        Optionally assign to Competitor List:
                      </label>
                      <select
                        value={singleGameListId}
                        onChange={(e) => setSingleGameListId(e.target.value)}
                        className="h-9 px-3 rounded-lg bg-input-bg border border-border-subtle text-text-main text-xs font-medium focus:border-accent focus:outline-none"
                      >
                        <option value="">None (Don&apos;t assign to list)</option>
                        {(overview.lists || []).map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-subtle">
                      <button
                        type="button"
                        onClick={() => setShowScannerModal(false)}
                        className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!singleGameValidation.valid || scanStatus.running}
                        onClick={() => {
                          const pkg = singleGameValidation.normalized;
                          handleStartScan({
                            mode: "batch",
                            links: [pkg],
                            listIds: singleGameListId ? [Number(singleGameListId)] : []
                          });
                          setSingleGameInput("");
                        }}
                        className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        <AtlasIcon name="download" size={15} />
                        Import &amp; Refresh Game
                      </button>
                    </div>
                  </div>
                )}

                {/* TAB 3: BY COMPETITOR */}
                {scanModalTab === "competitor" && (
                  <div className="flex flex-col gap-4 atlas-tab-swap">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-text-main">Select Competitor:</label>
                      <select
                        value={scannerCompetitorId}
                        onChange={(e) => setScannerCompetitorId(e.target.value)}
                        className="h-9 px-3 rounded-lg bg-input-bg border border-border-subtle text-text-main text-xs font-medium focus:border-accent focus:outline-none cursor-pointer"
                      >
                        <option value="all">All Tracked Competitors ({overview.publishers.length} accounts)</option>
                        {(overview.lists || []).map((list) => (
                          <option key={list.id} value={list.id}>
                            {list.name} ({list.account_count || 0} accounts)
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Account Selector & Checkboxes */}
                    <div className="border border-border-subtle rounded-xl overflow-hidden flex flex-col">
                      <div className="bg-input-bg px-3.5 py-2.5 border-b border-border-subtle flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-text-main tabular-nums">
                          Accounts in Scope ({selectedCompetitorPubIds.length} of {competitorPubsList.length} selected)
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedCompetitorPubIds(competitorPubsList.map((p) => p.id))}
                            className="text-xs font-medium text-link hover:underline"
                          >
                            Select All
                          </button>
                          <span className="text-text-muted">·</span>
                          <button
                            type="button"
                            onClick={() => setSelectedCompetitorPubIds([])}
                            className="text-xs font-medium text-text-muted hover:underline"
                          >
                            Deselect All
                          </button>
                        </div>
                      </div>

                      {/* Filter inside competitor accounts */}
                      <div className="p-2 border-b border-border-subtle bg-surface-solid">
                        <input
                          type="text"
                          value={competitorPubFilter}
                          onChange={(e) => setCompetitorPubFilter(e.target.value)}
                          placeholder="Filter accounts by name..."
                          className="h-8 w-full rounded-lg bg-input-bg border border-border-subtle px-3 text-xs text-text-main focus:outline-none focus:border-accent"
                        />
                      </div>

                      {/* Accounts Checklist */}
                      <div className="max-h-52 overflow-y-auto divide-y divide-border-subtle">
                        {competitorPubsList.length === 0 ? (
                          <div className="p-6 text-center text-xs text-text-muted">
                            No publisher accounts found in this competitor list.
                          </div>
                        ) : (
                          competitorPubsList.map((pub) => {
                            const checked = selectedCompetitorPubIds.includes(pub.id);
                            const isUnscanned = !pub.total_games && pub.last_scan_status === "unscanned";
                            return (
                              <label
                                key={pub.id}
                                className={`px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-input-bg/60 transition ${
                                  checked ? "bg-accent/5" : ""
                                }`}
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      setSelectedCompetitorPubIds((prev) =>
                                        checked ? prev.filter((id) => id !== pub.id) : [...prev, pub.id]
                                      );
                                    }}
                                    className="rounded border-border-subtle"
                                  />
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold text-text-main truncate">
                                      {getDisplayName(pub.publisher_name)}
                                    </div>
                                    <div className="text-[11px] text-text-muted truncate">
                                      {pub.developer_id ? `dev?id=${pub.developer_id}` : pub.publisher_name}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-input-bg text-text-muted tabular-nums">
                                    {pub.game_count || pub.total_games || 0} games
                                  </span>
                                  {isUnscanned ? (
                                    <Badge tone="warning">Unscanned</Badge>
                                  ) : (
                                    <Badge tone="success">Synced {formatRelativeTime(pub.last_scanned_at)}</Badge>
                                  )}
                                </div>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-between gap-2 pt-3 border-t border-border-subtle">
                      <span className="text-xs text-text-muted tabular-nums">
                        Will scan <strong className="text-text-main">{selectedCompetitorPubIds.length}</strong> publisher catalogues
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowScannerModal(false)}
                          className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={selectedCompetitorPubIds.length === 0 || scanStatus.running}
                          onClick={() => {
                            const listIdNum = scannerCompetitorId !== "all" ? Number(scannerCompetitorId) : undefined;
                            handleStartScan({
                              mode: "batch",
                              publisherIds: selectedCompetitorPubIds,
                              listIds: listIdNum ? [listIdNum] : []
                            });
                          }}
                          className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          <AtlasIcon name="sync" size={15} />
                          Scan Selected Accounts ({selectedCompetitorPubIds.length})
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 4: INDIVIDUAL PUBLISHER ACCOUNT */}
                {scanModalTab === "publisher" && (
                  <div className="flex flex-col gap-4 atlas-tab-swap">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-text-main">
                        Select Publisher Account ({searchablePublishers.length} accounts):
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={publisherFilterQuery}
                          onChange={(e) => setPublisherFilterQuery(e.target.value)}
                          placeholder="Search publishers by name..."
                          className="h-9 w-full rounded-lg bg-input-bg border border-border-subtle pl-3 pr-8 text-xs text-text-main focus:outline-none focus:border-accent"
                        />
                        <AtlasIcon
                          name="search"
                          size={15}
                          className="text-text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                        />
                      </div>

                      <select
                        size={5}
                        value={selectedSinglePubId}
                        onChange={(e) => setSelectedSinglePubId(e.target.value)}
                        className="w-full rounded-lg bg-input-bg border border-border-subtle p-2 text-xs text-text-main focus:outline-none focus:border-accent font-medium mt-1"
                      >
                        {searchablePublishers.map((pub) => (
                          <option key={pub.id} value={pub.id} className="p-1.5 rounded cursor-pointer">
                            {getDisplayName(pub.publisher_name)} ({pub.game_count || pub.total_games || 0} games · {pub.last_scan_status || "unscanned"})
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Selected Publisher Card */}
                    {selectedPubObj ? (
                      <div className="p-4 rounded-xl bg-input-bg/60 border border-border-subtle flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-text-main truncate">
                              {getDisplayName(selectedPubObj.publisher_name)}
                            </div>
                            <div className="text-[11px] text-text-muted font-mono truncate">
                              {selectedPubObj.developer_id ? `dev?id=${selectedPubObj.developer_id}` : selectedPubObj.source_url || selectedPubObj.publisher_name}
                            </div>
                          </div>
                          <Badge tone="accent" className="tabular-nums">
                            {selectedPubObj.game_count || selectedPubObj.total_games || 0} Games
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="p-2.5 rounded-lg bg-surface-solid border border-border-subtle">
                            <span className="text-text-muted block text-[11px]">Catalogue Breakdown</span>
                            <span className="font-semibold text-text-main tabular-nums">
                              {selectedPubObj.free_games || 0} Free · {selectedPubObj.paid_games || 0} Paid
                            </span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-surface-solid border border-border-subtle">
                            <span className="text-text-muted block text-[11px]">Last Sync Status</span>
                            <span className="font-semibold text-text-main">
                              {selectedPubObj.last_scan_status || "unscanned"} ({formatRelativeTime(selectedPubObj.last_scanned_at)})
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-6 text-center text-xs text-text-muted border border-dashed border-border-subtle rounded-xl">
                        Select a publisher from the list above to inspect details and refresh.
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-subtle">
                      <button
                        type="button"
                        onClick={() => setShowScannerModal(false)}
                        className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!selectedPubObj || scanStatus.running}
                        onClick={() => {
                          handleStartScan({
                            mode: "batch",
                            publisherIds: [selectedPubObj.id],
                            listIds: Array.isArray(selectedPubObj.list_ids) ? selectedPubObj.list_ids : []
                          });
                        }}
                        className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        <AtlasIcon name="sync" size={15} />
                        Scan Publisher Catalogue
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}

          {/* MODAL 4: BATCH COUNTRY AVAILABILITY SCANNER (z-[100]) */}
          {showCountryBatchModal && (
            <motion.div
              key="play-country-batch-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setShowCountryBatchModal(false)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-main">Resumable Batch Country Scanner</h3>
                    <p className="text-xs text-text-muted mt-0.5">
                      Queue 176-country Play Store availability scans in the background with Pause/Resume support.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCountryBatchModal(false)}
                    aria-label="Close country scanner modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                <div className="flex flex-col gap-2 text-xs">
                  <label className="font-medium text-text-muted">Select Scan Scope</label>
                  <label className="p-3 rounded-xl border border-border-subtle bg-input-bg/50 flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="cqScope"
                      checked={countryBatchScope === "all"}
                      onChange={() => setCountryBatchScope("all")}
                    />
                    <div>
                      <div className="font-semibold text-text-main">
                        All Play Store Games in Atlas ({overview.summary.uniqueGames})
                      </div>
                      <div className="text-[11px] text-text-muted">
                        Ordered by highest installs first
                      </div>
                    </div>
                  </label>

                  {activeListObj && (
                    <label className="p-3 rounded-xl border border-border-subtle bg-input-bg/50 flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="cqScope"
                        checked={countryBatchScope === "list"}
                        onChange={() => setCountryBatchScope("list")}
                      />
                      <div className="font-semibold text-text-main">
                        Active Competitor List: &ldquo;{activeListObj.name}&rdquo; ({activeListObj.unique_games} games)
                      </div>
                    </label>
                  )}

                  {selectedPublisherObj && (
                    <label className="p-3 rounded-xl border border-border-subtle bg-input-bg/50 flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="cqScope"
                        checked={countryBatchScope === "publisher"}
                        onChange={() => setCountryBatchScope("publisher")}
                      />
                      <div className="font-semibold text-text-main">
                        Active Publisher: &ldquo;{getDisplayName(selectedPublisherObj.publisher_name)}&rdquo; ({selectedPublisherObj.total_games} games)
                      </div>
                    </label>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-text-muted">
                    Skip games already scanned within the last N days:
                  </label>
                  <select
                    value={countryBatchSkipDays}
                    onChange={(e) => setCountryBatchSkipDays(Number(e.target.value))}
                    className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs text-text-main focus:outline-none focus:border-accent"
                  >
                    <option value={7}>Skip games scanned in last 7 days (Recommended)</option>
                    <option value={14}>Skip games scanned in last 14 days</option>
                    <option value={30}>Skip games scanned in last 30 days</option>
                    <option value={0}>Force re-scan all games in scope (0 days)</option>
                  </select>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
                  <button
                    type="button"
                    onClick={() => setShowCountryBatchModal(false)}
                    className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={countryQueueStatus.running}
                    onClick={() => handleStartCountryQueue()}
                    className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold disabled:opacity-50"
                  >
                    {countryQueueStatus.running ? "Queue Running..." : "Start Country Batch Queue"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}

          {/* MODAL 5: RENAME ACCOUNT & ASSIGN LISTS (z-[100]) */}
          {editingPublisher && (
            <motion.div
              key="play-rename-publisher-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setEditingPublisher(null)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.form
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                onSubmit={handleSavePublisherModal}
                className="w-full max-w-md bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-main">Rename Account &amp; Lists</h3>
                    <p className="text-xs text-text-muted">Play Store Publisher: {editingPublisher.publisher_name}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingPublisher(null)}
                    aria-label="Close rename modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-text-muted">
                    Custom Display Name (Leave blank to use original Play Store name)
                  </label>
                  <input
                    type="text"
                    value={editingPublisher.display_name}
                    onChange={(e) => setEditingPublisher({ ...editingPublisher, display_name: e.target.value })}
                    placeholder={editingPublisher.publisher_name}
                    className="h-9 rounded-lg bg-input-bg border border-border-subtle px-3 text-xs text-text-main focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium text-text-muted">
                    Parent Competitor (1 Competitor per Publisher Account)
                  </label>
                  {(editingPublisher.list_ids || []).length > 1 && (
                    <div className="p-2.5 rounded-xl atlas-badge-warning border text-xs">
                      This account is currently linked to multiple competitors ({(editingPublisher.list_ids || []).map((id) => listNameById.get(Number(id))).filter(Boolean).join(" & ")}). Select the single canonical Parent Competitor below and click Save Changes.
                    </div>
                  )}
                  <div className="max-h-48 overflow-y-auto border border-border-subtle rounded-xl divide-y divide-border-subtle bg-input-bg/40">
                    {(overview.lists || []).map((list) => {
                      const checked = (editingPublisher.list_ids || []).includes(list.id);
                      return (
                        <label
                          key={list.id}
                          className="px-3.5 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-input-bg text-xs"
                        >
                          <span className="text-text-main font-medium">{list.name}</span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const cur = editingPublisher.list_ids || [];
                              const isOnlySelected = cur.length === 1 && cur[0] === list.id;
                              setEditingPublisher({
                                ...editingPublisher,
                                list_ids: isOnlySelected ? [] : [list.id]
                              });
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>

                {editingPublisher.error && (
                  <div className="p-3 rounded-xl atlas-badge-danger border text-xs font-medium">
                    {editingPublisher.error}
                  </div>
                )}

                <div className="flex flex-col gap-2.5 border-t border-border-subtle pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {activeListObj && (editingPublisher.list_ids || []).includes(activeListObj.id) && (
                        <button
                          type="button"
                          disabled={removingPublisherId === editingPublisher.id || isSavingPublisher}
                          onClick={() => handleRemoveFromCurrentList(editingPublisher.id, activeListObj.id)}
                          className="h-8 inline-flex items-center gap-1 px-2.5 rounded-lg atlas-badge-warning border text-xs font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          {removingPublisherId === editingPublisher.id && (
                            <AtlasIcon name="progress_activity" size={12} className="animate-spin" />
                          )}
                          {removingPublisherId === editingPublisher.id
                            ? "Removing..."
                            : `Remove from "${activeListObj.name}"`}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePub(editingPublisher)}
                        className="h-8 px-2.5 rounded-lg atlas-badge-danger border text-xs font-medium hover:opacity-90"
                      >
                        Delete from Atlas
                      </button>
                    </div>

                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        type="button"
                        onClick={() => setEditingPublisher(null)}
                        className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingPublisher}
                        className="h-9 px-4 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold disabled:opacity-50"
                      >
                        {isSavingPublisher ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </div>
                </div>
              </motion.form>
            </motion.div>
          )}

          {/* MODAL: MANAGE COMPETITOR BATCHES (GROUPS) (z-[100]) */}
          {groupModal && (
            <motion.div
              key="play-group-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setGroupModal(null)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="bg-surface-solid border border-border-subtle rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
              >
                <div className="p-5 border-b border-border-subtle flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-main flex items-center gap-2">
                      <AtlasIcon name="folder_special" size={18} className="text-link" />
                      {groupModal.mode === "create" ? "Create Competitor Batch" : `Edit Batch: ${groupModal.name}`}
                    </h3>
                    <p className="text-xs text-text-muted mt-0.5">
                      Group multiple competitors into a unified batch. Each competitor can only belong to one batch.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGroupModal(null)}
                    aria-label="Close batch modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                <form onSubmit={handleSaveBatch} className="p-5 overflow-y-auto flex-1 flex flex-col gap-4">
                  {groupModal.error && (
                    <div className="p-3 rounded-xl atlas-badge-danger border text-xs flex items-center gap-2">
                      <AtlasIcon name="error" size={15} />
                      <span className="flex-1 font-medium">{groupModal.error}</span>
                    </div>
                  )}

                  {/* Existing Batches Overview & Switcher */}
                  {(overview.competitorGroups || []).length > 0 && (
                    <div className="p-3 rounded-xl bg-input-bg/70 border border-border-subtle flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1">
                          <AtlasIcon name="layers" size={14} className="text-link" />
                          Existing Batches ({(overview.competitorGroups || []).length}) — Click to View / Edit
                        </span>
                        {groupModal.mode === "edit" && (
                          <button
                            type="button"
                            onClick={() => openBatchManager(null)}
                            className="text-xs font-medium text-link hover:underline flex items-center gap-0.5"
                          >
                            <AtlasIcon name="add" size={13} />
                            Create New Batch
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                        {(overview.competitorGroups || []).map((grp) => {
                          const isActiveBatch = groupModal.mode === "edit" && Number(groupModal.groupId) === Number(grp.id);
                          const members = Array.isArray(grp.competitor_names) ? grp.competitor_names : [];
                          return (
                            <button
                              key={grp.id}
                              type="button"
                              onClick={() => handleSelectBatchInModal(grp.id)}
                              className={`px-2.5 py-1.5 rounded-lg border text-left transition flex flex-col gap-0.5 max-w-full ${
                                isActiveBatch
                                  ? "atlas-badge-accent border font-semibold"
                                  : "bg-surface-solid border-border-subtle text-text-main hover:border-border-strong"
                              }`}
                            >
                              <div className="flex items-center gap-1.5 text-xs font-semibold">
                                <AtlasIcon name="folder_special" size={13} />
                                <span>{grp.name}</span>
                                <span className="text-[11px] text-text-muted font-normal tabular-nums">
                                  ({members.length} {members.length === 1 ? "competitor" : "competitors"} · {grp.account_count || 0} accts)
                                </span>
                              </div>
                              <div className="text-[11px] text-text-muted truncate max-w-[260px]">
                                {members.length > 0 ? members.join(", ") : "No competitors assigned"}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider block mb-1">
                        Batch Name
                      </label>
                      <input
                        type="text"
                        required
                        value={groupModal.name}
                        onChange={(e) => setGroupModal({ ...groupModal, name: e.target.value })}
                        placeholder="e.g. Bahria"
                        className="w-full h-9 px-3 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:border-accent outline-none"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider block mb-1">
                        Description (Optional)
                      </label>
                      <input
                        type="text"
                        value={groupModal.description}
                        onChange={(e) => setGroupModal({ ...groupModal, description: e.target.value })}
                        placeholder="e.g. Trenzy and Gaminator studio network"
                        className="w-full h-9 px-3 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:border-accent outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider tabular-nums">
                        Select Member Competitors ({groupModal.competitorIds.length} selected)
                      </label>
                      {groupModal.competitorIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setGroupModal({ ...groupModal, competitorIds: [] })}
                          className="text-xs text-text-muted hover:text-sem-danger font-medium transition"
                        >
                          Clear Selection
                        </button>
                      )}
                    </div>

                    {/* Selected Competitors Badges */}
                    {groupModal.competitorIds.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mb-2.5 p-2 rounded-lg bg-input-bg/60 border border-border-subtle">
                        {(overview.lists || [])
                          .filter((c) => groupModal.competitorIds.includes(Number(c.competitor_id)))
                          .map((comp) => (
                            <Badge key={comp.id} tone="accent">
                              <span>{comp.name}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setGroupModal({
                                    ...groupModal,
                                    competitorIds: groupModal.competitorIds.filter((id) => id !== Number(comp.competitor_id))
                                  })
                                }
                                className="hover:text-sem-danger ml-0.5 flex items-center"
                                title={`Remove ${comp.name}`}
                              >
                                <AtlasIcon name="close" size={12} />
                              </button>
                            </Badge>
                          ))}
                      </div>
                    )}

                    {/* Search Competitors Input */}
                    <div className="relative mb-2">
                      <AtlasIcon
                        name="search"
                        size={15}
                        className="text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      />
                      <input
                        type="text"
                        value={groupModal.searchQuery || ""}
                        onChange={(e) => setGroupModal({ ...groupModal, searchQuery: e.target.value })}
                        placeholder="Search competitors by name..."
                        className="w-full h-9 pl-9 pr-8 rounded-lg bg-input-bg border border-border-subtle text-xs text-text-main placeholder:text-text-muted focus:border-accent outline-none"
                      />
                      {groupModal.searchQuery && (
                        <button
                          type="button"
                          onClick={() => setGroupModal({ ...groupModal, searchQuery: "" })}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                        >
                          <AtlasIcon name="close" size={14} />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1.5 bg-input-bg rounded-xl border border-border-subtle">
                      {(overview.lists || [])
                        .filter((comp) => {
                          const q = (groupModal.searchQuery || "").trim().toLowerCase();
                          if (!q) return true;
                          const assigned = competitorBatchAssignmentMap.get(Number(comp.competitor_id));
                          return (
                            String(comp.name || "").toLowerCase().includes(q) ||
                            String(assigned?.name || "").toLowerCase().includes(q)
                          );
                        })
                        .map((comp) => {
                          const targetId = Number(comp.competitor_id);
                          const isChecked = Number.isInteger(targetId) && targetId > 0 && groupModal.competitorIds.includes(targetId);
                          const assignedBatch = competitorBatchAssignmentMap.get(targetId);
                          const isAssignedToOtherBatch =
                            Boolean(assignedBatch) &&
                            (groupModal.mode === "create" || Number(assignedBatch.id) !== Number(groupModal.groupId));

                          return (
                            <label
                              key={comp.id}
                              title={
                                isAssignedToOtherBatch
                                  ? `${comp.name} is already assigned to batch "${assignedBatch.name}". Remove it from "${assignedBatch.name}" first.`
                                  : `${comp.name} (${comp.account_count || 0} accounts)`
                              }
                              className={`flex items-center gap-2.5 p-2 rounded-lg text-xs font-medium transition ${
                                isAssignedToOtherBatch
                                  ? "bg-surface-solid/50 text-text-muted border border-border-subtle/50 opacity-60 cursor-not-allowed"
                                  : isChecked
                                  ? "bg-accent/10 text-text-main border border-accent cursor-pointer"
                                  : "bg-surface-solid text-text-main border border-border-subtle hover:border-border-strong cursor-pointer"
                              }`}
                            >
                              <input
                                type="checkbox"
                                disabled={isAssignedToOtherBatch || !targetId}
                                checked={isChecked}
                                onChange={(e) => {
                                  if (isAssignedToOtherBatch || !targetId) return;
                                  const next = e.target.checked
                                    ? [...groupModal.competitorIds.filter((id) => id !== targetId), targetId]
                                    : groupModal.competitorIds.filter((id) => id !== targetId);
                                  setGroupModal({ ...groupModal, competitorIds: next });
                                }}
                                className="rounded w-4 h-4 cursor-pointer disabled:cursor-not-allowed shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold">{comp.name}</div>
                                {isAssignedToOtherBatch && (
                                  <div className="text-[11px] text-sem-warning truncate">
                                    In &ldquo;{assignedBatch.name}&rdquo;
                                  </div>
                                )}
                              </div>
                              <span className="text-[11px] text-text-muted shrink-0 tabular-nums">({comp.account_count || 0})</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-border-subtle mt-auto">
                    {groupModal.mode === "edit" ? (
                      <button
                        type="button"
                        onClick={() => handleDeleteBatch(groupModal.groupId)}
                        className="h-9 px-3.5 rounded-lg atlas-badge-danger border text-xs font-semibold hover:opacity-90 transition"
                      >
                        Delete Batch
                      </button>
                    ) : <div />}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={groupModal.saving}
                        onClick={() => setGroupModal(null)}
                        className="h-9 px-4 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-muted hover:text-text-main disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={groupModal.saving}
                        className="h-9 px-5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5 transition"
                      >
                        {groupModal.saving && (
                          <AtlasIcon name="progress_activity" size={14} className="animate-spin" />
                        )}
                        <span>{groupModal.saving ? "Saving..." : "Save Batch"}</span>
                      </button>
                    </div>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* CONFIRMATION DIALOG (z-[110] — sits above all modals & drawers) */}
      {createPortal(
        <AnimatePresence>
          {confirmDeletePub && (
            <motion.div
              key="play-confirm-delete-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              onClick={() => setConfirmDeletePub(null)}
              className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.97 }}
                transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              >
                <h4 className="text-sm font-semibold text-text-main">
                  Delete &ldquo;{getDisplayName(confirmDeletePub.publisher_name)}&rdquo; from Atlas?
                </h4>
                <p className="text-xs text-text-muted leading-relaxed">
                  This removes the publisher record from Play Store Intelligence. If you only want to remove it from a Competitor List, uncheck the list instead.
                </p>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setConfirmDeletePub(null)}
                    className="h-9 px-3.5 rounded-lg bg-input-bg border border-border-subtle text-text-muted hover:text-text-main text-xs font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isDeletingPub}
                    onClick={() => executeDeletePublisherFromAtlas(confirmDeletePub)}
                    className="h-9 inline-flex items-center gap-1.5 px-3.5 rounded-lg bg-sem-danger text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                  >
                    {isDeletingPub && <AtlasIcon name="progress_activity" size={14} className="animate-spin" />}
                    {isDeletingPub ? "Deleting..." : "Delete Permanently"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* NON-BLOCKING FLOATING GOOGLE SHEETS IMPORTER POP-UP */}
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {showSheetModal && (
            <motion.div
              key="atlas-play-sheet-floating-panel"
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed top-[74px] right-4 sm:right-6 z-[95] w-[calc(100vw-2rem)] max-w-[460px]"
            >
              <div className="bg-surface-solid border border-border-subtle rounded-xl p-4 sm:p-5 flex flex-col gap-3.5 shadow-2xl max-h-[calc(100vh-92px)] overflow-y-auto custom-scrollbar">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <AtlasIcon name="table_view" size={16} className="text-link shrink-0" />
                      <h3 className="text-[15px] font-semibold text-text-main truncate">
                        Google Sheets Importer
                      </h3>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      Competitor Analysis tab · Only new unimported accounts
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={loadSheetPreview}
                      disabled={isLoadingSheet}
                      title="Refresh from Google Sheets"
                      aria-label="Refresh from Google Sheets"
                      className="h-7 w-7 rounded-lg border border-border-subtle bg-input-bg/60 hover:bg-input-bg text-text-muted hover:text-text-main flex items-center justify-center transition-colors disabled:opacity-50"
                    >
                      <AtlasIcon name="refresh" size={14} className={isLoadingSheet ? "animate-spin" : ""} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSheetModal(false)}
                      aria-label="Close Google Sheets importer"
                      className="h-7 w-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-main hover:bg-input-bg transition-colors"
                    >
                      <AtlasIcon name="close" size={16} />
                    </button>
                  </div>
                </div>

                {/* Compact Active Ad Campaigns Sync */}
                <div className="rounded-lg border border-border-subtle bg-input-bg/50 p-2.5 flex items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-main">
                      Active Ad Campaigns Sync (Sheet1)
                    </div>
                    <div className="text-[11px] text-text-muted truncate">
                      {campaignSyncResult
                        ? `Matched ${campaignSyncResult.matchedCount ?? 0}/${campaignSyncResult.uniqueCount ?? 0} packages (${campaignSyncResult.unmatchedCount ?? 0} unmatched)`
                        : "Mark Atlas games listed in Sheet1 as running active Google Ads"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSyncSheetCampaigns}
                    disabled={isSyncingCampaigns}
                    className="shrink-0 h-8 px-2.5 rounded-lg text-xs font-medium border border-border-subtle bg-surface-solid hover:bg-input-bg text-text-main transition-colors disabled:opacity-50"
                  >
                    {isSyncingCampaigns ? "Syncing..." : "Sync Campaigns"}
                  </button>
                </div>

                {/* Preview Error */}
                {sheetPreviewError && (
                  <div className="rounded-lg border atlas-badge-danger px-3 py-2 text-xs">
                    {sheetPreviewError}
                  </div>
                )}

                {/* Loading State */}
                {isLoadingSheet && !sheetPreview && (
                  <div className="py-6 flex flex-col items-center justify-center gap-2 text-text-muted">
                    <AtlasIcon name="progress_activity" size={20} className="animate-spin text-link" />
                    <span className="text-xs">Reading Competitor Analysis tab...</span>
                  </div>
                )}

                {/* Sheet Preview Content */}
                {sheetPreview && (
                  <>
                    {/* 3 Compact Stat Tiles */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg border border-border-subtle bg-input-bg/50 px-2.5 py-2">
                        <div className="text-[11px] text-text-muted">Sheet Columns</div>
                        <div className="text-sm font-semibold text-text-main mt-0.5 tabular-nums">
                          {sheetPreview.totalColumns ?? 0}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border-subtle bg-input-bg/50 px-2.5 py-2">
                        <div className="text-[11px] text-text-muted">Already in Atlas</div>
                        <div className="text-sm font-semibold text-text-main mt-0.5 tabular-nums">
                          {sheetPreview.existingPublishersCount ?? 0}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border-subtle bg-input-bg/50 px-2.5 py-2">
                        <div className="text-[11px] text-text-muted">New to Import</div>
                        <div className={`text-sm font-semibold mt-0.5 tabular-nums ${(sheetPreview.newPublishersCount ?? 0) > 0 ? "text-sem-success" : "text-text-main"}`}>
                          +{sheetPreview.newPublishersCount ?? 0}
                        </div>
                      </div>
                    </div>

                    {/* Filter & Selection Controls */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <label className="inline-flex items-center gap-1.5 text-text-main cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={sheetShowOnlyNewCols}
                          onChange={(e) => setSheetShowOnlyNewCols(e.target.checked)}
                          className="rounded border-border-subtle"
                        />
                        <span>Only columns with new</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const colsWithNew = (sheetPreview.columns || sheetVisibleColumns || [])
                              .filter((c) => (c.newAccountCount || 0) > 0)
                              .map((c) => c.listName);
                            setSheetSelectedLists(colsWithNew);
                          }}
                          className="text-link hover:underline font-medium"
                        >
                          Select new
                        </button>
                        <span className="text-border-subtle">|</span>
                        <button
                          type="button"
                          onClick={() => setSheetSelectedLists([])}
                          className="text-text-muted hover:text-text-main"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    {/* Columns List */}
                    <div className="max-h-56 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                      {sheetVisibleColumns.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle bg-input-bg/40 px-3 py-4 text-center text-xs text-text-muted flex flex-col items-center gap-2">
                          <span>
                            {sheetShowOnlyNewCols
                              ? "No columns with unimported accounts."
                              : "No columns found in the sheet."}
                          </span>
                          {sheetShowOnlyNewCols && (
                            <button
                              type="button"
                              onClick={() => setSheetShowOnlyNewCols(false)}
                              className="text-link hover:underline font-medium"
                            >
                              Show all columns
                            </button>
                          )}
                        </div>
                      ) : (
                        sheetVisibleColumns.map((col) => {
                          const hasNoNew = (col.newAccountCount || 0) === 0;
                          const isChecked = !hasNoNew && sheetSelectedLists.includes(col.listName);
                          const newList = Array.isArray(col.newAccounts) ? col.newAccounts : [];
                          const previewNames = newList
                            .slice(0, 3)
                            .map((acc) =>
                              typeof acc === "string"
                                ? acc
                                : (acc?.publisher || acc?.normalizedUrl || "Account")
                            )
                            .join(", ");
                          const extraCount = newList.length > 3 ? newList.length - 3 : 0;

                          return (
                            <label
                              key={col.listName}
                              className={`flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors ${
                                hasNoNew
                                  ? "border-border-subtle bg-input-bg/35 opacity-70 cursor-default"
                                  : isChecked
                                  ? "border-accent bg-accent/5 cursor-pointer"
                                  : "border-border-subtle bg-input-bg/35 hover:bg-input-bg/65 cursor-pointer"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={hasNoNew}
                                onChange={() => {
                                  if (hasNoNew) return;
                                  setSheetSelectedLists((prev) =>
                                    prev.includes(col.listName)
                                      ? prev.filter((item) => item !== col.listName)
                                      : [...prev, col.listName]
                                  );
                                }}
                                className="mt-0.5 rounded border-border-subtle shrink-0 disabled:opacity-50"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium text-text-main truncate">
                                    {col.listName}
                                  </span>
                                  {!hasNoNew ? (
                                    <Badge tone="success" className="shrink-0 tabular-nums">
                                      +{col.newAccountCount} new
                                    </Badge>
                                  ) : (
                                    <Badge tone="neutral" className="shrink-0">
                                      All in Atlas
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-[11px] text-text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="tabular-nums">{col.accountCount ?? 0} total</span>
                                  {col.adsId && <span className="truncate">Ads ID: {col.adsId}</span>}
                                </div>
                                {previewNames && (
                                  <div className="text-[11px] text-text-muted mt-1 truncate">
                                    {previewNames}
                                    {extraCount > 0 ? ` +${extraCount} more` : ""}
                                  </div>
                                )}
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>

                    {/* All Already in Atlas Message */}
                    {(sheetPreview.newPublishersCount ?? 0) === 0 && (
                      <div className="rounded-lg border atlas-badge-success px-3 py-2 text-xs">
                        All {sheetPreview.existingPublishersCount ?? 0} account(s) in Google Sheets are already in Atlas.
                      </div>
                    )}

                    {/* Auto-Scan Checkbox */}
                    <label className="flex items-center gap-2 text-xs text-text-main cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={sheetAutoScanNew}
                        onChange={(e) => setSheetAutoScanNew(e.target.checked)}
                        className="rounded border-border-subtle"
                      />
                      <span>Immediately scan newly imported accounts on Google Play</span>
                    </label>
                  </>
                )}

                {/* Dedicated Inline Compact Progress Bar inside Popup */}
                {(sheetImportStatus?.running || Boolean(sheetImportStatus?.log)) && (
                  <div className="rounded-lg border border-border-subtle bg-input-bg/60 p-2.5 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-text-main flex items-center gap-1.5">
                        {sheetImportStatus?.running && (
                          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                        )}
                        {sheetImportStatus?.running
                          ? "Sheets Import & Scan Active"
                          : sheetImportStatus?.state === "cancelled"
                          ? "Sheets Import Aborted"
                          : sheetImportStatus?.state === "error"
                          ? "Sheets Import Finished with Errors"
                          : "Sheets Import Complete"}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-text-muted tabular-nums">
                          {sheetProgressPct}%{sheetImportStatus?.running ? ` · ${formatDurationSec(sheetElapsedSec)}` : ""}
                        </span>
                        {!sheetImportStatus?.running &&
                          Array.isArray(sheetImportStatus?.failedLinks) &&
                          sheetImportStatus.failedLinks.length > 0 && (
                            <button
                              type="button"
                              disabled={isStartingSheetImport}
                              onClick={handleRetrySheetFailed}
                              className="px-2 py-0.5 rounded-md text-[11px] font-medium border atlas-badge-warning hover:opacity-90 transition-colors disabled:opacity-50"
                            >
                              Retry Failed ({sheetImportStatus.failedLinks.length})
                            </button>
                          )}
                        {sheetImportStatus?.running && (
                          <button
                            type="button"
                            onClick={handleCancelSheetImport}
                            className="px-2 py-0.5 rounded-md text-[11px] font-medium border atlas-badge-danger hover:opacity-90 transition-colors"
                          >
                            Abort
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-input-bg overflow-hidden border border-border-subtle/50">
                      <div
                        className={`h-full transition-all duration-300 ease-out ${
                          sheetImportStatus?.state === "error"
                            ? "bg-sem-danger"
                            : sheetImportStatus?.running
                            ? "bg-btn-primary"
                            : "bg-sem-success"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, sheetProgressPct || 0))}%` }}
                      />
                    </div>
                    {sheetImportStatus?.log && (
                      <div className="text-[11px] text-text-muted truncate" title={sheetImportStatus.log}>
                        {sheetImportStatus.log}
                      </div>
                    )}
                  </div>
                )}

                {/* Footer Actions */}
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
                  <button
                    type="button"
                    onClick={() => setShowSheetModal(false)}
                    className="h-8 px-3 rounded-lg text-xs font-medium border border-border-subtle bg-input-bg/60 hover:bg-input-bg text-text-muted hover:text-text-main transition-colors"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmSheetImport}
                    disabled={
                      isStartingSheetImport ||
                      Boolean(sheetImportStatus?.running) ||
                      (sheetSelectionSummary?.newCount ?? 0) === 0
                    }
                    className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isStartingSheetImport
                      ? "Starting..."
                      : sheetAutoScanNew
                      ? `Import & Scan ${sheetSelectionSummary?.newCount ?? 0} New`
                      : `Import ${sheetSelectionSummary?.newCount ?? 0} New`}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* UNIVERSAL GAME DETAIL DRAWER (z-[90] via Portal — sits cleanly in front of z-50 top header) */}
      <AnimatePresence>
        {activeGameDrawer && (
          <UniversalGameDetailDrawer
            game={activeGameDrawer}
            onClose={() => setActiveGameDrawer(null)}
            onSelectGame={(sibling) => setActiveGameDrawer(sibling)}
            onRefreshTelemetry={handleRefreshSingleGame}
            isRefreshing={refreshingPkg === activeGameDrawer.package_name}
            onOpenCountryScan={onOpenCountryScan}
            allGames={overview?.games || []}
            isAdmin={isAdmin}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default memo(PlayStoreIntelligenceView);
