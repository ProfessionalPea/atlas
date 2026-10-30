import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "./apiConfig";

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
      dataTone: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
      dotTone: "bg-emerald-400",
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
      dataTone: "bg-urgent-red/15 text-urgent-red border-urgent-red/30",
      dotTone: "bg-urgent-red",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Amazon temporarily blocked the scan request."
    };
  }

  if (latestStatus === "error") {
    return {
      dataLabel: "Retry Needed",
      dataTone: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      dotTone: "bg-amber-400",
      lastSyncedText: formatRelativeTime(pub.last_scanned_at),
      hasRefreshWarning: true,
      warningText: pub.last_scan_detail || "Scan did not return listings."
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

export default function AmazonIntelligenceView({ isAdmin = false }) {
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
      unknownGames: 0,
      freeShare: 0,
      totalReviews: 0
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
  const [sortBy, setSortBy] = useState("reviews"); // reviews | price_desc | price_asc | rating | release

  // Launch Duration / Date Filter state
  const [dateBasis, setDateBasis] = useState("release_date"); // "release_date" | "first_seen_at"
  const [durationPreset, setDurationPreset] = useState("all"); // "all" | "30d" | "90d" | "6m" | "1y" | "custom"
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [includeUnknownDates, setIncludeUnknownDates] = useState(false);

  // Drawers & Modals (Layered z-index: Drawer z-[90], Modals z-[100], Confirmations z-[110])
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);
  const [showScannerModal, setShowScannerModal] = useState(false);
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

  const [isSavingList, setIsSavingList] = useState(false);
  const [isSavingPublisher, setIsSavingPublisher] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/overview`);
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
            unknownGames: 0,
            freeShare: 0,
            totalReviews: 0
          },
          lists: data.lists || [],
          publishers: data.publishers || [],
          games: data.games || [],
          snapshots: data.snapshots || []
        });
      }
    } catch (err) {
      console.error("Failed to load Amazon overview:", err);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // Poll scan status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetcher(`${API_BASE}/api/amazon/scan-status`);
        if (res.ok) {
          const st = await res.json();
          setScanStatus((prev) => {
            if (prev.running && !st.running) {
              loadOverview();
            }
            return st;
          });
        }
      } catch {}
    };
    checkStatus();
    const timer = setInterval(checkStatus, 2000);
    return () => clearInterval(timer);
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

  // Keyboard Escape dismissal & body scroll lock when modals/drawer are open
  useEffect(() => {
    const anyOpen = Boolean(activeGameDrawer || showScannerModal || listModal || editingPublisher || confirmDeletePub);
    if (!anyOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (confirmDeletePub) setConfirmDeletePub(null);
        else if (editingPublisher) setEditingPublisher(null);
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
  }, [activeGameDrawer, showScannerModal, listModal, editingPublisher, confirmDeletePub]);

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

    const daysMap = { "30d": 30, "90d": 90, "6m": 182, "1y": 365 };
    const labelsMap = { "30d": "Last 30 Days", "90d": "Last 90 Days", "6m": "Last 6 Months", "1y": "Last 1 Year" };
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
  }, [overview.games, visiblePublisherNames, selectedPublisher, evaluateGameDate]);

  // Per-publisher stats dynamically computed for the active date filter
  const publisherStatsByName = useMemo(() => {
    const map = new Map();
    for (const pub of visiblePublishers) {
      map.set(pub.publisher_name, {
        total: 0,
        free: 0,
        paid: 0,
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
  }, [overview.games, visiblePublisherNames, selectedPublisher, selectedPricing, searchQuery, sortBy, getDisplayName, evaluateGameDate]);

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
      const res = await fetcher(`${API_BASE}/api/amazon/scan`, {
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
      } else if (data?.validation) {
        setValidationResult({
          totalSubmitted: data.validation.length,
          validCount: data.validation.filter((v) => v.valid && !v.duplicate).length,
          duplicateCount: data.validation.filter((v) => v.duplicate).length,
          invalidCount: data.validation.filter((v) => !v.valid).length,
          validation: data.validation
        });
      }
    } catch (err) {
      console.error("Scan start failed:", err);
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
    if (!listModal || !listModal.name.trim()) return;
    setIsSavingList(true);
    try {
      let targetListId = listModal.listId;
      if (listModal.mode === "create") {
        const res = await fetcher(`${API_BASE}/api/amazon/lists`, {
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
        await fetcher(`${API_BASE}/api/amazon/lists/${listModal.listId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: listModal.name.trim(),
            description: listModal.description?.trim() || null
          })
        });
        await fetcher(`${API_BASE}/api/amazon/lists/${listModal.listId}/publishers`, {
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
      const res = await fetcher(`${API_BASE}/api/amazon/lists/${listId}`, { method: "DELETE" });
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
      const res = await fetcher(`${API_BASE}/api/amazon/publishers/${editingPublisher.id}`, {
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
        await loadOverview();
      }
    } catch (err) {
      console.error("Remove from list failed:", err);
    }
  };

  const executeDeletePublisherFromAtlas = async (pub) => {
    if (!pub || !pub.id) return;
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/publishers/${pub.id}`, { method: "DELETE" });
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
      g.url
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-amazon-games.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
    <div className="flex flex-col w-full gap-5">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 px-1">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[11px] font-semibold mb-1.5">
            <span className="material-symbols-outlined text-[15px]">storefront</span>
            Amazon Intelligence
          </div>
          <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">
            Competitor Research &amp; Portfolio Analysis
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
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
            </>
          )}
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

      {/* LIVE PROGRESS BAR & SCAN BANNER */}
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
                      ? "bg-amber-400 animate-pulse"
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
                        : "Amazon Scan Complete"}
                    </span>
                    {scanStatus.phase && scanStatus.running && (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          scanStatus.phase === "retrying"
                            ? "bg-amber-500/20 text-amber-300"
                            : "bg-electric-blue/20 text-electric-blue"
                        }`}
                      >
                        {scanStatus.phase.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-text-muted">
                      · Elapsed: {formatDurationSec(elapsedSec)} · Pages: {scanStatus.totalPagesProcessed || scanStatus.currentPage || 0} · Games Saved: {scanStatus.totalGamesSaved || 0}
                    </span>
                  </div>
                  <div className="text-[11px] text-text-muted font-mono truncate mt-0.5">{scanStatus.log}</div>
                </div>
              </div>

              {isAdmin && (
                <div className="flex items-center gap-2 shrink-0">
                  {!scanStatus.running && Array.isArray(scanStatus.failedLinks) && scanStatus.failedLinks.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleStartScan({ links: scanStatus.failedLinks })}
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
              )}
            </div>

            {/* Visual Progress Bar */}
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

      {/* COMPETITOR LISTS & LAUNCH DATE FILTER BAR */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col gap-3.5 shadow-sm">
        {/* Row 1: Competitor List & Publisher Account Dropdowns */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Competitor List Dropdown */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1">
                <span className="material-symbols-outlined text-[15px]">folder</span>
                Competitor:
              </span>
              <div className="relative">
                <select
                  value={selectedListId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedListId(val === "all" || val === "ungrouped" ? val : Number(val));
                    setSelectedPublisher("all");
                  }}
                  className="h-9 pl-3 pr-8 rounded-xl bg-input-bg border border-border-subtle text-text-main text-xs font-semibold hover:border-amber-400/50 focus:border-amber-400 focus:outline-none transition appearance-none cursor-pointer"
                >
                  <option value="all">All Competitors ({overview.publishers.length} accounts)</option>
                  {(overview.lists || []).map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} ({list.account_count} accounts)
                    </option>
                  ))}
                  {ungroupedCount > 0 && (
                    <option value="ungrouped">Ungrouped Accounts ({ungroupedCount})</option>
                  )}
                </select>
                <span className="material-symbols-outlined text-[16px] text-text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  unfold_more
                </span>
              </div>
            </div>

            {/* Publisher Account Dropdown */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1">
                <span className="material-symbols-outlined text-[15px]">storefront</span>
                Publisher:
              </span>
              <div className="relative">
                <select
                  value={selectedPublisher}
                  onChange={(e) => setSelectedPublisher(e.target.value)}
                  className="h-9 pl-3 pr-8 rounded-xl bg-input-bg border border-border-subtle text-text-main text-xs font-semibold hover:border-amber-400/50 focus:border-amber-400 focus:outline-none transition appearance-none cursor-pointer max-w-[260px] truncate"
                >
                  <option value="all">All Accounts ({visiblePublishers.length})</option>
                  {visiblePublishers.map((pub) => (
                    <option key={pub.id} value={pub.publisher_name}>
                      {getDisplayName(pub.publisher_name)} ({pub.game_count || 0} games)
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined text-[16px] text-text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  unfold_more
                </span>
              </div>
            </div>

            {/* Reset Filters button if any filter active */}
            {(selectedListId !== "all" || selectedPublisher !== "all" || durationPreset !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setSelectedListId("all");
                  setSelectedPublisher("all");
                  setDurationPreset("all");
                }}
                className="h-8 px-2.5 rounded-lg bg-surface-glass border border-border-subtle hover:border-urgent-red/40 text-text-muted hover:text-urgent-red text-xs font-medium transition flex items-center gap-1"
                title="Reset all filters to show everything"
              >
                <span className="material-symbols-outlined text-[14px]">filter_alt_off</span>
                Reset
              </button>
            )}

            {/* Admin Shortcuts: Edit / New list */}
            {isAdmin && (
              <div className="flex items-center gap-1.5 ml-1">
                {activeListObj && (
                  <button
                    type="button"
                    onClick={() => openListManager(activeListObj)}
                    title={`Edit list "${activeListObj.name}"`}
                    className="h-8 px-2.5 rounded-lg bg-input-bg border border-border-subtle hover:border-amber-500/40 text-text-main text-xs font-semibold transition flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-[14px]">edit</span>
                    Edit List
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openListManager(null)}
                  className="h-8 px-2.5 rounded-lg bg-input-bg border border-dashed border-border-subtle text-text-muted hover:text-amber-400 hover:border-amber-400 transition flex items-center gap-1 text-xs font-semibold"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  New List
                </button>
              </div>
            )}
          </div>

          {/* Admin List Quick Action buttons */}
          {isAdmin && activeListObj && (
            <div className="flex items-center gap-2">
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
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-400 text-[11px] font-semibold hover:bg-amber-500/25 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                Re-scan List ({activeListObj.account_count})
              </button>
            </div>
          )}
        </div>

        {/* Row 2: Launch Date / Duration Filter */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-border-subtle">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={dateBasis}
              onChange={(e) => setDateBasis(e.target.value)}
              className="rounded-lg bg-input-bg border border-border-subtle px-2.5 py-1 text-[11px] font-semibold text-text-main"
            >
              <option value="release_date">Filter by: Amazon Launch Date</option>
              <option value="first_seen_at">Filter by: First Discovered in Atlas</option>
            </select>

            {[
              { id: "all", label: "All Time" },
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
              : "Total Unique Games"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.allTimeUnique.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {visiblePublishers.length} account{visiblePublishers.length === 1 ? "" : "s"}
            {scopedStats.totalListings > scopedStats.allTimeUnique
              ? ` · ${scopedStats.totalListings.toLocaleString()} total listings`
              : " · Distinct Amazon ASINs"}
          </div>
        </div>

        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-electric-blue font-medium">
            {dateWindow.active ? `Launched (${dateWindow.label})` : "Games in Selected Period"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.matchingUnique.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {dateWindow.active
              ? `${scopedStats.freeMatching} Free · ${scopedStats.paidMatching} Paid`
              : `All Time (${scopedStats.knownDateCount} with known date)`}
          </div>
        </div>

        <div
          onClick={() => setSelectedPricing(selectedPricing === "free" ? "all" : "free")}
          className={`cursor-pointer bg-surface-solid border rounded-2xl p-4 transition ${
            selectedPricing === "free"
              ? "border-emerald-400 ring-1 ring-emerald-400/40"
              : "border-border-subtle hover:border-emerald-500/40"
          }`}
        >
          <div className="text-[11px] text-emerald-400 font-medium">
            Free Games {dateWindow.active ? `(${dateWindow.label})` : "(Click to filter)"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.freeMatching.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {Math.round((scopedStats.freeShare || 0) * 100)}% of {dateWindow.active ? "period" : "portfolio"}
          </div>
        </div>

        <div
          onClick={() => setSelectedPricing(selectedPricing === "paid" ? "all" : "paid")}
          className={`cursor-pointer bg-surface-solid border rounded-2xl p-4 transition ${
            selectedPricing === "paid"
              ? "border-amber-400 ring-1 ring-amber-400/40"
              : "border-border-subtle hover:border-amber-500/40"
          }`}
        >
          <div className="text-[11px] text-amber-400 font-medium">
            Paid Games {dateWindow.active ? `(${dateWindow.label})` : "(Click to filter)"}
          </div>
          <div className="text-2xl font-semibold text-text-main mt-1">{scopedStats.paidMatching.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {scopedStats.matchingUnique
              ? Math.round((scopedStats.paidMatching / scopedStats.matchingUnique) * 100)
              : 0}
            % of {dateWindow.active ? "period" : "portfolio"}
          </div>
        </div>
      </div>

      {/* PUBLISHER COMPARISON */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-subtle pb-3">
          <div>
            <h2 className="text-base font-semibold text-text-main">Publisher Comparison</h2>
            <p className="text-xs text-text-muted">
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
            <span>No Amazon accounts in this Competitor List yet.</span>
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
          <div className="flex flex-col gap-2">
            {visiblePublishers.map((pub) => {
              const pSt = publisherStatsByName.get(pub.publisher_name) || {
                total: Number(pub.total_games) || 0,
                free: Number(pub.free_games) || 0,
                paid: Number(pub.paid_games) || 0,
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
                    <div className="md:w-64 shrink-0 flex items-center justify-between gap-2">
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
                            <span
                              title={syncMeta.warningText}
                              className="text-amber-400 inline-flex items-center"
                            >
                              <span className="material-symbols-outlined text-[12px]">info</span>
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
                            className="p-1 rounded-lg hover:bg-surface-solid text-text-muted hover:text-amber-400 transition disabled:opacity-40"
                          >
                            <span className="material-symbols-outlined text-[15px]">refresh</span>
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
                      )}
                    </div>

                    {/* Stacked Bar */}
                    <div className="flex-1 flex items-center gap-1.5 h-7 bg-bg-base/60 rounded-lg p-1 overflow-hidden">
                      {total === 0 ? (
                        <span className="text-[10px] text-text-muted px-2">
                          No games in selected period ({pSt.allTimeTotal} all-time)
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
                              title={`${dispName}: ${paid} Paid games · Median $${Number(pub.median_paid_price || 0).toFixed(2)} (click to filter)`}
                              className="h-full rounded bg-amber-500 hover:bg-amber-400 transition flex items-center justify-center text-[10px] font-bold text-slate-950 overflow-hidden whitespace-nowrap px-1 select-none"
                            >
                              {paidWidthPct >= 18 ? `${paid} Paid` : paidWidthPct >= 10 ? `${paid}P` : paidWidthPct >= 5 ? String(paid) : ""}
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {/* Compact Metrics */}
                    <div className="md:w-64 shrink-0 flex items-center justify-between md:justify-end gap-3 text-[11px] text-text-muted font-mono">
                      <span>
                        <strong className="text-text-main">{total}</strong>
                        {dateWindow.active ? `/${pSt.allTimeTotal}` : " total"}
                      </span>
                      <span className="text-emerald-400">{free}F</span>
                      <span className="text-amber-400">{paid}P</span>
                      <span>
                        Med:{" "}
                        <strong className="text-text-main">
                          {pub.median_paid_price ? `$${Number(pub.median_paid_price).toFixed(2)}` : "—"}
                        </strong>
                      </span>
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
                <span className="text-xs text-text-muted">(Amazon: {selectedPublisherObj.publisher_name})</span>
              )}
              {isAdmin && (
                <>
                  <button
                    type="button"
                    disabled={scanStatus.running}
                    onClick={() => handleRescanPublisher(selectedPublisherObj)}
                    className="text-xs text-amber-400 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[14px]">refresh</span> Re-scan
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
                </>
              )}
              <a
                href={selectedPublisherObj.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-electric-blue hover:underline inline-flex items-center gap-1"
              >
                Amazon Store <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
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
              Games ({filteredGames.length.toLocaleString()})
            </h2>
            <p className="text-xs text-text-muted">
              Click any game row to inspect its details and compare free vs. paid sibling titles from that publisher.
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
              <option value="reviews">Sort: Most Reviews</option>
              <option value="price_desc">Sort: Highest Price</option>
              <option value="price_asc">Sort: Lowest Price</option>
              <option value="rating">Sort: Highest Rating</option>
              <option value="release">Sort: Newest Release</option>
            </select>

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title, ASIN, account..."
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main w-48"
            />
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs text-text-muted">Loading Amazon intelligence dataset...</div>
        ) : (
          <div className="overflow-x-auto border border-border-subtle rounded-xl max-h-[540px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-input-bg text-text-muted uppercase text-[10px] sticky top-0 z-10">
                <tr>
                  <th className="py-3 px-4">Game</th>
                  <th className="py-3 px-3">Account</th>
                  <th className="py-3 px-3">Pricing</th>
                  <th className="py-3 px-3 text-right">Price</th>
                  <th className="py-3 px-3 text-right">Rating</th>
                  <th className="py-3 px-3 text-right">Reviews</th>
                  <th className="py-3 px-4 text-right">Launch Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredGames.slice(0, 300).map((g) => (
                  <tr
                    key={`${g.asin}-${g.publisher_id || g.publisher_name}`}
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
                          <div className="font-semibold text-text-main truncate max-w-xs">{g.title}</div>
                          <div className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted">
                            <span>{g.asin}</span>
                            {Number(g.shared_publisher_count) > 1 && (
                              <span
                                className="px-1.5 py-0.2 rounded bg-electric-blue/15 text-electric-blue font-sans font-semibold"
                                title={`Published under ${g.shared_publisher_count} accounts: ${(g.shared_publishers || []).join(", ")}`}
                              >
                                Shared ({g.shared_publisher_count} accounts)
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-text-muted">{getDisplayName(g.publisher_name)}</td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          g.pricing === "free"
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-amber-500/15 text-amber-400"
                        }`}
                      >
                        {g.pricing}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-text-main">
                      {g.pricing === "free" ? "$0.00" : `$${Number(g.price || 0).toFixed(2)}`}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {g.rating ? `⭐ ${Number(g.rating).toFixed(1)}` : "—"}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {g.review_count ? Number(g.review_count).toLocaleString() : "0"}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-text-muted">
                      {g.release_date ? String(g.release_date).slice(0, 10) : "Unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* MODAL 1: MANAGE COMPETITOR LISTS (z-[100])                            */}
      {/* Supports switching between ANY existing list OR creating a new list,  */}
      {/* and links directly to Add & Scan New Accounts into that list.         */}
      {/* ===================================================================== */}
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
                <h3 className="text-base font-semibold text-text-main">Manage Competitor Lists</h3>
                <button
                  type="button"
                  onClick={() => setListModal(null)}
                  className="p-1 rounded-lg hover:bg-input-bg text-text-muted"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {/* Switch between any existing list or "+ Create New List" */}
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
                  placeholder="e.g. Ozi Tech"
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
                              <div className="text-[10px] text-text-muted truncate">Amazon: {p.publisher_name}</div>
                            )}
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-text-muted shrink-0">
                          {p.total_games} games ({p.free_games}F / {p.paid_games}P)
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Direct Link to Add & Scan New Amazon Accounts into this list */}
              <div className="p-3 rounded-xl bg-electric-blue/10 border border-electric-blue/25 flex items-center justify-between gap-3">
                <div className="text-xs text-text-main">
                  Want to scan <strong>brand-new Amazon links</strong> into this list?
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
                    {isSavingList ? "Saving..." : listModal.mode === "create" ? "Create Empty / Selected List" : "Save List"}
                  </button>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* ===================================================================== */}
      {/* MODAL 2: ADD & SCAN AMAZON ACCOUNTS (z-[100])                         */}
      {/* Dedicated flow to paste URLs, validate, pick destination list, & scan */}
      {/* ===================================================================== */}
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
                  <h3 className="text-base font-semibold text-text-main">Add &amp; Scan Amazon Publisher Links</h3>
                  <p className="text-xs text-text-muted">
                    Paste one or more Amazon publisher links, choose a destination list, and scan.
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
                <span className="font-medium text-text-muted">Amazon Appstore Publisher URLs (one per line)</span>
                <button
                  type="button"
                  onClick={() => {
                    const text = SAMPLE_LINKS.join("\n");
                    setLinksInput(text);
                    handleValidateLinks(text);
                  }}
                  className="text-[11px] font-medium text-electric-blue hover:underline"
                >
                  Load 16 Benchmark Links
                </button>
              </div>

              <textarea
                rows={5}
                value={linksInput}
                onChange={(e) => setLinksInput(e.target.value)}
                placeholder="https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BStop%2BStudio&search-type=ss"
                className="w-full rounded-xl bg-input-bg border border-border-subtle p-3 text-xs font-mono text-text-main focus:outline-none focus:border-electric-blue"
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
                            ? "bg-amber-500/20 text-amber-300 border-amber-400"
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
                    placeholder="e.g. Ozi Tech"
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
                    {validationResult.validation.map((item) => (
                      <div key={item.index} className="px-4 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-text-main truncate">
                            {item.valid ? item.publisher : item.input}
                          </div>
                          <div className="text-[10px] text-text-muted truncate">
                            {item.valid ? item.normalizedUrl : item.error}
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

      {/* ===================================================================== */}
      {/* MODAL 3: RENAME ACCOUNT & ASSIGN LISTS (z-[100])                      */}
      {/* ===================================================================== */}
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
                  <p className="text-[11px] text-text-muted">Amazon Brand: {editingPublisher.publisher_name}</p>
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
                  Custom Display Name (Leave blank to use original Amazon name)
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

      {/* ===================================================================== */}
      {/* CONFIRMATION DIALOG (z-[110] — sits above all modals & drawers)       */}
      {/* ===================================================================== */}
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
                This will permanently remove the publisher and its extracted games from Atlas. If you only want to remove it from a Competitor List, uncheck the list instead.
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

      {/* ===================================================================== */}
      {/* GAME & PUBLISHER FUNNEL DETAIL DRAWER (z-[90] — above z-50 header)    */}
      {/* ===================================================================== */}
      {activeGameDrawer &&
        createPortal(
          <div
            onClick={() => setActiveGameDrawer(null)}
            className="atlas-google-shell fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex justify-end"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg bg-surface-solid border-l border-border-subtle h-full overflow-y-auto p-6 flex flex-col gap-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3.5">
                  {activeGameDrawer.icon && (
                    <img
                      src={activeGameDrawer.icon}
                      alt=""
                      className="w-16 h-16 rounded-2xl object-cover border border-border-subtle shrink-0"
                    />
                  )}
                  <div>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                        activeGameDrawer.pricing === "free"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-amber-500/15 text-amber-400"
                      }`}
                    >
                      {activeGameDrawer.pricing === "free"
                        ? "Free User-Acquisition Title"
                        : `Paid Title · $${Number(activeGameDrawer.price || 0).toFixed(2)}`}
                    </span>
                    <h3 className="text-base font-semibold text-text-main mt-1">{activeGameDrawer.title}</h3>
                    <div className="text-xs text-text-muted">{getDisplayName(activeGameDrawer.publisher_name)}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveGameDrawer(null)}
                  className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted shrink-0"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="bg-input-bg rounded-xl p-3">
                  <div className="text-[10px] text-text-muted">ASIN</div>
                  <div className="text-xs font-mono font-semibold text-text-main mt-0.5">{activeGameDrawer.asin}</div>
                </div>
                <div className="bg-input-bg rounded-xl p-3">
                  <div className="text-[10px] text-text-muted">Rating &amp; Reviews</div>
                  <div className="text-xs font-semibold text-text-main mt-0.5">
                    ⭐ {activeGameDrawer.rating ?? "—"} ({Number(activeGameDrawer.review_count || 0).toLocaleString()})
                  </div>
                </div>
                <div className="bg-input-bg rounded-xl p-3">
                  <div className="text-[10px] text-text-muted">Amazon Launch Date</div>
                  <div className="text-xs font-mono font-semibold text-text-main mt-0.5">
                    {activeGameDrawer.release_date ? String(activeGameDrawer.release_date).slice(0, 10) : "Unknown"}
                  </div>
                </div>
              </div>

              <a
                href={activeGameDrawer.url}
                target="_blank"
                rel="noreferrer"
                className="w-full py-2.5 rounded-xl bg-electric-blue text-white text-xs font-semibold text-center hover:opacity-95 transition flex items-center justify-center gap-2"
              >
                Open Listing on Amazon Appstore
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              </a>

              {(() => {
                const siblings = gamesByPublisher.get(activeGameDrawer.publisher_name) || [];
                const paidSiblings = siblings.filter((g) => g.pricing === "paid" && g.asin !== activeGameDrawer.asin);
                const freeSiblings = siblings.filter((g) => g.pricing === "free" && g.asin !== activeGameDrawer.asin);
                const dispPub = getDisplayName(activeGameDrawer.publisher_name);
                return (
                  <div className="flex flex-col gap-4 border-t border-border-subtle pt-4">
                    <div>
                      <h4 className="text-xs font-semibold text-amber-400">
                        {dispPub}’s Paid Titles ({paidSiblings.length})
                      </h4>
                      <p className="text-[11px] text-text-muted mb-2">
                        Candidate paid games potentially promoted by this publisher’s free catalogue:
                      </p>
                      <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                        {paidSiblings.slice(0, 15).map((s) => (
                          <button
                            key={s.asin}
                            type="button"
                            onClick={() => setActiveGameDrawer(s)}
                            className="p-2 rounded-lg bg-input-bg hover:bg-amber-500/10 flex items-center justify-between gap-2 text-left text-xs"
                          >
                            <span className="truncate text-text-main font-medium">{s.title}</span>
                            <span className="font-mono text-amber-400 shrink-0">
                              ${Number(s.price || 0).toFixed(2)} · {s.review_count || 0} rev
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-semibold text-emerald-400">
                        {dispPub}’s Top Free Titles ({freeSiblings.length})
                      </h4>
                      <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto mt-1.5">
                        {freeSiblings.slice(0, 15).map((s) => (
                          <button
                            key={s.asin}
                            type="button"
                            onClick={() => setActiveGameDrawer(s)}
                            className="p-2 rounded-lg bg-input-bg hover:bg-emerald-500/10 flex items-center justify-between gap-2 text-left text-xs"
                          >
                            <span className="truncate text-text-main font-medium">{s.title}</span>
                            <span className="font-mono text-emerald-400 shrink-0">
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
          </div>,
          document.body
        )}
    </div>
  );
}
