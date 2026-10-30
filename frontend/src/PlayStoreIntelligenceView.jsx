import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "./apiConfig";
import { KeywordPanel } from "./AtlasIntelligenceLayer.jsx";
import UniversalGameDetailDrawer from "./UniversalGameDetailDrawer.jsx";

const SAMPLE_PLAY_LINKS = [
  "https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio",
  "https://play.google.com/store/apps/developer?id=Desert+Safari+Studios",
  "https://play.google.com/store/apps/developer?id=OZI+Apps",
  "https://play.google.com/store/apps/developer?id=Giochi+Studios",
  "https://play.google.com/store/apps/developer?id=Crushiz"
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

function formatCompactNumber(num) {
  const n = Number(num || 0);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
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
      dataTone: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
      dotTone: "bg-emerald-400",
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
      dataTone: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      dotTone: "bg-amber-400",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Developer page scan did not return apps."
    };
  }

  return {
    dataLabel: "Unscanned",
    dataTone: "bg-input-bg text-text-muted border-border-subtle",
    dotTone: "bg-text-muted",
    lastSyncedText: "Never",
    hasRefreshWarning: false,
    warningText: null
  };
}

export default function PlayStoreIntelligenceView({ onOpenCountryScan }) {
  const fetcher = useCallback((url, options = {}) => {
    const token = localStorage.getItem("atlas_auth_token");
    return fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(token ? { "x-atlas-token": token } : {}),
        ...(options.headers || {})
      }
    });
  }, []);

  const [overview, setOverview] = useState({
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
    snapshots: []
  });
  const [loading, setLoading] = useState(true);

  // Competitor List & Account Filter state
  const [selectedListId, setSelectedListId] = useState("all"); // "all" | "ungrouped" | number
  const [selectedPublisher, setSelectedPublisher] = useState("all");
  const [selectedPricing, setSelectedPricing] = useState("all"); // all | free | paid
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("installs"); // installs | delta | release | first_seen | reviews | rating

  // Launch Duration / Date Filter state (separating Play Store Launch Date vs. First Discovered in Atlas)
  const [dateBasis, setDateBasis] = useState("release_date"); // "release_date" | "first_seen_at"
  const [durationPreset, setDurationPreset] = useState("all"); // "all" | "today" | "7d" | "14d" | "30d" | "90d" | "6m" | "1y" | "custom"
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [includeUnknownDates, setIncludeUnknownDates] = useState(false);

  // Drawers & Modals (Layered z-index: Drawer z-[90], Modals z-[100], Confirmations z-[110])
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [showSheetModal, setShowSheetModal] = useState(false);
  const [showCountryBatchModal, setShowCountryBatchModal] = useState(false);
  const [listModal, setListModal] = useState(null); // { mode: 'create' | 'edit', listId: 'new' | number, name, description, publisherIds: number[] }
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

  // Google Sheet Preview & One-Way Importer state
  const [sheetPreview, setSheetPreview] = useState(null);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [sheetSelectedLists, setSheetSelectedLists] = useState([]);
  const [sheetAutoScanNew, setSheetAutoScanNew] = useState(true);
  const [isImportingSheet, setIsImportingSheet] = useState(false);
  const [sheetImportResult, setSheetImportResult] = useState(null);

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

  // Single-game refresh state + Drawer video assets & Keyword Intelligence
  const [refreshingPkg, setRefreshingPkg] = useState(null);
  const [drawerVideos, setDrawerVideos] = useState([]);
  const [drawerVideosLoading, setDrawerVideosLoading] = useState(false);
  const drawerVideosCacheRef = useRef(new Map());
  const [keywordTarget, setKeywordTarget] = useState(null);
  const [isSavingList, setIsSavingList] = useState(false);
  const [isSavingPublisher, setIsSavingPublisher] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetcher(`${API_BASE}/api/play/overview`);
      if (res.ok) {
        const data = await res.json();
        setOverview({
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
          publishers: data.publishers || [],
          games: data.games || [],
          snapshots: data.snapshots || []
        });
      }
    } catch (err) {
      console.error("Failed to load Play Store overview:", err);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // Poll Play Store publisher scan status & Country Batch Queue status
  useEffect(() => {
    const checkStatuses = async () => {
      try {
        const [scanRes, cqRes] = await Promise.all([
          fetcher(`${API_BASE}/api/play/scan-status`),
          fetcher(`${API_BASE}/api/play/country-queue/status`)
        ]);
        if (scanRes.ok) {
          const st = await scanRes.json();
          setScanStatus((prev) => {
            if (prev.running && !st.running) {
              loadOverview();
            }
            return st;
          });
        }
        if (cqRes.ok) {
          const cq = await cqRes.json();
          setCountryQueueStatus((prev) => {
            if (prev.running && !cq.running) {
              loadOverview();
            }
            return cq;
          });
        }
      } catch {}
    };
    checkStatuses();
    const timer = setInterval(checkStatuses, 2000);
    return () => clearInterval(timer);
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

  // Fetch Video Creatives when a game is opened in the Drawer
  useEffect(() => {
    const pkg = activeGameDrawer?.package_name;
    if (!pkg) {
      setDrawerVideos([]);
      setDrawerVideosLoading(false);
      return;
    }

    const cached = drawerVideosCacheRef.current.get(pkg);
    if (cached && cached.expiresAt > Date.now()) {
      setDrawerVideos(cached.data);
      setDrawerVideosLoading(false);
      return;
    }

    let cancelled = false;
    setDrawerVideos([]);
    setDrawerVideosLoading(true);

    fetcher(`${API_BASE}/api/video-assets?packageName=${encodeURIComponent(pkg)}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((payload) => {
        const list = Array.isArray(payload) ? payload : [];
        drawerVideosCacheRef.current.set(pkg, {
          expiresAt: Date.now() + 20000,
          data: list
        });
        if (!cancelled) setDrawerVideos(list);
      })
      .catch(() => {
        if (!cancelled) setDrawerVideos([]);
      })
      .finally(() => {
        if (!cancelled) setDrawerVideosLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeGameDrawer?.package_name, fetcher]);

  // Keyboard Escape dismissal & body scroll lock when modals/drawer are open
  useEffect(() => {
    const anyOpen = Boolean(
      activeGameDrawer ||
        keywordTarget ||
        showScannerModal ||
        showSheetModal ||
        showCountryBatchModal ||
        listModal ||
        editingPublisher ||
        confirmDeletePub
    );
    if (!anyOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (keywordTarget) setKeywordTarget(null);
        else if (confirmDeletePub) setConfirmDeletePub(null);
        else if (editingPublisher) setEditingPublisher(null);
        else if (listModal) setListModal(null);
        else if (showCountryBatchModal) setShowCountryBatchModal(false);
        else if (showSheetModal) setShowSheetModal(false);
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
    keywordTarget,
    showScannerModal,
    showSheetModal,
    showCountryBatchModal,
    listModal,
    editingPublisher,
    confirmDeletePub
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

  // Publishers visible under the active Competitor List filter
  const visiblePublishers = useMemo(() => {
    return (overview.publishers || []).filter((p) => {
      if (selectedListId === "all") return true;
      const lIds = Array.isArray(p.list_ids) ? p.list_ids : [];
      if (selectedListId === "ungrouped") return lIds.length === 0;
      return lIds.includes(Number(selectedListId));
    });
  }, [overview.publishers, selectedListId]);

  const visiblePublisherNames = useMemo(
    () => new Set(visiblePublishers.map((p) => p.publisher_name)),
    [visiblePublishers]
  );

  const activeListObj = useMemo(() => {
    if (selectedListId === "all" || selectedListId === "ungrouped") return null;
    return (overview.lists || []).find((l) => l.id === Number(selectedListId)) || null;
  }, [overview.lists, selectedListId]);

  const ungroupedCount = useMemo(
    () => (overview.publishers || []).filter((p) => !p.list_ids || p.list_ids.length === 0).length,
    [overview.publishers]
  );

  const unscannedPublisherCount = useMemo(
    () => (overview.publishers || []).filter((p) => Number(p.total_games || 0) === 0).length,
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
    const totalInstalls = matchingArr.reduce((s, g) => s + (Number(g.real_installs ?? g.min_installs) || 0), 0);
    const totalDailyDelta = matchingArr.reduce((s, g) => s + (Number(g.installs_delta_1d) || 0), 0);
    const countryScannedCount = matchingArr.filter((g) => Boolean(g.country_scan)).length;

    return {
      allTimeUnique: allTimeArr.length,
      totalListings: inScopeGames.length,
      matchingUnique: matchingArr.length,
      freeMatching,
      paidMatching,
      freeShare: matchingArr.length ? freeMatching / matchingArr.length : 0,
      totalInstalls,
      totalDailyDelta,
      countryScannedCount,
      knownDateCount,
      unknownDateCount
    };
  }, [overview.games, visiblePublisherNames, selectedPublisher, evaluateGameDate]);

  // Per-publisher stats dynamically computed for the active date filter
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
        allTimeTotal: Number(pub.total_games) || 0
      });
    }
    for (const g of overview.games || []) {
      const entry = map.get(g.publisher_name);
      if (!entry) continue;
      const dEval = evaluateGameDate(g);
      if (!dEval.known) entry.unknownDate += 1;
      if (dEval.inRange) {
        entry.total += 1;
        if (g.pricing === "free") entry.free += 1;
        else if (g.pricing === "paid") entry.paid += 1;
        entry.installs += Number(g.real_installs ?? g.min_installs) || 0;
        entry.dailyDelta += Number(g.installs_delta_1d) || 0;
      }
    }
    return map;
  }, [visiblePublishers, overview.games, evaluateGameDate]);

  const maxPublisherGames = useMemo(() => {
    return Math.max(
      1,
      ...visiblePublishers.map((p) => {
        const st = publisherStatsByName.get(p.publisher_name);
        return st ? st.total : Number(p.total_games) || 0;
      })
    );
  }, [visiblePublishers, publisherStatsByName]);

  const filteredGames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (overview.games || [])
      .filter((g) => {
        if (!visiblePublisherNames.has(g.publisher_name)) return false;
        if (selectedPublisher !== "all" && g.publisher_name !== selectedPublisher) return false;
        if (selectedPricing !== "all" && g.pricing !== selectedPricing) return false;
        const dEval = evaluateGameDate(g);
        if (!dEval.inRange) return false;
        if (q) {
          const disp = getDisplayName(g.publisher_name);
          const hay = `${g.title || ""} ${g.package_name || ""} ${g.publisher_name || ""} ${disp}`.toLowerCase();
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
    searchQuery,
    sortBy,
    getDisplayName,
    evaluateGameDate
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
      const res = await fetcher(`${API_BASE}/api/play/scan`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setValidationResult(null);
        setScanNewListName("");
        setShowScannerModal(false);
        if (data?.createdList?.id) {
          await loadOverview();
          setSelectedListId(data.createdList.id);
        }
      }
    } catch (err) {
      console.error("Play scan start failed:", err);
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

  // Single Game 1-Click Refresh
  const handleRefreshSingleGame = async (pkg, e) => {
    if (e) e.stopPropagation();
    if (!pkg || refreshingPkg) return;
    setRefreshingPkg(pkg);
    try {
      const res = await fetcher(`${API_BASE}/api/play/games/${encodeURIComponent(pkg)}/refresh`, {
        method: "POST"
      });
      if (res.ok) {
        await loadOverview();
        if (activeGameDrawer && activeGameDrawer.package_name === pkg) {
          const data = await res.json();
          if (data.game) {
            setActiveGameDrawer((prev) => (prev ? { ...prev, ...data.game } : null));
          }
        }
      }
    } catch (err) {
      console.error("Game refresh failed:", err);
    } finally {
      setRefreshingPkg(null);
    }
  };

  // Google Sheet Preview & Import
  const openSheetImporter = async () => {
    setShowSheetModal(true);
    setSheetImportResult(null);
    setIsLoadingSheet(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/sheet-preview`);
      if (res.ok) {
        const data = await res.json();
        setSheetPreview(data);
        setSheetSelectedLists((data.columns || []).map((c) => c.listName));
      }
    } catch (err) {
      console.error("Sheet preview error:", err);
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleConfirmSheetImport = async () => {
    if (!sheetPreview) return;
    setIsImportingSheet(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/sheet-import`, {
        method: "POST",
        body: JSON.stringify({
          listNames: sheetSelectedLists,
          autoScanNew: sheetAutoScanNew
        })
      });
      if (res.ok) {
        const data = await res.json();
        setSheetImportResult(data);
        await loadOverview();
        if (sheetAutoScanNew && Array.isArray(data.newPublisherUrls) && data.newPublisherUrls.length > 0) {
          await handleStartScan({
            mode: "batch",
            links: data.newPublisherUrls
          });
          setShowSheetModal(false);
        }
      }
    } catch (err) {
      console.error("Sheet import failed:", err);
    } finally {
      setIsImportingSheet(false);
    }
  };

  // Batch Country Scanner Queue Controls
  const handleStartCountryQueue = async (overridePayload = null) => {
    try {
      const payload = overridePayload || {
        scope: countryBatchScope,
        listId: countryBatchScope === "list" && activeListObj ? activeListObj.id : undefined,
        publisherId: countryBatchScope === "publisher" && selectedPublisherObj ? selectedPublisherObj.id : undefined,
        skipDays: countryBatchSkipDays
      };
      const res = await fetcher(`${API_BASE}/api/play/country-queue/start`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setShowCountryBatchModal(false);
      }
    } catch (err) {
      console.error("Failed to start country queue:", err);
    }
  };

  const handleControlCountryQueue = async (action) => {
    try {
      await fetcher(`${API_BASE}/api/play/country-queue/control`, {
        method: "POST",
        body: JSON.stringify({ action })
      });
    } catch (err) {
      console.error("Country queue control error:", err);
    }
  };

  // Save Create / Edit List modal
  const handleSaveListModal = async (e, openScannerAfter = false) => {
    if (e) e.preventDefault();
    if (!listModal || !listModal.name.trim()) return;
    setIsSavingList(true);
    try {
      let targetListId = listModal.listId;
      if (listModal.mode === "create") {
        const res = await fetcher(`${API_BASE}/api/play/lists`, {
          method: "POST",
          body: JSON.stringify({
            name: listModal.name.trim(),
            description: listModal.description?.trim() || null,
            publisherIds: listModal.publisherIds || []
          })
        });
        if (res.ok) {
          const data = await res.json();
          targetListId = data?.list?.id;
          await loadOverview();
          if (targetListId) setSelectedListId(targetListId);
          setListModal(null);
        }
      } else {
        await fetcher(`${API_BASE}/api/play/lists/${listModal.listId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: listModal.name.trim(),
            description: listModal.description?.trim() || null
          })
        });
        await fetcher(`${API_BASE}/api/play/lists/${listModal.listId}/publishers`, {
          method: "POST",
          body: JSON.stringify({
            action: "set",
            publisherIds: listModal.publisherIds || []
          })
        });
        await loadOverview();
        setListModal(null);
      }

      if (openScannerAfter && targetListId && targetListId !== "new") {
        setScanTargetListIds([Number(targetListId)]);
        setScanNewListName("");
        setShowScannerModal(true);
      }
    } catch (err) {
      console.error("Save list failed:", err);
    } finally {
      setIsSavingList(false);
    }
  };

  const handleDeleteList = async (listId) => {
    try {
      const res = await fetcher(`${API_BASE}/api/play/lists/${listId}`, { method: "DELETE" });
      if (res.ok) {
        if (Number(selectedListId) === Number(listId)) setSelectedListId("all");
        setListModal(null);
        await loadOverview();
      }
    } catch (err) {
      console.error("Delete list failed:", err);
    }
  };

  const handleSavePublisherModal = async (e) => {
    e.preventDefault();
    if (!editingPublisher) return;
    setIsSavingPublisher(true);
    try {
      const res = await fetcher(`${API_BASE}/api/play/publishers/${editingPublisher.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editingPublisher.display_name,
          listIds: editingPublisher.list_ids || []
        })
      });
      if (res.ok) {
        await loadOverview();
        setEditingPublisher(null);
      }
    } catch (err) {
      console.error("Save publisher failed:", err);
    } finally {
      setIsSavingPublisher(false);
    }
  };

  const handleRemoveFromCurrentList = async (pubId, listId = activeListObj?.id) => {
    if (!pubId || !listId) return;
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
        await loadOverview();
      }
    } catch (err) {
      console.error("Remove from list failed:", err);
    }
  };

  const executeDeletePublisherFromAtlas = async (pub) => {
    if (!pub || !pub.id) return;
    try {
      const res = await fetcher(`${API_BASE}/api/play/publishers/${pub.id}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedPublisher === pub.publisher_name) setSelectedPublisher("all");
        setConfirmDeletePub(null);
        setEditingPublisher(null);
        await loadOverview();
      }
    } catch (err) {
      console.error("Delete publisher failed:", err);
    }
  };

  const exportCsv = () => {
    const headers = [
      "Display Name",
      "Play Store Publisher",
      "Package Name",
      "Title",
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
      g.pricing,
      g.price ?? 0,
      g.real_installs ?? g.min_installs ?? 0,
      g.installs_delta_1d ?? 0,
      g.rating ?? "",
      g.review_count ?? 0,
      g.country_scan ? g.country_scan.liveCount : "",
      g.release_date ? String(g.release_date).slice(0, 10) : "",
      g.first_seen_at ? String(g.first_seen_at).slice(0, 10) : "",
      g.url
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-playstore-games.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const scanProgressPct = useMemo(() => {
    const total = Number(scanStatus.totalPublishers) || 0;
    if (!total) return 0;
    const completed = Number(scanStatus.completedPublishers) || 0;
    if (!scanStatus.running && scanStatus.isComplete) return 100;
    const activeFraction = scanStatus.running ? 0.35 : 0.1;
    return Math.min(98, Math.round(((completed + activeFraction) / total) * 100));
  }, [scanStatus]);

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
    <div className="flex flex-col w-full gap-5">
      {/* HEADER */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 px-1">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[11px] font-semibold mb-1.5">
            <span className="material-symbols-outlined text-[15px]">shop</span>
            Play Store Intelligence · Primary Discovery Engine
          </div>
          <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">
            Publisher Catalogues &amp; Early Launch Radar
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={scanStatus.running}
            onClick={() =>
              handleStartScan({
                mode: unscannedPublisherCount > 0 ? "unscanned_only" : "update_all"
              })
            }
            title={
              unscannedPublisherCount > 0
                ? `Scan ${unscannedPublisherCount} unscanned publisher accounts first`
                : `Refresh all ${overview.publishers.length} Play Store publisher catalogues`
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/25 transition disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">sync</span>
            {unscannedPublisherCount > 0
              ? `Scan Unscanned (${unscannedPublisherCount})`
              : `Update All Publishers (${overview.publishers.length})`}
          </button>

          {unscannedPublisherCount > 0 && (
            <button
              type="button"
              disabled={scanStatus.running}
              onClick={() => handleStartScan({ mode: "update_all" })}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-semibold hover:border-emerald-400 transition disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]">autorenew</span>
              Update All ({overview.publishers.length})
            </button>
          )}

          <button
            type="button"
            onClick={openSheetImporter}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue transition"
          >
            <span className="material-symbols-outlined text-[16px]">table_View</span>
            Sync Google Sheet
          </button>

          <button
            type="button"
            onClick={() => {
              if (selectedPublisherObj) setCountryBatchScope("publisher");
              else if (activeListObj) setCountryBatchScope("list");
              else setCountryBatchScope("all");
              setShowCountryBatchModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue transition"
          >
            <span className="material-symbols-outlined text-[16px]">public</span>
            Batch Country Scan
          </button>

          <button
            type="button"
            onClick={() => openListManager(activeListObj || null)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue transition"
          >
            <span className="material-symbols-outlined text-[16px]">folder_managed</span>
            Manage Lists ({overview.lists.length})
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
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 transition shadow-sm"
          >
            <span className="material-symbols-outlined text-[17px]">add_link</span>
            Add &amp; Scan Accounts
          </button>

          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:bg-input-bg transition"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            Export CSV ({filteredGames.length})
          </button>
        </div>
      </div>

      {/* LIVE PROGRESS BAR 1: PLAY STORE PUBLISHER SCANNER */}
      {(scanStatus.running ||
        scanStatus.state === "complete" ||
        scanStatus.state === "cancelled" ||
        scanStatus.state === "error") &&
        scanStatus.log && (
          <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col gap-3 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    scanStatus.running
                      ? "bg-emerald-400 animate-pulse"
                      : scanStatus.state === "error"
                      ? "bg-urgent-red"
                      : "bg-emerald-400"
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text-main flex flex-wrap items-center gap-2">
                    <span>
                      {scanStatus.running
                        ? `Scanning ${scanStatus.currentPublisher || "..."} (${scanStatus.completedPublishers || 0}/${scanStatus.totalPublishers || 1} completed)`
                        : scanStatus.state === "cancelled"
                        ? "Scan Aborted · Partial Results Saved"
                        : scanStatus.state === "error"
                        ? "Scan Finished with Errors"
                        : "Play Store Catalogue Scan Complete"}
                    </span>
                    {scanStatus.phase && scanStatus.running && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-electric-blue/20 text-electric-blue">
                        {scanStatus.phase.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-text-muted">
                      · Elapsed: {formatDurationSec(elapsedSec)} · Games Synced: {scanStatus.totalGamesSaved || 0} · Newly Discovered: {scanStatus.newGamesDiscovered || 0}
                    </span>
                  </div>
                  <div className="text-[11px] text-text-muted font-mono truncate mt-0.5">{scanStatus.log}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!scanStatus.running && Array.isArray(scanStatus.failedLinks) && scanStatus.failedLinks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleStartScan({ mode: "batch", links: scanStatus.failedLinks })}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold hover:bg-amber-500/25 transition inline-flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-[14px]">refresh</span>
                    Retry Failed ({scanStatus.failedLinks.length})
                  </button>
                )}
                {scanStatus.running && (
                  <button
                    type="button"
                    onClick={handleCancelScan}
                    className="px-3.5 py-1.5 rounded-xl bg-urgent-red/15 border border-urgent-red/30 text-urgent-red text-xs font-semibold hover:bg-urgent-red/25 transition"
                  >
                    Abort &amp; Save Collected
                  </button>
                )}
              </div>
            </div>

            {scanStatus.totalPublishers > 0 && (
              <div className="w-full h-2 rounded-full bg-input-bg overflow-hidden">
                <div
                  style={{ width: `${scanStatus.running ? scanProgressPct : 100}%` }}
                  className={`h-full transition-all duration-300 ${
                    scanStatus.state === "error"
                      ? "bg-urgent-red"
                      : scanStatus.running
                      ? "bg-electric-blue"
                      : "bg-emerald-500"
                  }`}
                />
              </div>
            )}
          </div>
        )}

      {/* LIVE PROGRESS BAR 2: RESUMABLE BATCH COUNTRY SCANNER QUEUE */}
      {(countryQueueStatus.running ||
        countryQueueStatus.paused ||
        countryQueueStatus.state === "complete" ||
        countryQueueStatus.state === "cancelled" ||
        countryQueueStatus.state === "error") &&
        countryQueueStatus.totalPackages > 0 && (
          <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col gap-3 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    countryQueueStatus.running
                      ? "bg-electric-blue animate-pulse"
                      : countryQueueStatus.paused
                      ? "bg-amber-400"
                      : countryQueueStatus.state === "error"
                      ? "bg-urgent-red"
                      : "bg-emerald-400"
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text-main flex flex-wrap items-center gap-2">
                    <span>
                      🌍 Batch Country Scanner ({countryQueueStatus.scopeLabel || "Atlas"}):{" "}
                      {countryQueueStatus.completedPackages}/{countryQueueStatus.totalPackages} games
                    </span>
                    {countryQueueStatus.skippedPackages > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-input-bg text-text-muted">
                        {countryQueueStatus.skippedPackages} skipped as fresh
                      </span>
                    )}
                    {countryQueueStatus.running && countryQueueStatus.currentAppTitle && (
                      <span className="text-[11px] font-mono text-electric-blue">
                        · Current: {countryQueueStatus.currentAppTitle} ({countryQueueStatus.currentCountryChecked}/
                        {countryQueueStatus.currentCountryTotal} countries)
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted font-mono truncate mt-0.5">{countryQueueStatus.log}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {countryQueueStatus.running && (
                  <button
                    type="button"
                    onClick={() => handleControlCountryQueue("pause")}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold hover:bg-amber-500/25 transition"
                  >
                    Pause
                  </button>
                )}
                {countryQueueStatus.paused && (
                  <button
                    type="button"
                    onClick={() => handleControlCountryQueue("resume")}
                    className="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/25 transition"
                  >
                    Resume ({countryQueueStatus.remainingPackages} left)
                  </button>
                )}
                {!countryQueueStatus.running && countryQueueStatus.failedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => handleStartCountryQueue({ scope: "retry_failed", skipDays: 0 })}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold hover:bg-amber-500/25 transition"
                  >
                    Retry Failed ({countryQueueStatus.failedCount})
                  </button>
                )}
                {(countryQueueStatus.running || countryQueueStatus.paused) && (
                  <button
                    type="button"
                    onClick={() => handleControlCountryQueue("cancel")}
                    className="px-3 py-1.5 rounded-xl bg-urgent-red/15 border border-urgent-red/30 text-urgent-red text-xs font-semibold hover:bg-urgent-red/25 transition"
                  >
                    Cancel Queue
                  </button>
                )}
              </div>
            </div>

            <div className="w-full h-2 rounded-full bg-input-bg overflow-hidden">
              <div
                style={{ width: `${countryQueuePct}%` }}
                className={`h-full transition-all duration-300 ${
                  countryQueueStatus.paused
                    ? "bg-amber-400"
                    : countryQueueStatus.running
                    ? "bg-electric-blue"
                    : "bg-emerald-500"
                }`}
              />
            </div>
          </div>
        )}

      {/* COMPETITOR LISTS & LAUNCH DATE FILTER BAR */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col gap-3.5">
        {/* Row 1: Competitor Lists */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mr-1">
              Competitor List:
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectedListId("all");
                setSelectedPublisher("all");
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 border ${
                selectedListId === "all"
                  ? "bg-electric-blue text-white border-electric-blue"
                  : "bg-input-bg text-text-muted border-border-subtle hover:text-text-main"
              }`}
            >
              <span>All Accounts</span>
              <span className="px-1.5 py-0.2 rounded bg-black/20 text-[10px] font-mono">
                {overview.publishers.length}
              </span>
            </button>

            {(overview.lists || []).map((list) => {
              const isActive = Number(selectedListId) === Number(list.id);
              return (
                <div
                  key={list.id}
                  className={`inline-flex items-center rounded-xl text-xs font-semibold border transition overflow-hidden ${
                    isActive
                      ? "bg-emerald-500 text-slate-950 border-emerald-400"
                      : "bg-input-bg text-text-main border-border-subtle hover:border-emerald-500/40"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedListId(isActive ? "all" : list.id);
                      setSelectedPublisher("all");
                    }}
                    className="px-3 py-1.5 flex items-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[14px]">folder</span>
                    <span>{list.name}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                        isActive ? "bg-black/15 text-slate-950" : "bg-bg-base text-text-muted"
                      }`}
                    >
                      {list.account_count}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openListManager(list);
                    }}
                    title={`Edit "${list.name}"`}
                    className={`px-2 py-1.5 border-l ${
                      isActive
                        ? "border-black/15 hover:bg-black/10 text-slate-950"
                        : "border-border-subtle hover:bg-surface-solid text-text-muted hover:text-text-main"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[13px]">edit</span>
                  </button>
                </div>
              );
            })}

            {ungroupedCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedListId(selectedListId === "ungrouped" ? "all" : "ungrouped");
                  setSelectedPublisher("all");
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 border ${
                  selectedListId === "ungrouped"
                    ? "bg-electric-blue text-white border-electric-blue"
                    : "bg-input-bg text-text-muted border-border-subtle hover:text-text-main"
                }`}
              >
                <span>Ungrouped</span>
                <span className="px-1.5 py-0.2 rounded bg-black/20 text-[10px] font-mono">{ungroupedCount}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => openListManager(null)}
              className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-input-bg border border-dashed border-border-subtle text-text-muted hover:text-electric-blue hover:border-electric-blue transition inline-flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">add</span>
              New List
            </button>
          </div>

          {activeListObj && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setScanTargetListIds([activeListObj.id]);
                  setShowScannerModal(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-electric-blue/15 text-electric-blue text-[11px] font-semibold hover:bg-electric-blue/25"
              >
                <span className="material-symbols-outlined text-[14px]">add_link</span>
                Add Accounts to "{activeListObj.name}"
              </button>
              <button
                type="button"
                disabled={scanStatus.running || !activeListObj.account_count}
                onClick={() => handleRescanList(activeListObj)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 text-[11px] font-semibold hover:bg-emerald-500/25 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                Re-scan List ({activeListObj.account_count})
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
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-400 text-[11px] font-semibold hover:bg-amber-500/25 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">public</span>
                Scan List Countries ({activeListObj.unique_games})
              </button>
            </div>
          )}
        </div>

        {/* Row 2: Launch Date / Early Discovery Filter */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-border-subtle">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={dateBasis}
              onChange={(e) => setDateBasis(e.target.value)}
              className="rounded-lg bg-input-bg border border-border-subtle px-2.5 py-1 text-[11px] font-semibold text-text-main"
            >
              <option value="release_date">Filter by: Play Store Launch Date</option>
              <option value="first_seen_at">Filter by: First Discovered in Atlas</option>
            </select>

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
                onClick={() => setDurationPreset(p.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                  durationPreset === p.id
                    ? "bg-electric-blue text-white"
                    : "bg-input-bg text-text-muted hover:text-text-main"
                }`}
              >
                {p.label}
              </button>
            ))}

            {durationPreset === "custom" && (
              <div className="flex items-center gap-1.5 ml-1">
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="rounded-lg bg-input-bg border border-border-subtle px-2 py-1 text-xs text-text-main"
                />
                <span className="text-xs text-text-muted">to</span>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="rounded-lg bg-input-bg border border-border-subtle px-2 py-1 text-xs text-text-main"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
            <span>
              Known dates: <strong className="text-text-main">{scopedStats.knownDateCount.toLocaleString()}</strong>
              {scopedStats.unknownDateCount > 0 && (
                <>
                  {" "}
                  · Unknown dates: <strong className="text-amber-400">{scopedStats.unknownDateCount.toLocaleString()}</strong>
                </>
              )}
            </span>
            {dateWindow.active && scopedStats.unknownDateCount > 0 && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-text-main">
                <input
                  type="checkbox"
                  checked={includeUnknownDates}
                  onChange={(e) => setIncludeUnknownDates(e.target.checked)}
                />
                <span>Include unknown dates</span>
              </label>
            )}
          </div>
        </div>
      </div>

      {/* 4 CLEAN KPI CARDS (Scoped to active list + account + date filter) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-text-muted">
            {selectedPublisher !== "all"
              ? `Total Games (${getDisplayName(selectedPublisher)})`
              : activeListObj
              ? `Total Games in "${activeListObj.name}"`
              : "Total Unique Play Games"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.allTimeUnique.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {visiblePublishers.length} publisher account{visiblePublishers.length === 1 ? "" : "s"}
            {unscannedPublisherCount > 0 ? ` (${unscannedPublisherCount} unscanned)` : ""}
          </div>
        </div>

        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-electric-blue font-medium">
            {dateWindow.active
              ? `${dateBasis === "first_seen_at" ? "Discovered" : "Launched"} (${dateWindow.label})`
              : "Games in Selected Period"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.matchingUnique.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {scopedStats.freeMatching.toLocaleString()} Free · {scopedStats.paidMatching.toLocaleString()} Paid
          </div>
        </div>

        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-emerald-400 font-medium">
            Total Real Installs {dateWindow.active ? `(${dateWindow.label})` : ""}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">
            {formatCompactNumber(scopedStats.totalInstalls)}
          </div>
          <div className="text-[10px] text-emerald-400 font-mono mt-1">
            +{formatCompactNumber(scopedStats.totalDailyDelta)} / day velocity
          </div>
        </div>

        <div
          onClick={() => setShowCountryBatchModal(true)}
          className="cursor-pointer bg-surface-solid border border-border-subtle hover:border-electric-blue/50 rounded-2xl p-4 transition"
        >
          <div className="text-[11px] text-amber-400 font-medium">Country Availability Coverage</div>
          <div className="text-2xl font-semibold text-text-main mt-1">
            {scopedStats.countryScannedCount.toLocaleString()}{" "}
            <span className="text-sm font-normal text-text-muted">/ {scopedStats.matchingUnique.toLocaleString()}</span>
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            Click to queue batch country scan →
          </div>
        </div>
      </div>

      {/* PUBLISHER COMPARISON */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-subtle pb-3">
          <div>
            <h2 className="text-base font-semibold text-text-main">Publisher Comparison</h2>
            <p className="text-xs text-text-muted">
              Click any Play Store publisher account to inspect its complete game catalogue below.
              {dateWindow.active ? ` Showing games from: ${dateWindow.label}.` : ""}
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
                className="px-3 py-1 rounded-lg bg-electric-blue/15 text-electric-blue font-semibold hover:bg-electric-blue/25 transition"
              >
                Reset Filters
              </button>
            )}
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Free
            </span>
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" /> Paid
            </span>
          </div>
        </div>

        {visiblePublishers.length === 0 ? (
          <div className="py-8 text-center text-xs text-text-muted flex flex-col items-center gap-2">
            <span>No Play Store publisher accounts in this Competitor List yet.</span>
            {activeListObj && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openListManager(activeListObj)}
                  className="px-3 py-1.5 rounded-xl bg-input-bg border border-border-subtle text-text-main font-semibold"
                >
                  Select Existing Accounts
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScanTargetListIds([activeListObj.id]);
                    setShowScannerModal(true);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-electric-blue text-white font-semibold"
                >
                  Add &amp; Scan New Links
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1">
            {visiblePublishers.map((pub) => {
              const pSt = publisherStatsByName.get(pub.publisher_name) || {
                total: Number(pub.total_games) || 0,
                free: Number(pub.free_games) || 0,
                paid: Number(pub.paid_games) || 0,
                installs: Number(pub.total_installs) || 0,
                dailyDelta: Number(pub.daily_installs_delta) || 0,
                allTimeTotal: Number(pub.total_games) || 0
              };
              const total = pSt.total;
              const free = pSt.free;
              const paid = pSt.paid;
              const freeWidthPct = (free / maxPublisherGames) * 100;
              const paidWidthPct = (paid / maxPublisherGames) * 100;
              const isSelected = selectedPublisher === pub.publisher_name;
              const dispName = getDisplayName(pub.publisher_name);
              const hasCustomName = dispName !== pub.publisher_name;
              const syncMeta = getPublisherSyncState(pub);

              return (
                <div
                  key={pub.id}
                  className={`p-3 rounded-xl border transition ${
                    isSelected
                      ? "border-electric-blue bg-electric-blue/5"
                      : "border-border-subtle bg-input-bg/40 hover:border-border-subtle/80"
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    {/* Account Identity & Status */}
                    <div className="md:w-72 shrink-0 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPublisher(isSelected && selectedPricing === "all" ? "all" : pub.publisher_name);
                          setSelectedPricing("all");
                        }}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="text-xs font-semibold text-text-main hover:text-electric-blue truncate">
                          {dispName}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-text-muted truncate mt-0.5">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full border text-[9px] font-semibold ${syncMeta.dataTone}`}
                            title={syncMeta.warningText || `Last synced: ${syncMeta.lastSyncedText}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${syncMeta.dotTone}`} />
                            {syncMeta.dataLabel}
                          </span>
                          <span>· {syncMeta.lastSyncedText}</span>
                          {syncMeta.hasRefreshWarning && (
                            <span title={syncMeta.warningText} className="text-amber-400 inline-flex items-center">
                              <span className="material-symbols-outlined text-[12px]">info</span>
                            </span>
                          )}
                          {hasCustomName && <span className="truncate">· {pub.publisher_name}</span>}
                        </div>
                      </button>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          disabled={scanStatus.running}
                          onClick={() => handleRescanPublisher(pub)}
                          title={`Scan / Refresh Play Store catalogue for ${dispName}`}
                          className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-emerald-400 transition disabled:opacity-40"
                        >
                          <span className="material-symbols-outlined text-[15px]">refresh</span>
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
                          className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-electric-blue transition disabled:opacity-40"
                        >
                          <span className="material-symbols-outlined text-[15px]">public</span>
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
                          className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-text-main transition"
                        >
                          <span className="material-symbols-outlined text-[15px]">edit</span>
                        </button>
                        {activeListObj && (
                          <button
                            type="button"
                            onClick={() => handleRemoveFromCurrentList(pub.id, activeListObj.id)}
                            title={`Remove "${dispName}" from list "${activeListObj.name}"`}
                            className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-urgent-red transition"
                          >
                            <span className="material-symbols-outlined text-[15px]">folder_off</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Stacked Bar */}
                    <div className="flex-1 flex items-center gap-1.5 h-7 bg-bg-base/60 rounded-lg p-1 overflow-hidden">
                      {total === 0 ? (
                        <span className="text-[10px] text-text-muted px-2">
                          {pSt.allTimeTotal === 0
                            ? "Unscanned — Click refresh icon to fetch full Play Store catalogue"
                            : `No games in selected period (${pSt.allTimeTotal} all-time)`}
                        </span>
                      ) : (
                        <>
                          {free > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPublisher(pub.publisher_name);
                                setSelectedPricing("free");
                              }}
                              style={{ width: `${Math.max(freeWidthPct, 3)}%` }}
                              title={`${dispName}: ${free} Free games (click to filter)`}
                              className="h-full rounded bg-emerald-500 hover:bg-emerald-400 transition flex items-center justify-center text-[10px] font-bold text-slate-950 overflow-hidden whitespace-nowrap px-1 select-none"
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
                              }}
                              style={{ width: `${Math.max(paidWidthPct, 3)}%` }}
                              title={`${dispName}: ${paid} Paid games (click to filter)`}
                              className="h-full rounded bg-amber-500 hover:bg-amber-400 transition flex items-center justify-center text-[10px] font-bold text-slate-950 overflow-hidden whitespace-nowrap px-1 select-none"
                            >
                              {paidWidthPct >= 18 ? `${paid} Paid` : paidWidthPct >= 10 ? `${paid}P` : paidWidthPct >= 5 ? String(paid) : ""}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {/* Compact Metrics */}
                    <div className="md:w-72 shrink-0 flex items-center justify-between md:justify-end gap-3 text-[11px] text-text-muted font-mono">
                      <span>
                        <strong className="text-text-main">{total}</strong>
                        {dateWindow.active ? `/${pSt.allTimeTotal}` : " games"}
                      </span>
                      <span title="Total Real Installs" className="text-emerald-400">
                        {formatCompactNumber(pSt.installs)} inst
                      </span>
                      {pSt.dailyDelta > 0 && (
                        <span title="Daily Install Velocity" className="text-electric-blue">
                          +{formatCompactNumber(pSt.dailyDelta)}/d
                        </span>
                      )}
                      <span>⭐ {pub.avg_rating ? Number(pub.avg_rating).toFixed(1) : "—"}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SELECTED PUBLISHER SUMMARY BAR */}
      {selectedPublisherObj && (
        <div className="bg-electric-blue/10 border border-electric-blue/30 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-main flex flex-wrap items-center gap-2">
              <span>Account: {getDisplayName(selectedPublisherObj.publisher_name)}</span>
              {selectedPublisherObj.display_name && (
                <span className="text-xs text-text-muted">(Play Store: {selectedPublisherObj.publisher_name})</span>
              )}
              <button
                type="button"
                disabled={scanStatus.running}
                onClick={() => handleRescanPublisher(selectedPublisherObj)}
                className="text-xs text-emerald-400 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span> Refresh Catalogue
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
                className="text-xs text-amber-400 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">public</span> Scan Publisher Countries
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
                className="text-xs text-electric-blue hover:underline inline-flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">edit</span> Rename / Lists
              </button>
              <a
                href={selectedPublisherObj.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-electric-blue hover:underline inline-flex items-center gap-1"
              >
                Play Store Page <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
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
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold capitalize ${
                  selectedPricing === mode
                    ? "bg-electric-blue text-white"
                    : "bg-surface-solid text-text-muted border border-border-subtle"
                }`}
              >
                {mode}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSelectedPublisher("all")}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-solid text-text-main border border-border-subtle"
            >
              Show All Accounts
            </button>
          </div>
        </div>
      )}

      {/* GAME DIRECTORY TABLE */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-main">
              Play Store Games ({filteredGames.length.toLocaleString()})
            </h2>
            <p className="text-xs text-text-muted">
              Click any game row to inspect telemetry, refresh install velocity, or view country availability.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedPublisher}
              onChange={(e) => setSelectedPublisher(e.target.value)}
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main"
            >
              <option value="all">All Accounts in View ({visiblePublishers.length})</option>
              {visiblePublishers.map((p) => (
                <option key={p.id} value={p.publisher_name}>
                  {getDisplayName(p.publisher_name)} ({p.total_games})
                </option>
              ))}
            </select>

            <select
              value={selectedPricing}
              onChange={(e) => setSelectedPricing(e.target.value)}
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main"
            >
              <option value="all">All Pricing</option>
              <option value="free">Free Only</option>
              <option value="paid">Paid Only</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main"
            >
              <option value="installs">Sort: Highest Installs</option>
              <option value="delta">Sort: Fastest Daily Velocity</option>
              <option value="release">Sort: Newest Play Launch Date</option>
              <option value="first_seen">Sort: Newly Discovered in Atlas</option>
              <option value="reviews">Sort: Most Reviews</option>
              <option value="rating">Sort: Highest Rating</option>
            </select>

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title, package, publisher..."
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main w-52"
            />
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs text-text-muted">Loading Play Store intelligence dataset...</div>
        ) : (
          <div className="overflow-x-auto border border-border-subtle rounded-xl max-h-[560px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-input-bg text-text-muted uppercase text-[10px] sticky top-0 z-10">
                <tr>
                  <th className="py-3 px-4">Game</th>
                  <th className="py-3 px-3">Account</th>
                  <th className="py-3 px-3 text-right">Real Installs</th>
                  <th className="py-3 px-3 text-right">Daily Velocity</th>
                  <th className="py-3 px-3 text-right">Rating &amp; Reviews</th>
                  <th className="py-3 px-3 text-center">Countries</th>
                  <th className="py-3 px-3 text-right">Launch Date</th>
                  <th className="py-3 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredGames.slice(0, 350).map((g) => {
                  const isRefreshing = refreshingPkg === g.package_name;
                  return (
                    <tr
                      key={`${g.package_name}-${g.publisher_id || g.publisher_name}`}
                      onClick={() => setActiveGameDrawer(g)}
                      className="hover:bg-input-bg/60 cursor-pointer transition"
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
                            <div className="font-semibold text-text-main truncate max-w-xs flex items-center gap-1.5">
                              <span className="truncate">{g.title}</span>
                              {g.pricing === "paid" && (
                                <span className="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-400 text-[9px] font-mono shrink-0">
                                  ${Number(g.price || 0).toFixed(2)}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted">
                              <span className="truncate max-w-[200px]">{g.package_name}</span>
                              {Number(g.shared_publisher_count) > 1 && (
                                <span
                                  className="px-1.5 py-0.2 rounded bg-electric-blue/15 text-electric-blue font-sans font-semibold"
                                  title={`Linked to ${g.shared_publisher_count} accounts: ${(g.shared_publishers || []).join(", ")}`}
                                >
                                  Shared ({g.shared_publisher_count})
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-2.5 px-3 text-text-muted">{getDisplayName(g.publisher_name)}</td>

                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-text-main">
                        {g.real_installs != null
                          ? Number(g.real_installs).toLocaleString()
                          : g.installs || Number(g.min_installs || 0).toLocaleString()}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono">
                        {Number(g.installs_delta_1d) > 0 ? (
                          <span className="text-emerald-400 font-semibold">
                            +{Number(g.installs_delta_1d).toLocaleString()}/d
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono">
                        {g.rating ? `⭐ ${Number(g.rating).toFixed(1)}` : "—"}{" "}
                        <span className="text-text-muted text-[10px]">
                          ({Number(g.review_count || 0).toLocaleString()})
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
                            className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-semibold hover:bg-emerald-500/25"
                          >
                            🌍 {g.country_scan.liveCount}/176
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={countryQueueStatus.running}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartCountryQueue({
                                scope: "single",
                                packageName: g.package_name,
                                skipDays: 0
                              });
                            }}
                            className="px-2 py-0.5 rounded-full bg-input-bg border border-border-subtle text-text-muted hover:text-electric-blue hover:border-electric-blue text-[10px] font-semibold disabled:opacity-40"
                          >
                            Scan Countries
                          </button>
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                        {g.release_date ? String(g.release_date).slice(0, 10) : "Unknown"}
                      </td>

                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          disabled={isRefreshing}
                          onClick={(e) => handleRefreshSingleGame(g.package_name, e)}
                          title="Refresh game installs, velocity & release date"
                          className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-emerald-400 transition disabled:opacity-40"
                        >
                          <span className={`material-symbols-outlined text-[15px] ${isRefreshing ? "animate-spin text-emerald-400" : ""}`}>
                            refresh
                          </span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* PORTAL MODALS & DRAWERS (Rendered at document.body above header z-50) */}
      {/* ===================================================================== */}

      {/* MODAL 1: MANAGE COMPETITOR LISTS (z-[100]) */}
      {listModal &&
        createPortal(
          <div
            onClick={() => setListModal(null)}
            className="atlas-google-shell fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => handleSaveListModal(e, false)}
              className="w-full max-w-lg bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-text-main">Manage Play Store Competitor Lists</h3>
                <button
                  type="button"
                  onClick={() => setListModal(null)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-text-muted">Select List to Edit or Create New</label>
                <select
                  value={listModal.mode === "create" ? "new" : listModal.listId}
                  onChange={(e) => handleSelectListInModal(e.target.value)}
                  className="rounded-xl bg-input-bg border border-border-subtle px-3.5 py-2 text-xs font-semibold text-text-main"
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
                  onChange={(e) => setListModal({ ...listModal, name: e.target.value })}
                  placeholder="e.g. Top Simulation Competitors"
                  className="rounded-xl bg-input-bg border border-border-subtle px-3.5 py-2 text-xs text-text-main"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-text-muted">Notes / Description (Optional)</label>
                <input
                  type="text"
                  value={listModal.description || ""}
                  onChange={(e) => setListModal({ ...listModal, description: e.target.value })}
                  placeholder="Optional notes about this competitor group..."
                  className="rounded-xl bg-input-bg border border-border-subtle px-3.5 py-2 text-xs text-text-main"
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
                      className="text-[11px] text-electric-blue hover:underline"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setListModal({ ...listModal, publisherIds: [] })}
                      className="text-[11px] text-text-muted hover:underline"
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
                              <div className="text-[10px] text-text-muted truncate">Play Store: {p.publisher_name}</div>
                            )}
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-text-muted shrink-0">
                          {p.total_games} games · {formatCompactNumber(p.total_installs)} inst
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-electric-blue/10 border border-electric-blue/25 flex items-center justify-between gap-3">
                <div className="text-xs text-text-main">
                  Want to scan <strong>brand-new Play Store developer links</strong> into this list?
                </div>
                <button
                  type="button"
                  disabled={!listModal.name.trim() || isSavingList}
                  onClick={(e) => handleSaveListModal(e, true)}
                  className="px-3 py-1.5 rounded-lg bg-electric-blue text-white text-xs font-semibold hover:opacity-95 shrink-0 disabled:opacity-50"
                >
                  {listModal.mode === "create" ? "Create List & Add New Links →" : "Save & Add New Links →"}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2">
                {listModal.mode === "edit" ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteList(listModal.listId)}
                    className="px-3.5 py-2 rounded-xl bg-urgent-red/15 text-urgent-red text-xs font-semibold hover:bg-urgent-red/25"
                  >
                    Delete List
                  </button>
                ) : (
                  <div />
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setListModal(null)}
                    className="px-4 py-2 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingList}
                    className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
                  >
                    {isSavingList ? "Saving..." : listModal.mode === "create" ? "Create List" : "Save List"}
                  </button>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* MODAL 2: ADD & SCAN PLAY STORE PUBLISHER LINKS (z-[100]) */}
      {showScannerModal &&
        createPortal(
          <div
            onClick={() => setShowScannerModal(false)}
            className="atlas-google-shell fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-text-main">Add &amp; Scan Play Store Publisher Links</h3>
                  <p className="text-xs text-text-muted">
                    Paste Play Store developer URLs (`/store/apps/developer?id=...` or `/store/apps/dev?id=...`) or publisher names.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowScannerModal(false)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-text-muted">Play Store Developer URLs or Names (one per line)</span>
                <button
                  type="button"
                  onClick={() => {
                    const text = SAMPLE_PLAY_LINKS.join("\n");
                    setLinksInput(text);
                    handleValidateLinks(text);
                  }}
                  className="text-[11px] font-medium text-electric-blue hover:underline"
                >
                  Load Sample Links
                </button>
              </div>

              <textarea
                rows={5}
                value={linksInput}
                onChange={(e) => setLinksInput(e.target.value)}
                placeholder="https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio"
                className="w-full rounded-xl bg-input-bg border border-border-subtle p-3 text-xs font-mono text-text-main focus:outline-none focus:border-electric-blue"
              />

              <div className="bg-input-bg/60 border border-border-subtle rounded-xl p-3.5 flex flex-col gap-3">
                <div className="text-xs font-semibold text-text-main">
                  Assign Scanned Accounts to Competitor List(s)
                </div>
                <div className="flex flex-wrap items-center gap-2 max-h-28 overflow-y-auto">
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
                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-400"
                            : "bg-surface-solid text-text-muted border-border-subtle hover:text-text-main"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {checked ? "check_box" : "check_box_outline_blank"}
                        </span>
                        {list.name}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <span className="text-[11px] text-text-muted shrink-0">Or create &amp; assign to a new list:</span>
                  <input
                    type="text"
                    value={scanNewListName}
                    onChange={(e) => setScanNewListName(e.target.value)}
                    placeholder="e.g. NewCompetitorGroup"
                    className="rounded-lg bg-surface-solid border border-border-subtle px-3 py-1.5 text-xs text-text-main flex-1"
                  />
                </div>
              </div>

              {validationResult && (
                <div className="border border-border-subtle rounded-xl overflow-hidden">
                  <div className="bg-input-bg px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-text-main">
                      Validation: {validationResult.validCount} Valid · {validationResult.duplicateCount} Duplicates ·{" "}
                      {validationResult.invalidCount} Invalid
                    </span>
                    {(validationResult.invalidCount > 0 || validationResult.duplicateCount > 0) && (
                      <button
                        type="button"
                        onClick={handleRemoveInvalidAndDuplicates}
                        className="text-[11px] text-amber-400 font-semibold hover:underline"
                      >
                        Clean Invalid/Duplicates
                      </button>
                    )}
                  </div>
                  <div className="max-h-40 overflow-y-auto divide-y divide-border-subtle text-xs">
                    {validationResult.validation.map((item, idx) => (
                      <div key={idx} className="px-4 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-text-main truncate">
                            {item.valid ? item.publisher : item.raw}
                          </div>
                          <div className="text-[10px] text-text-muted truncate">
                            {item.valid ? item.normalizedUrl : item.reason}
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 border ${
                            !item.valid
                              ? "bg-urgent-red/15 text-urgent-red border-urgent-red/30"
                              : item.duplicate
                              ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                              : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          }`}
                        >
                          {!item.valid ? "Invalid" : item.duplicate ? "Duplicate" : "Valid"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  disabled={!linksInput.trim() || isValidating}
                  onClick={() => handleValidateLinks(linksInput)}
                  className="px-3.5 py-2 rounded-xl bg-input-bg border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue transition disabled:opacity-50"
                >
                  {isValidating ? "Validating..." : "Validate Links"}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowScannerModal(false)}
                    className="px-4 py-2 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!linksInput.trim() || scanStatus.running}
                    onClick={() => handleStartScan()}
                    className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 transition disabled:opacity-50"
                  >
                    {scanStatus.running ? "Scan Running..." : "Validate & Start Scan"}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* MODAL 3: ONE-WAY GOOGLE SHEET IMPORTER (z-[100]) */}
      {showSheetModal &&
        createPortal(
          <div
            onClick={() => setShowSheetModal(false)}
            className="atlas-google-shell fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-text-main">
                    One-Way Google Sheet Importer ("Competitor Analysis")
                  </h3>
                  <p className="text-xs text-text-muted">
                    Import competitor columns and Play Store publisher links from Google Sheets into PostgreSQL.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowSheetModal(false)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {isLoadingSheet ? (
                <div className="py-10 text-center text-xs text-text-muted">
                  Reading "Competitor Analysis" tab from Google Sheets...
                </div>
              ) : sheetPreview ? (
                <>
                  <div className="grid grid-cols-3 gap-2.5 text-center">
                    <div className="bg-input-bg rounded-xl p-3">
                      <div className="text-[10px] text-text-muted">Competitor Columns</div>
                      <div className="text-base font-semibold text-text-main mt-0.5">{sheetPreview.totalColumns}</div>
                    </div>
                    <div className="bg-input-bg rounded-xl p-3">
                      <div className="text-[10px] text-text-muted">Unique Publishers</div>
                      <div className="text-base font-semibold text-text-main mt-0.5">
                        {sheetPreview.uniquePublishersCount}
                      </div>
                    </div>
                    <div className="bg-input-bg rounded-xl p-3">
                      <div className="text-[10px] text-emerald-400">New to Atlas</div>
                      <div className="text-base font-semibold text-emerald-400 mt-0.5">
                        +{sheetPreview.newPublishersCount}
                      </div>
                    </div>
                  </div>

                  <div className="max-h-56 overflow-y-auto border border-border-subtle rounded-xl divide-y divide-border-subtle bg-input-bg/40 text-xs">
                    {(sheetPreview.columns || []).map((col) => {
                      const checked = sheetSelectedLists.includes(col.listName);
                      return (
                        <label
                          key={col.listName}
                          className="px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-input-bg"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSheetSelectedLists((prev) =>
                                  checked ? prev.filter((n) => n !== col.listName) : [...prev, col.listName]
                                )
                              }
                            />
                            <div className="min-w-0">
                              <div className="font-semibold text-text-main truncate">{col.listName}</div>
                              {col.adsId && <div className="text-[10px] font-mono text-text-muted">{col.adsId}</div>}
                            </div>
                          </div>
                          <div className="text-right font-mono text-[11px] shrink-0">
                            <span className="text-text-main">{col.accountCount} accounts</span>
                            {col.newAccountCount > 0 && (
                              <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px]">
                                +{col.newAccountCount} new
                              </span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs text-text-main cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sheetAutoScanNew}
                      onChange={(e) => setSheetAutoScanNew(e.target.checked)}
                    />
                    <span>Immediately scan newly imported Play Store publisher accounts</span>
                  </label>

                  {sheetImportResult && (
                    <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs">
                      Imported {sheetImportResult.publishersCreated} new publisher(s) and added{" "}
                      {sheetImportResult.membershipsAdded} list membership(s).
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowSheetModal(false)}
                      className="px-4 py-2 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      disabled={isImportingSheet || sheetSelectedLists.length === 0}
                      onClick={handleConfirmSheetImport}
                      className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
                    >
                      {isImportingSheet ? "Importing..." : `Import Selected (${sheetSelectedLists.length} Lists)`}
                    </button>
                  </div>
                </>
              ) : (
                <div className="py-8 text-center text-xs text-urgent-red">
                  Could not load Google Sheet preview. Check credentials.
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* MODAL 4: BATCH COUNTRY AVAILABILITY SCANNER (z-[100]) */}
      {showCountryBatchModal &&
        createPortal(
          <div
            onClick={() => setShowCountryBatchModal(false)}
            className="atlas-google-shell fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-text-main">Resumable Batch Country Scanner</h3>
                  <p className="text-xs text-text-muted">
                    Queue 176-country Play Store availability scans in the background with Pause/Resume support.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCountryBatchModal(false)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
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
                    <div className="text-[10px] text-text-muted">
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
                    <div>
                      <div className="font-semibold text-text-main">
                        Active Competitor List: "{activeListObj.name}" ({activeListObj.unique_games} games)
                      </div>
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
                    <div>
                      <div className="font-semibold text-text-main">
                        Active Publisher: "{getDisplayName(selectedPublisherObj.publisher_name)}" (
                        {selectedPublisherObj.total_games} games)
                      </div>
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
                  className="rounded-xl bg-input-bg border border-border-subtle px-3.5 py-2 text-xs text-text-main"
                >
                  <option value={7}>Skip games scanned in last 7 days (Recommended)</option>
                  <option value={14}>Skip games scanned in last 14 days</option>
                  <option value={30}>Skip games scanned in last 30 days</option>
                  <option value={0}>Force re-scan all games in scope (0 days)</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCountryBatchModal(false)}
                  className="px-4 py-2 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={countryQueueStatus.running}
                  onClick={() => handleStartCountryQueue()}
                  className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
                >
                  {countryQueueStatus.running ? "Queue Running..." : "Start Country Batch Queue"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* MODAL 5: RENAME ACCOUNT & ASSIGN LISTS (z-[100]) */}
      {editingPublisher &&
        createPortal(
          <div
            onClick={() => setEditingPublisher(null)}
            className="atlas-google-shell fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleSavePublisherModal}
              className="w-full max-w-md bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-text-main">Rename Account &amp; Lists</h3>
                  <p className="text-[11px] text-text-muted">Play Store Publisher: {editingPublisher.publisher_name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingPublisher(null)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
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
                  className="rounded-xl bg-input-bg border border-border-subtle px-3.5 py-2 text-xs text-text-main"
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

              <div className="flex flex-col gap-2.5 border-t border-border-subtle pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {activeListObj && (editingPublisher.list_ids || []).includes(activeListObj.id) && (
                      <button
                        type="button"
                        onClick={() => handleRemoveFromCurrentList(editingPublisher.id, activeListObj.id)}
                        className="px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] font-semibold hover:bg-amber-500/25"
                      >
                        Remove from "{activeListObj.name}"
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmDeletePub(editingPublisher)}
                      className="px-3 py-1.5 rounded-xl bg-urgent-red/15 border border-urgent-red/30 text-urgent-red text-[11px] font-semibold hover:bg-urgent-red/25"
                    >
                      Delete from Atlas
                    </button>
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      type="button"
                      onClick={() => setEditingPublisher(null)}
                      className="px-4 py-2 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingPublisher}
                      className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
                    >
                      {isSavingPublisher ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* CONFIRMATION DIALOG (z-[110] — sits above all modals & drawers) */}
      {confirmDeletePub &&
        createPortal(
          <div
            onClick={() => setConfirmDeletePub(null)}
            className="atlas-google-shell fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-surface-solid border border-border-subtle rounded-2xl p-6 flex flex-col gap-4 shadow-2xl"
            >
              <h4 className="text-sm font-semibold text-text-main">
                Delete "{getDisplayName(confirmDeletePub.publisher_name)}" from Atlas?
              </h4>
              <p className="text-xs text-text-muted">
                This removes the publisher record from Play Store Intelligence. If you only want to remove it from a Competitor List, uncheck the list instead.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDeletePub(null)}
                  className="px-3.5 py-1.5 rounded-xl bg-input-bg text-text-muted text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => executeDeletePublisherFromAtlas(confirmDeletePub)}
                  className="px-3.5 py-1.5 rounded-xl bg-urgent-red text-white text-xs font-semibold hover:opacity-95"
                >
                  Delete Permanently
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* UNIVERSAL GAME DETAIL DRAWER (z-[90] via Portal — sits cleanly in front of z-50 top header) */}
      {activeGameDrawer && (
        <UniversalGameDetailDrawer
          game={activeGameDrawer}
          onClose={() => setActiveGameDrawer(null)}
          onSelectGame={(sibling) => setActiveGameDrawer(sibling)}
          onRefreshTelemetry={handleRefreshSingleGame}
          isRefreshing={refreshingPkg === activeGameDrawer.package_name}
          onOpenCountryScan={onOpenCountryScan}
          allGames={games}
        />
      )}
    </div>
  );
}
