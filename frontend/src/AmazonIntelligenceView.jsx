import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { API_BASE } from "./apiConfig";
import AtlasFeedback from "./AtlasFeedback.jsx";
import AtlasSelect from "./AtlasSelect";
import AtlasIcon from "./components/ui/AtlasIcon.jsx";
import {
  Badge,
  KpiStrip,
  PageHeader,
  ScanProgressBanner,
  TableSkeleton
} from "./components/ui/UiPrimitives.jsx";
import {
  getCachedCatalogue,
  setCachedCatalogue,
  getMemoryCatalogue,
  markCatalogueValidated,
  getViewUiState,
  setViewUiState,
  broadcastCatalogueUpdate,
  onCatalogueUpdate
} from "./lib/atlasCache.js";

const SAMPLE_LINKS = [
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AOrigin%2BGame%2BArena&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AYoyo%2BFun%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGood%2BFun%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BArk&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BWorld%2BStudios&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AToucan%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGenius%2BMobile%2BApps&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGrand%2BAdventure%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AAppstech%2BStudio&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AAdddictive%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AKooapps&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AVinegar%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3ADev%2BCynx%2BGames&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGame%2BNest&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BMagnet&search-type=ss",
  "https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGaming%2BPills&search-type=ss"
];

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
 * Separate data availability ("Synced") from latest refresh attempt ("Blocked" / "Failed").
 * An account with synced games in Atlas is never labeled as broken just because a later refresh hit a transient 503.
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

  if (latestStatus === "blocked") {
    return {
      dataLabel: "Blocked",
      textTone: "text-sem-danger",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Amazon temporarily blocked the scan request."
    };
  }

  if (latestStatus === "error") {
    return {
      dataLabel: "Retry Needed",
      textTone: "text-sem-warning",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Scan did not return listings."
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

function AmazonIntelligenceView({ isAdmin = false }) {
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

  const [initialCacheSnap] = useState(() => ({
    mem: getMemoryCatalogue("amazon_overview"),
    ui: getViewUiState("amazon_view", {})
  }));

  const [overview, setOverview] = useState(() => initialCacheSnap.mem?.data || {
    summary: {
      publisherCount: 0,
      listCount: 0,
      uniqueGames: 0,
      totalListings: 0,
      totalGames: 0,
      freeGames: 0,
      paidGames: 0,
      unknownGames: 0,
      freeShare: 0,
      totalReviews: 0
    },
    lists: [],
    publishers: [],
    games: [],
    snapshots: [],
    competitorGroups: []
  });
  const [loading, setLoading] = useState(() => !initialCacheSnap.mem?.data);

  // App vs Game Category Filter state
  const [appTypeFilter, setAppTypeFilter] = useState(() => initialCacheSnap.ui.appTypeFilter ?? "all"); // "all" | "game" | "app"

  // Competitor List & Account Filter state
  const [selectedListId, setSelectedListId] = useState(() => initialCacheSnap.ui.selectedListId ?? "all"); // "all" | "ungrouped" | number | "group_<id>"
  const [selectedPublisher, setSelectedPublisher] = useState(() => initialCacheSnap.ui.selectedPublisher ?? "all");
  const [selectedPricing, setSelectedPricing] = useState(() => initialCacheSnap.ui.selectedPricing ?? "all"); // all | free | paid
  const [searchQuery, setSearchQuery] = useState(() => initialCacheSnap.ui.searchQuery ?? "");
  const [sortBy, setSortBy] = useState(() => initialCacheSnap.ui.sortBy ?? "reviews"); // reviews | price_desc | price_asc | rating | release

  // Launch Duration / Date Filter state
  const [dateBasis, setDateBasis] = useState(() => initialCacheSnap.ui.dateBasis ?? "release_date"); // "release_date" | "first_seen_at"
  const [durationPreset, setDurationPreset] = useState(() => initialCacheSnap.ui.durationPreset ?? "all"); // "all" | "30d" | "90d" | "6m" | "1y" | "custom"
  const [customStartDate, setCustomStartDate] = useState(() => initialCacheSnap.ui.customStartDate ?? "");
  const [customEndDate, setCustomEndDate] = useState(() => initialCacheSnap.ui.customEndDate ?? "");
  const [includeUnknownDates, setIncludeUnknownDates] = useState(() => initialCacheSnap.ui.includeUnknownDates ?? false);
  const [showDateFilterPopover, setShowDateFilterPopover] = useState(false);
  const dateFilterPopoverRef = useRef(null);

  // Drawers & Modals (Layered z-index: Drawer z-[90], Modals z-[100], Confirmations z-[110])
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);
  const [showScannerModal, setShowScannerModal] = useState(false);
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

  const [isSavingList, setIsSavingList] = useState(false);
  const [isSavingPublisher, setIsSavingPublisher] = useState(false);
  const [isRefreshingOverview, setIsRefreshingOverview] = useState(false);
  const [isDeletingList, setIsDeletingList] = useState(false);
  const [isDeletingPub, setIsDeletingPub] = useState(false);
  const [removingPublisherId, setRemovingPublisherId] = useState(null);
  const [copiedAsin, setCopiedAsin] = useState(null);
  const [showAllPublishers, setShowAllPublishers] = useState(false);
  const [visibleRowCount, setVisibleRowCount] = useState(() => initialCacheSnap.ui.visibleRowCount ?? 150);
  const catalogSectionRef = useRef(null);
  const overviewLengthRef = useRef(
    (initialCacheSnap.mem?.data?.games?.length || 0) + (initialCacheSnap.mem?.data?.publishers?.length || 0)
  );
  const cachedEtagRef = useRef(initialCacheSnap.mem?.etag || null);

  useEffect(() => {
    setViewUiState("amazon_view", {
      appTypeFilter,
      selectedListId,
      selectedPublisher,
      selectedPricing,
      searchQuery,
      sortBy,
      dateBasis,
      durationPreset,
      customStartDate,
      customEndDate,
      includeUnknownDates,
      visibleRowCount
    });
  }, [
    appTypeFilter,
    selectedListId,
    selectedPublisher,
    selectedPricing,
    searchQuery,
    sortBy,
    dateBasis,
    durationPreset,
    customStartDate,
    customEndDate,
    includeUnknownDates,
    visibleRowCount
  ]);

  useEffect(() => {
    overviewLengthRef.current = (overview.games || []).length + (overview.publishers || []).length;
  }, [overview.games, overview.publishers]);

  useEffect(() => {
    setShowAllPublishers(false);
  }, [selectedListId, appTypeFilter]);

  useEffect(() => {
    setVisibleRowCount(150);
  }, [selectedListId, selectedPublisher, selectedPricing, searchQuery, sortBy, appTypeFilter, durationPreset, dateBasis, customStartDate, customEndDate, includeUnknownDates]);

  const scrollToCatalogIfBelowFold = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = catalogSectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.68 || rect.top < 0) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, []);

  const handleCopyAsin = useCallback(async (asin, e) => {
    if (e) e.stopPropagation();
    if (!asin) return;
    const ok = await AtlasFeedback.copy(asin, "ASIN");
    if (ok) {
      setCopiedAsin(asin);
      window.setTimeout(() => {
        setCopiedAsin((prev) => (prev === asin ? null : prev));
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

      const res = await fetcher(`${API_BASE}/api/amazon/overview`, {
        headers
      });

      if (res.status === 304) {
        markCatalogueValidated("amazon_overview");
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
            unknownGames: 0,
            freeShare: 0,
            totalReviews: 0
          },
          lists: data.lists || [],
          publishers: data.publishers || [],
          games: data.games || [],
          snapshots: data.snapshots || [],
          competitorGroups: data.competitorGroups || []
        };

        setOverview(normalized);
        void setCachedCatalogue("amazon_overview", normalized, newEtag);
        broadcastCatalogueUpdate("amazon", newEtag);
      }
    } catch (err) {
      console.error("Failed to load Amazon overview:", err);
    } finally {
      setLoading(false);
      setIsRefreshingOverview(false);
    }
  }, [fetcher]);

  // Instant render from L1 memory / IndexedDB + Stale-While-Revalidate + Multi-tab sync
  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      const mem = getMemoryCatalogue("amazon_overview");
      if (mem?.data) {
        if (mem.etag) cachedEtagRef.current = mem.etag;
        setLoading(false);
        if (mem.validatedAt && Date.now() - mem.validatedAt < 15000) {
          return;
        }
      } else {
        const cached = await getCachedCatalogue("amazon_overview");
        if (!isMounted) return;
        if (cached?.data) {
          setOverview(cached.data);
          if (cached.etag) cachedEtagRef.current = cached.etag;
          setLoading(false);
        }
      }
      if (isMounted) loadOverview();
    };

    void init();

    const unsubscribe = onCatalogueUpdate((msg) => {
      if (msg.platform === "amazon") {
        getCachedCatalogue("amazon_overview").then((fresh) => {
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
  const lastMidScanRefreshAtRef = useRef(0);
  const consecutivePollErrorsRef = useRef(0);
  const wasScanRunningRef = useRef(false);
  const pollInFlightRef = useRef(false);

  // Adaptive scan status polling: 1.5s while actively scanning, 20s while idle, paused when tab is hidden
  useEffect(() => {
    let disposed = false;
    let timerId = null;

    const checkStatus = async () => {
      if (disposed || document.hidden || pollInFlightRef.current) return;
      pollInFlightRef.current = true;

      let isActive = false;
      let hadError = false;
      try {
        const res = await fetcher(`${API_BASE}/api/amazon/scan-status`);
        if (res.ok) {
          const st = await res.json();
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
            loadOverview();
          } else if (st.running && completedNow > lastCompletedPublishersRef.current) {
            lastCompletedPublishersRef.current = completedNow;
          } else if (!st.running) {
            lastCompletedPublishersRef.current = 0;
          }
          setScanStatus(st);
          consecutivePollErrorsRef.current = 0;
        } else {
          hadError = true;
          consecutivePollErrorsRef.current += 1;
        }
      } catch {
        hadError = true;
        consecutivePollErrorsRef.current += 1;
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
        timerId = setTimeout(checkStatus, nextDelay);
      }
    };

    checkStatus();

    const handleVisibility = () => {
      if (!document.hidden && !disposed) {
        clearTimeout(timerId);
        checkStatus();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetcher, loadOverview]);

  // Live elapsed timer during active scan
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

  // Keyboard Escape dismissal & body scroll lock when modals/drawer are open
  useEffect(() => {
    const anyOpen = Boolean(
      activeGameDrawer ||
        showScannerModal ||
        listModal ||
        groupModal ||
        editingPublisher ||
        confirmDeletePub ||
        showDateFilterPopover
    );
    if (!anyOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (showDateFilterPopover) setShowDateFilterPopover(false);
        else if (confirmDeletePub) setConfirmDeletePub(null);
        else if (editingPublisher) setEditingPublisher(null);
        else if (groupModal) setGroupModal(null);
        else if (listModal) setListModal(null);
        else if (showScannerModal) setShowScannerModal(false);
        else if (activeGameDrawer) setActiveGameDrawer(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activeGameDrawer,
    showScannerModal,
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

  const getDisplayName = useCallback(
    (rawName) => {
      const pub = publisherByRawName.get(rawName);
      if (!pub) return rawName;
      return pub.display_name && pub.display_name.trim() ? pub.display_name.trim() : pub.publisher_name;
    },
    [publisherByRawName]
  );

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

  // Compute active date window bounds
  const dateWindow = useMemo(() => {
    if (durationPreset === "all") return { active: false, startMs: null, endMs: null, label: "All Time" };
    const now = new Date();
    const endOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

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

    const daysMap = { today: 1, "7d": 7, "14d": 14, "30d": 30, "90d": 90, "6m": 182, "1y": 365 };
    const labelsMap = { today: "Today / Last 24h", "7d": "Last 7 Days", "14d": "Last 14 Days", "30d": "Last 30 Days", "90d": "Last 90 Days", "6m": "Last 6 Months", "1y": "Last 1 Year" };
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

    const uniqueAllTimeByAsin = new Map();
    const uniqueMatchingByAsin = new Map();
    let knownDateCount = 0;
    let unknownDateCount = 0;

    for (const g of inScopeGames) {
      if (!uniqueAllTimeByAsin.has(g.asin)) {
        uniqueAllTimeByAsin.set(g.asin, g);
        const dEval = evaluateGameDate(g);
        if (dEval.known) knownDateCount += 1;
        else unknownDateCount += 1;
        if (dEval.inRange) {
          uniqueMatchingByAsin.set(g.asin, g);
        }
      }
    }

    const matchingArr = [...uniqueMatchingByAsin.values()];
    const allTimeArr = [...uniqueAllTimeByAsin.values()];
    const freeMatching = matchingArr.filter((g) => g.pricing === "free").length;
    const paidMatching = matchingArr.filter((g) => g.pricing === "paid").length;

    return {
      allTimeUnique: allTimeArr.length,
      totalListings: inScopeGames.length,
      matchingUnique: matchingArr.length,
      freeMatching,
      paidMatching,
      freeShare: matchingArr.length ? freeMatching / matchingArr.length : 0,
      knownDateCount,
      unknownDateCount
    };
  }, [overview.games, visiblePublisherNames, selectedPublisher, evaluateGameDate, appTypeFilter]);

  // Per-publisher stats dynamically computed for the active date filter
  const publisherStatsByName = useMemo(() => {
    const map = new Map();
    for (const pub of visiblePublishers) {
      map.set(pub.publisher_name, {
        total: 0,
        free: 0,
        paid: 0,
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
        if (g.pricing === "free") entry.free += 1;
        else if (g.pricing === "paid") entry.paid += 1;
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
        const dEval = evaluateGameDate(g);
        if (!dEval.inRange) return false;
        if (q) {
          const disp = getDisplayName(g.publisher_name);
          const hay = `${g.title || ""} ${g.asin || ""} ${g.publisher_name || ""} ${disp}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "price_desc") return (Number(b.price) || 0) - (Number(a.price) || 0);
        if (sortBy === "price_asc") return (Number(a.price) || 0) - (Number(b.price) || 0);
        if (sortBy === "rating") return (Number(b.rating) || 0) - (Number(a.rating) || 0);
        if (sortBy === "release") return String(b.release_date || "").localeCompare(String(a.release_date || ""));
        return (Number(b.review_count) || 0) - (Number(a.review_count) || 0);
      });
  }, [overview.games, visiblePublisherNames, selectedPublisher, selectedPricing, searchQuery, sortBy, getDisplayName, evaluateGameDate, appTypeFilter]);

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
      { value: "paid", label: "Paid Games Only", icon: "monetization_on" }
    ],
    []
  );

  const sortSelectOptions = useMemo(
    () => [
      { value: "reviews", label: "Sort: Most Reviews", icon: "rate_review" },
      { value: "rating", label: "Sort: Highest Rating", icon: "star" },
      { value: "price_desc", label: "Sort: Price (High to Low)", icon: "arrow_downward" },
      { value: "price_asc", label: "Sort: Price (Low to High)", icon: "arrow_upward" },
      { value: "release", label: "Sort: Launch Date", icon: "calendar_today" }
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
  const openListManager = useCallback(
    (targetList = null) => {
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
    },
    []
  );

  // Switch between lists inside the Manage Lists modal
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

  // Validate links
  const handleValidateLinks = async (rawText = linksInput) => {
    setIsValidating(true);
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/validate`, {
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
        links: linksInput,
        listIds: scanTargetListIds,
        newListName: scanNewListName.trim() || undefined
      };
      setScanStatus((prev) => ({
        ...prev,
        running: true,
        state: "scanning",
        phase: "starting",
        completedPublishers: 0,
        totalPublishers: Array.isArray(payload.links) ? payload.links.length : prev.totalPublishers || 1,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: "Starting Amazon catalogue scan..."
      }));
      const res = await fetcher(`${API_BASE}/api/amazon/scan`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
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
        AtlasFeedback.toast("Amazon scan started.", { tone: "success" });
      } else {
        setScanStatus((prev) => ({ ...prev, running: false, state: "idle", log: "" }));
        AtlasFeedback.toast(data?.error || "Failed to start Amazon scan.", { tone: "danger" });
        if (data?.validation) {
          setValidationResult({
            totalSubmitted: data.validation.length,
            validCount: data.validation.filter((v) => v.valid && !v.duplicate).length,
            duplicateCount: data.validation.filter((v) => v.duplicate).length,
            invalidCount: data.validation.filter((v) => !v.valid).length,
            validation: data.validation
          });
        }
      }
    } catch (err) {
      console.error("Scan start failed:", err);
      setScanStatus((prev) => ({ ...prev, running: false, state: "idle", log: "" }));
      AtlasFeedback.toast(err?.message || "Failed to start Amazon scan.", { tone: "danger" });
    }
  };

  const handleRescanList = async (listObj) => {
    if (!listObj || scanStatus.running) return;
    const memberPubs = (overview.publishers || []).filter(
      (p) => Array.isArray(p.list_ids) && p.list_ids.includes(listObj.id)
    );
    if (memberPubs.length === 0) return;
    const urls = memberPubs.map((p) => p.source_url).filter(Boolean);
    await handleStartScan({
      links: urls,
      listIds: [listObj.id]
    });
  };

  const handleRescanPublisher = async (pub) => {
    if (!pub || !pub.source_url || scanStatus.running) return;
    await handleStartScan({
      links: [pub.source_url],
      listIds: Array.isArray(pub.list_ids) ? pub.list_ids : []
    });
  };

  const handleCancelScan = async () => {
    try {
      await fetcher(`${API_BASE}/api/amazon/cancel-scan`, { method: "POST" });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  };

  // Save Create / Edit List modal (and optionally jump straight to Add & Scan Accounts for that list)
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
        const res = await fetcher(`${API_BASE}/api/amazon/lists`, {
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
        const patchRes = await fetcher(`${API_BASE}/api/amazon/lists/${listModal.listId}`, {
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
        const pubRes = await fetcher(`${API_BASE}/api/amazon/lists/${listModal.listId}/publishers`, {
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
      "Delete this Amazon competitor list? Publisher accounts and games will remain in Atlas.",
      { title: "Delete Competitor List", confirmLabel: "Delete List", destructive: true }
    );
    if (!ok) return;
    setIsDeletingList(true);
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/lists/${listId}`, { method: "DELETE" });
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
      const res = await fetcher(`${API_BASE}/api/amazon/publishers/${editingPublisher.id}`, {
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
        AtlasFeedback.toast(`Updated Amazon account "${label}".`, { tone: "success" });
      } else {
        setEditingPublisher((prev) => (prev ? { ...prev, error: data?.error || "Failed to save account." } : null));
      }
    } catch (err) {
      console.error("Save publisher failed:", err);
      setEditingPublisher((prev) => (prev ? { ...prev, error: err?.message || "Failed to save account." } : null));
    } finally {
      setIsSavingPublisher(false);
    }
  };

  const handleRemoveFromCurrentList = async (pubId, listId = activeListObj?.id) => {
    if (!pubId || !listId || removingPublisherId) return;
    setRemovingPublisherId(pubId);
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/lists/${listId}/publishers`, {
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
        AtlasFeedback.toast("Removed account from list.", { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        AtlasFeedback.toast(errData?.error || "Failed to remove account from list.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Remove from list failed:", err);
      AtlasFeedback.toast(err?.message || "Failed to remove account from list.", { tone: "danger" });
    } finally {
      setRemovingPublisherId(null);
    }
  };

  const executeDeletePublisherFromAtlas = async (pub) => {
    if (!pub || !pub.id || isDeletingPub) return;
    setIsDeletingPub(true);
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/publishers/${pub.id}`, { method: "DELETE" });
      if (res.ok) {
        const disp = getDisplayName(pub.publisher_name);
        if (selectedPublisher === pub.publisher_name) setSelectedPublisher("all");
        setConfirmDeletePub(null);
        setEditingPublisher(null);
        await loadOverview({ fresh: true });
        AtlasFeedback.toast(`Deleted "${disp}" from Atlas.`, { tone: "info" });
      } else {
        const errData = await res.json().catch(() => ({}));
        AtlasFeedback.toast(errData?.error || "Failed to delete account.", { tone: "danger" });
      }
    } catch (err) {
      console.error("Delete publisher failed:", err);
      AtlasFeedback.toast(err?.message || "Failed to delete account.", { tone: "danger" });
    } finally {
      setIsDeletingPub(false);
    }
  };

  const exportCsv = () => {
    const headers = [
      "Display Name",
      "Amazon Brand Name",
      "ASIN",
      "Title",
      "Pricing",
      "Price (USD)",
      "Rating",
      "Reviews",
      "Amazon Release Date",
      "First Discovered (Atlas)",
      "URL"
    ];
    const rows = filteredGames.map((g) => [
      `"${String(getDisplayName(g.publisher_name)).replace(/"/g, '""')}"`,
      `"${String(g.publisher_name || "").replace(/"/g, '""')}"`,
      g.asin,
      `"${String(g.title || "").replace(/"/g, '""')}"`,
      g.pricing,
      g.price ?? 0,
      g.rating ?? "",
      g.review_count ?? 0,
      g.release_date ? String(g.release_date).slice(0, 10) : "",
      g.first_seen_at ? String(g.first_seen_at).slice(0, 10) : "",
      g.url || `https://www.amazon.com/dp/${encodeURIComponent(g.asin)}`
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-amazon-games.csv`;
    a.click();
    URL.revokeObjectURL(url);
    AtlasFeedback.toast(`Exported ${rows.length.toLocaleString()} Amazon titles to CSV.`, { tone: "success" });
  };

  const scanProgressPct = useMemo(() => {
    const total = Number(scanStatus.totalPublishers) || 0;
    if (!total) return 0;
    const completed = Number(scanStatus.completedPublishers) || 0;
    if (!scanStatus.running && scanStatus.isComplete) return 100;
    const activeFraction = scanStatus.running && scanStatus.currentPage > 0 ? 0.35 : 0.1;
    return Math.min(98, Math.round(((completed + activeFraction) / total) * 100));
  }, [scanStatus]);

  return (
    <div className="atlas-page-enter flex flex-col w-full gap-5">
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
        title="Amazon Appstore Intelligence"
        subtitle="Competitor research and portfolio pricing analysis."
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
                    } else {
                      setScanTargetListIds([]);
                    }
                    setShowScannerModal(true);
                  }}
                  className="h-9 inline-flex items-center gap-1.5 px-3.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition"
                >
                  <AtlasIcon name="add_link" size={15} />
                  Add &amp; Scan Accounts
                </button>
              </>
            )}
            <button
              type="button"
              onClick={exportCsv}
              className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:border-border-strong hover:bg-input-bg transition tabular-nums"
            >
              <AtlasIcon name="download" size={15} className="text-text-muted" />
              Export CSV ({filteredGames.length.toLocaleString()})
            </button>
          </>
        }
      />

      {/* LIVE PROGRESS BAR & SCAN BANNER */}
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
                : "Amazon Scan Complete"
            }
            phase={scanStatus.running ? scanStatus.phase : null}
            meta={`Elapsed ${formatDurationSec(elapsedSec)} · Pages ${scanStatus.totalPagesProcessed || scanStatus.currentPage || 0} · Saved ${scanStatus.totalGamesSaved || 0}`}
            log={scanStatus.log}
            progressPct={scanStatus.totalPublishers > 0 ? (scanStatus.running ? scanProgressPct : 100) : 100}
            onCancel={isAdmin ? handleCancelScan : undefined}
            cancelLabel="Abort & Save"
            onRetryFailed={
              isAdmin
                ? () => handleStartScan({ links: scanStatus.failedLinks })
                : undefined
            }
            failedCount={
              isAdmin && !scanStatus.running && Array.isArray(scanStatus.failedLinks)
                ? scanStatus.failedLinks.length
                : 0
            }
          />
        )}

      {/* INLINE FILTER & SCOPE TOOLBAR */}
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
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
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
                        <option value="release_date">Amazon Launch Date</option>
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
                  title="Group competitors into a batch (e.g. Trenzy & Gaminator into Bahria)"
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
              Add Accounts to &ldquo;{activeListObj.name}&rdquo;
            </button>
            <button
              type="button"
              disabled={scanStatus.running || !activeListObj.account_count}
              onClick={() => handleRescanList(activeListObj)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg atlas-badge-warning border text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <AtlasIcon name="refresh" size={13} />
              Re-scan List ({activeListObj.account_count})
            </button>
          </div>
        )}
      </div>

      {/* 4 CLEAN KPI STRIP */}
      <KpiStrip
        items={[
          {
            key: "total-unique",
            label:
              selectedPublisher !== "all"
                ? `Total Games (${getDisplayName(selectedPublisher)})`
                : activeListObj
                ? `Total Games in "${activeListObj.name}"`
                : "Total Unique Games",
            value: scopedStats.allTimeUnique.toLocaleString(),
            note: `${visiblePublishers.length} account${visiblePublishers.length === 1 ? "" : "s"}${
              scopedStats.totalListings > scopedStats.allTimeUnique
                ? ` · ${scopedStats.totalListings.toLocaleString()} listings`
                : " · Distinct ASINs"
            }`
          },
          {
            key: "period-games",
            label: dateWindow.active ? `Launched (${dateWindow.label})` : "Games in Selected Period",
            value: scopedStats.matchingUnique.toLocaleString(),
            note: dateWindow.active
              ? `${scopedStats.freeMatching} Free · ${scopedStats.paidMatching} Paid`
              : `All Time (${scopedStats.knownDateCount} with known date)`
          },
          {
            key: "free-games",
            label: `Free Games${dateWindow.active ? ` (${dateWindow.label})` : ""}`,
            value: scopedStats.freeMatching.toLocaleString(),
            badge: selectedPricing === "free" ? <Badge tone="success">Filtered</Badge> : null,
            note: `${Math.round((scopedStats.freeShare || 0) * 100)}% of ${dateWindow.active ? "period" : "portfolio"} · Click to filter`,
            noteClass: "text-sem-success",
            onClick: () => setSelectedPricing(selectedPricing === "free" ? "all" : "free")
          },
          {
            key: "paid-games",
            label: `Paid Games${dateWindow.active ? ` (${dateWindow.label})` : ""}`,
            value: scopedStats.paidMatching.toLocaleString(),
            badge: selectedPricing === "paid" ? <Badge tone="warning">Filtered</Badge> : null,
            note: `${
              scopedStats.matchingUnique
                ? Math.round((scopedStats.paidMatching / scopedStats.matchingUnique) * 100)
                : 0
            }% of ${dateWindow.active ? "period" : "portfolio"} · Click to filter`,
            noteClass: "text-sem-warning",
            onClick: () => setSelectedPricing(selectedPricing === "paid" ? "all" : "paid")
          }
        ]}
      />

      {/* PUBLISHER COMPARISON */}
      <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-subtle">
          <div>
            <h2 className="text-[15px] font-semibold text-text-main">Publisher Comparison</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Click any publisher account, Free bar, or Paid bar to inspect its games below.
              {dateWindow.active ? ` Showing games launched in: ${dateWindow.label}.` : ""}
            </p>
          </div>

          <div className="flex items-center gap-4 text-xs">
            {(selectedPublisher !== "all" || selectedPricing !== "all" || durationPreset !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setSelectedPublisher("all");
                  setSelectedPricing("all");
                  setDurationPreset("all");
                }}
                className="text-link font-medium hover:underline"
              >
                Reset Filters
              </button>
            )}
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" /> Free
            </span>
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <span className="w-2.5 h-2.5 rounded-sm bg-amber-600 inline-block" /> Paid
            </span>
          </div>
        </div>

        {comparisonPublishers.length === 0 ? (
          <div className="py-10 px-4 text-center text-xs text-text-muted flex flex-col items-center gap-3">
            <span>
              {visiblePublishers.length === 0
                ? "No Amazon accounts in this Competitor List yet."
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
            {(showAllPublishers ? comparisonPublishers : comparisonPublishers.slice(0, 12)).map((pub) => {
              const pSt = publisherStatsByName.get(pub.publisher_name) || {
                total: Number(pub.total_games) || 0,
                free: Number(pub.free_games) || 0,
                paid: Number(pub.paid_games) || 0,
                allTimeMatching: Number(pub.total_games) || 0,
                allTimeTotal: Number(pub.total_games) || 0
              };
              const effectiveAllTime = appTypeFilter !== "all" ? (pSt.allTimeMatching ?? 0) : (Number(pub.total_games) || 0);
              const total = pSt.total;
              const free = pSt.free;
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
                    <div className="md:w-64 shrink-0 flex items-center justify-between gap-2">
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
                            title={`Re-scan ${dispName}`}
                            className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-sem-warning transition disabled:opacity-40"
                          >
                            <AtlasIcon
                              name="refresh"
                              size={14}
                              className={isScanningThisPub ? "animate-spin text-sem-warning" : ""}
                            />
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
                            title="Rename account or assign to Competitor Lists"
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
                          No {appTypeFilter === "app" ? "apps" : appTypeFilter === "game" ? "games" : "titles"} in selected period ({effectiveAllTime} all-time)
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
                              title={`${dispName}: ${free} Free games (click to filter)`}
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
                              title={`${dispName}: ${paid} Paid games · Median $${Number(pub.median_paid_price || 0).toFixed(2)} (click to filter)`}
                              className="h-full rounded-md bg-amber-600 hover:bg-amber-500 transition flex items-center justify-center text-[11px] font-semibold text-white overflow-hidden whitespace-nowrap px-1 select-none tabular-nums"
                            >
                              {paidWidthPct >= 18 ? `${paid} Paid` : paidWidthPct >= 10 ? `${paid}P` : paidWidthPct >= 5 ? String(paid) : ""}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {/* Compact Metrics */}
                    <div className="md:w-64 shrink-0 flex items-center justify-between md:justify-end gap-3 text-xs text-text-muted font-mono tabular-nums">
                      <span>
                        <strong className="text-text-main">{total}</strong>
                        {dateWindow.active ? `/${effectiveAllTime}` : (appTypeFilter === "app" ? " apps" : appTypeFilter === "game" ? " games" : " total")}
                      </span>
                      <span className="text-sem-success font-medium">{free}F</span>
                      <span className="text-sem-warning font-medium">{paid}P</span>
                      <span>
                        Med:{" "}
                        <strong className="text-text-main">
                          {pub.median_paid_price ? `$${Number(pub.median_paid_price).toFixed(2)}` : "—"}
                        </strong>
                      </span>
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

        {comparisonPublishers.length > 12 && (
          <div className="px-4 py-3 border-t border-border-subtle bg-input-bg/30 flex justify-center">
            <button
              type="button"
              onClick={() => setShowAllPublishers((prev) => !prev)}
              className="h-8 px-4 rounded-lg bg-surface-solid border border-border-subtle text-xs font-medium text-text-main hover:border-border-strong transition"
            >
              {showAllPublishers
                ? "Collapse to Top 12 Accounts"
                : `Show all ${comparisonPublishers.length} accounts (+${comparisonPublishers.length - 12} more)`}
            </button>
          </div>
        )}
      </div>

      {/* SELECTED PUBLISHER SUMMARY BAR */}
      {selectedPublisherObj && (
        <div className="bg-surface-solid border border-border-subtle rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-main flex flex-wrap items-center gap-2.5">
              <span>Account: {getDisplayName(selectedPublisherObj.publisher_name)}</span>
              {selectedPublisherObj.display_name && (
                <span className="text-xs font-normal text-text-muted">(Amazon: {selectedPublisherObj.publisher_name})</span>
              )}
              {isAdmin && (
                <>
                  <button
                    type="button"
                    disabled={scanStatus.running}
                    onClick={() => handleRescanPublisher(selectedPublisherObj)}
                    className="text-xs text-sem-warning hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <AtlasIcon name="refresh" size={13} /> Re-scan
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
                    <AtlasIcon name="edit" size={13} /> Rename / Lists
                  </button>
                </>
              )}
              <a
                href={selectedPublisherObj.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-link hover:underline inline-flex items-center gap-1"
              >
                Amazon Store <AtlasIcon name="open_in_new" size={13} />
              </a>
            </div>
            <div className="text-xs text-text-muted mt-1 tabular-nums">
              {selectedPublisherObj.total_games} all-time games ({selectedPublisherObj.free_games} Free ·{" "}
              {selectedPublisherObj.paid_games} Paid) · Median Paid $
              {Number(selectedPublisherObj.median_paid_price || 0).toFixed(2)} ·{" "}
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
              <span>Games ({filteredGames.length.toLocaleString()})</span>
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
            <p className="text-xs text-text-muted mt-0.5">
              Click any game row to inspect its details and compare free vs. paid sibling titles from that publisher.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <AtlasSelect
              value={selectedPublisher}
              onChange={(val) => setSelectedPublisher(val)}
              options={publisherSelectOptions}
              ariaLabel="Filter accounts in view"
              placeholder="All Accounts in View"
              searchPlaceholder="Search accounts..."
              buttonClassName="max-w-[220px]"
            />

            <AtlasSelect
              value={selectedPricing}
              onChange={(val) => setSelectedPricing(val)}
              options={pricingSelectOptions}
              ariaLabel="Filter pricing"
              placeholder="All Pricing"
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
                placeholder="Search title, ASIN, account..."
                className="h-9 pl-8 pr-3 rounded-lg bg-input-bg border border-border-subtle text-xs font-medium text-text-main placeholder:text-text-muted focus:border-accent outline-none transition w-48 sm:w-56"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <TableSkeleton rows={8} cols={7} />
        ) : (
          <>
            <div className="overflow-x-auto border border-border-subtle rounded-xl max-h-[540px] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-input-bg text-text-muted uppercase tracking-wider text-[11px] sticky top-0 z-10 border-b border-border-subtle">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Game</th>
                    <th className="py-3 px-3 font-semibold">Account</th>
                    <th className="py-3 px-3 font-semibold">Pricing</th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy(sortBy === "price_desc" ? "price_asc" : "price_desc")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "price_desc" || sortBy === "price_asc" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>Price</span>
                        {(sortBy === "price_desc" || sortBy === "price_asc") && (
                          <AtlasIcon name={sortBy === "price_asc" ? "arrow_upward" : "arrow_downward"} size={12} />
                        )}
                      </button>
                    </th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy("rating")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "rating" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>Rating</span>
                        {sortBy === "rating" && <AtlasIcon name="arrow_downward" size={12} />}
                      </button>
                    </th>
                    <th className="py-3 px-3 text-right font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy("reviews")}
                        className={`inline-flex items-center justify-end gap-1 uppercase hover:text-text-main transition-colors ${
                          sortBy === "reviews" ? "text-link font-semibold" : ""
                        }`}
                      >
                        <span>Reviews</span>
                        {sortBy === "reviews" && <AtlasIcon name="arrow_downward" size={12} />}
                      </button>
                    </th>
                    <th className="py-3 px-4 text-right font-semibold">
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {filteredGames.slice(0, visibleRowCount).map((g) => (
                    <tr
                      key={`${g.asin}-${g.publisher_id || g.publisher_name}`}
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
                            />
                          )}
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-text-main truncate max-w-xs">{g.title}</div>
                            <div className="flex items-center gap-1.5 text-[11px] font-mono text-text-muted mt-0.5">
                              <span>{g.asin}</span>
                              <button
                                type="button"
                                onClick={(e) => handleCopyAsin(g.asin, e)}
                                title="Copy ASIN"
                                aria-label={`Copy ${g.asin}`}
                                className="p-0.5 rounded hover:bg-input-bg text-text-muted hover:text-link transition shrink-0"
                              >
                                <AtlasIcon
                                  name={copiedAsin === g.asin ? "check" : "content_copy"}
                                  size={12}
                                  className={copiedAsin === g.asin ? "text-sem-success" : ""}
                                />
                              </button>
                              {Number(g.shared_publisher_count) > 1 && (
                                <Badge
                                  tone="accent"
                                  className="font-sans"
                                  title={`Published under ${g.shared_publisher_count} accounts: ${(g.shared_publishers || []).join(", ")}`}
                                >
                                  Shared ({g.shared_publisher_count} accounts)
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-text-muted">{getDisplayName(g.publisher_name)}</td>
                      <td className="py-2.5 px-3">
                        <Badge tone={g.pricing === "free" ? "success" : "warning"} className="uppercase">
                          {g.pricing}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-text-main tabular-nums">
                        {g.pricing === "free" ? "$0.00" : `$${Number(g.price || 0).toFixed(2)}`}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        {g.rating ? (
                          <span className="inline-flex items-center justify-end gap-1 text-text-main font-medium">
                            <AtlasIcon name="star" size={12} className="text-sem-warning" />
                            {Number(g.rating).toFixed(1)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        {g.review_count ? Number(g.review_count).toLocaleString() : "0"}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-text-muted tabular-nums">
                        {g.release_date ? String(g.release_date).slice(0, 10) : "Unknown"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredGames.length > visibleRowCount && (
              <div className="pt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                <span className="tabular-nums">
                  Showing {visibleRowCount.toLocaleString()} of {filteredGames.length.toLocaleString()} titles
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVisibleRowCount((c) => c + 200)}
                    className="h-8 px-3 rounded-lg bg-input-bg border border-border-subtle text-text-main font-medium hover:bg-surface-solid transition"
                  >
                    Show +200 More
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibleRowCount(filteredGames.length)}
                    className="h-8 px-3 rounded-lg atlas-badge-accent border font-medium hover:opacity-90 transition"
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
      {/* MODAL 1: MANAGE COMPETITOR LISTS (z-[100])                            */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {listModal && (
            <motion.div
              key="amazon-list-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setListModal(null)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.form
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => handleSaveListModal(e, false)}
                className="w-full max-w-lg bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[15px] font-semibold text-text-main">Manage Competitor Lists</h3>
                  <button
                    type="button"
                    onClick={() => setListModal(null)}
                    aria-label="Close list modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                {/* Switch between any existing list or "+ Create New List" */}
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
                    placeholder="e.g. Ozi Tech"
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
                                <div className="text-[11px] text-text-muted truncate">Amazon: {p.publisher_name}</div>
                              )}
                            </div>
                          </div>
                          <span className="text-[11px] font-mono text-text-muted shrink-0 tabular-nums">
                            {p.total_games} games ({p.free_games}F / {p.paid_games}P)
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Direct Link to Add & Scan New Amazon Accounts into this list */}
                <div className="p-3 rounded-xl bg-input-bg/60 border border-border-subtle flex items-center justify-between gap-3">
                  <div className="text-xs text-text-main">
                    Want to scan <strong>brand-new Amazon links</strong> into this list?
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
        </AnimatePresence>,
        document.body
      )}

      {/* ===================================================================== */}
      {/* MODAL 2: ADD & SCAN AMAZON ACCOUNTS (z-[100])                         */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {showScannerModal && (
            <motion.div
              key="amazon-scanner-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setShowScannerModal(false)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-xl bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-main">Add &amp; Scan Amazon Publisher Links</h3>
                    <p className="text-xs text-text-muted mt-0.5">
                      Paste one or more Amazon publisher links, choose a destination list, and scan.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowScannerModal(false)}
                    aria-label="Close Amazon scanner modal"
                    className="p-1 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main"
                  >
                    <AtlasIcon name="close" size={18} />
                  </button>
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-text-muted">Amazon Appstore Publisher URLs (one per line)</span>
                  <button
                    type="button"
                    onClick={() => {
                      const text = SAMPLE_LINKS.join("\n");
                      setLinksInput(text);
                      handleValidateLinks(text);
                    }}
                    className="text-xs font-medium text-link hover:underline"
                  >
                    Load 16 Benchmark Links
                  </button>
                </div>

                <textarea
                  rows={5}
                  value={linksInput}
                  onChange={(e) => setLinksInput(e.target.value)}
                  placeholder="https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BStop%2BStudio&search-type=ss"
                  className="w-full rounded-lg bg-input-bg border border-border-subtle p-3 text-xs font-mono text-text-main focus:outline-none focus:border-accent"
                />

                {/* Destination List Picker */}
                <div className="bg-input-bg/60 border border-border-subtle rounded-xl p-3.5 flex flex-col gap-3">
                  <div className="text-xs font-semibold text-text-main">
                    Assign Scanned Accounts to Competitor List(s)
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                            checked
                              ? "atlas-badge-warning border font-semibold"
                              : "bg-surface-solid text-text-muted border-border-subtle hover:text-text-main"
                          }`}
                        >
                          <AtlasIcon
                            name={checked ? "check_box" : "check_box_outline_blank"}
                            size={14}
                          />
                          {list.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs text-text-muted shrink-0">Or create &amp; assign to a new list:</span>
                    <input
                      type="text"
                      value={scanNewListName}
                      onChange={(e) => setScanNewListName(e.target.value)}
                      placeholder="e.g. Ozi Tech"
                      className="h-9 rounded-lg bg-surface-solid border border-border-subtle px-3 text-xs text-text-main flex-1 focus:outline-none focus:border-accent"
                    />
                  </div>
                </div>

                {validationResult && (
                  <div className="border border-border-subtle rounded-xl overflow-hidden">
                    <div className="bg-input-bg px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-text-main tabular-nums">
                        Validation: {validationResult.validCount} Valid · {validationResult.duplicateCount} Duplicates ·{" "}
                        {validationResult.invalidCount} Invalid
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
                    <div className="max-h-40 overflow-y-auto divide-y divide-border-subtle text-xs">
                      {validationResult.validation.map((item) => (
                        <div key={item.index} className="px-4 py-2 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium text-text-main truncate">
                              {item.valid ? item.publisher : item.input}
                            </div>
                            <div className="text-[11px] text-text-muted truncate">
                              {item.valid ? item.normalizedUrl : item.error}
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
                            {!item.valid ? "Invalid" : item.duplicate ? "Duplicate" : "Valid"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* ===================================================================== */}
      {/* MODAL 3: RENAME ACCOUNT & ASSIGN LISTS (z-[100])                      */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {editingPublisher && (
            <motion.div
              key="amazon-edit-publisher-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setEditingPublisher(null)}
              className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.form
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
                onSubmit={handleSavePublisherModal}
                className="w-full max-w-md bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-main">Rename Account &amp; Lists</h3>
                    <p className="text-xs text-text-muted">Amazon Brand: {editingPublisher.publisher_name}</p>
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
                    Custom Display Name (Leave blank to use original Amazon name)
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
                    Competitor Lists (Account can belong to multiple lists)
                  </label>
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
                              setEditingPublisher({
                                ...editingPublisher,
                                list_ids: checked ? cur.filter((id) => id !== list.id) : [...cur, list.id]
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
        </AnimatePresence>,
        document.body
      )}

      {/* ===================================================================== */}
      {/* CONFIRMATION DIALOG (z-[110] — sits above all modals & drawers)       */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {confirmDeletePub && (
            <motion.div
              key="amazon-delete-pub-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setConfirmDeletePub(null)}
              className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm bg-surface-solid border border-border-subtle rounded-xl p-6 flex flex-col gap-4 shadow-2xl"
              >
                <h4 className="text-sm font-semibold text-text-main">
                  Delete &ldquo;{getDisplayName(confirmDeletePub.publisher_name)}&rdquo; from Atlas?
                </h4>
                <p className="text-xs text-text-muted leading-relaxed">
                  This will permanently remove the publisher and its extracted games from Atlas. If you only want to remove it from a Competitor List, uncheck the list instead.
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

      {/* ===================================================================== */}
      {/* GAME & PUBLISHER FUNNEL DETAIL DRAWER (z-[90] — above z-50 header)    */}
      {/* ===================================================================== */}
      {createPortal(
        <AnimatePresence>
          {activeGameDrawer && (
            <motion.div
              key="amazon-game-drawer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setActiveGameDrawer(null)}
              className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex justify-end"
            >
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "tween", duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-lg bg-surface-solid border-l border-border-subtle h-full overflow-y-auto p-6 shadow-2xl"
              >
                <div key={activeGameDrawer.asin} className="atlas-tab-swap flex flex-col gap-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3.5">
                      {activeGameDrawer.icon && (
                        <img
                          src={activeGameDrawer.icon}
                          alt=""
                          className="w-16 h-16 rounded-xl object-cover border border-border-subtle shrink-0"
                        />
                      )}
                      <div>
                        <Badge tone={activeGameDrawer.pricing === "free" ? "success" : "warning"} className="uppercase">
                          {activeGameDrawer.pricing === "free"
                            ? "Free User-Acquisition Title"
                            : `Paid Title · $${Number(activeGameDrawer.price || 0).toFixed(2)}`}
                        </Badge>
                        <h3 className="text-[15px] font-semibold text-text-main mt-1.5">{activeGameDrawer.title}</h3>
                        <div className="text-xs text-text-muted">{getDisplayName(activeGameDrawer.publisher_name)}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveGameDrawer(null)}
                      aria-label="Close Amazon game drawer"
                      className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main shrink-0"
                    >
                      <AtlasIcon name="close" size={18} />
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="bg-input-bg border border-border-subtle rounded-lg p-3">
                      <div className="text-[11px] text-text-muted">ASIN</div>
                      <div className="flex items-center justify-between gap-1.5 mt-0.5">
                        <div className="text-xs font-mono font-semibold text-text-main truncate">{activeGameDrawer.asin}</div>
                        <button
                          type="button"
                          onClick={(e) => handleCopyAsin(activeGameDrawer.asin, e)}
                          title="Copy ASIN"
                          aria-label={`Copy ${activeGameDrawer.asin}`}
                          className="p-0.5 rounded hover:bg-surface-solid text-text-muted hover:text-link transition shrink-0"
                        >
                          <AtlasIcon
                            name={copiedAsin === activeGameDrawer.asin ? "check" : "content_copy"}
                            size={13}
                            className={copiedAsin === activeGameDrawer.asin ? "text-sem-success" : ""}
                          />
                        </button>
                      </div>
                    </div>
                    <div className="bg-input-bg border border-border-subtle rounded-lg p-3">
                      <div className="text-[11px] text-text-muted">Rating &amp; Reviews</div>
                      <div className="text-xs font-semibold text-text-main mt-0.5 tabular-nums flex items-center gap-1">
                        <AtlasIcon name="star" size={12} className="text-sem-warning" />
                        <span>{activeGameDrawer.rating ?? "—"}</span>
                        <span className="text-text-muted font-normal">({Number(activeGameDrawer.review_count || 0).toLocaleString()})</span>
                      </div>
                    </div>
                    <div className="bg-input-bg border border-border-subtle rounded-lg p-3">
                      <div className="text-[11px] text-text-muted">Launch Date</div>
                      <div className="text-xs font-mono font-semibold text-text-main mt-0.5 tabular-nums">
                        {activeGameDrawer.release_date ? String(activeGameDrawer.release_date).slice(0, 10) : "Unknown"}
                      </div>
                    </div>
                  </div>

                  <a
                    href={
                      activeGameDrawer.url ||
                      `https://www.amazon.com/dp/${encodeURIComponent(activeGameDrawer.asin)}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="h-10 w-full rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-btn-primary-fg text-xs font-semibold transition flex items-center justify-center gap-2"
                  >
                    Open Listing on Amazon Appstore
                    <AtlasIcon name="open_in_new" size={15} />
                  </a>

                  {(() => {
                    const siblings = gamesByPublisher.get(activeGameDrawer.publisher_name) || [];
                    const paidSiblings = siblings.filter((g) => g.pricing === "paid" && g.asin !== activeGameDrawer.asin);
                    const freeSiblings = siblings.filter((g) => g.pricing === "free" && g.asin !== activeGameDrawer.asin);
                    const dispPub = getDisplayName(activeGameDrawer.publisher_name);
                    return (
                      <div className="flex flex-col gap-4 border-t border-border-subtle pt-4">
                        <div>
                          <h4 className="text-xs font-semibold text-sem-warning">
                            {dispPub}&rsquo;s Paid Titles ({paidSiblings.length})
                          </h4>
                          <p className="text-xs text-text-muted mb-2 mt-0.5">
                            Candidate paid games potentially promoted by this publisher&rsquo;s free catalogue:
                          </p>
                          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                            {paidSiblings.slice(0, 15).map((s) => (
                              <button
                                key={s.asin}
                                type="button"
                                onClick={() => setActiveGameDrawer(s)}
                                className="p-2.5 rounded-lg bg-input-bg hover:bg-surface-solid border border-transparent hover:border-border-subtle flex items-center justify-between gap-2 text-left text-xs transition"
                              >
                                <span className="truncate text-text-main font-medium">{s.title}</span>
                                <span className="font-mono text-sem-warning shrink-0 tabular-nums">
                                  ${Number(s.price || 0).toFixed(2)} · {s.review_count || 0} rev
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold text-sem-success">
                            {dispPub}&rsquo;s Top Free Titles ({freeSiblings.length})
                          </h4>
                          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto mt-1.5">
                            {freeSiblings.slice(0, 15).map((s) => (
                              <button
                                key={s.asin}
                                type="button"
                                onClick={() => setActiveGameDrawer(s)}
                                className="p-2.5 rounded-lg bg-input-bg hover:bg-surface-solid border border-transparent hover:border-border-subtle flex items-center justify-between gap-2 text-left text-xs transition"
                              >
                                <span className="truncate text-text-main font-medium">{s.title}</span>
                                <span className="font-mono text-sem-success shrink-0 tabular-nums">
                                  FREE · {Number(s.review_count || 0).toLocaleString()} rev
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* MODAL: MANAGE COMPETITOR BATCHES (GROUPS) (z-[100]) */}
      {createPortal(
        <AnimatePresence>
          {groupModal && (
            <motion.div
              key="amazon-group-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => setGroupModal(null)}
              className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
    </div>
  );
}

export default memo(AmazonIntelligenceView);
