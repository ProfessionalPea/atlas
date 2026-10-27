import React, { useState, useEffect, useMemo, useCallback } from "react";
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

function classifyStrategy(pub) {
  const freeShare = Number(pub.free_share ?? 0);
  const medianPaid = Number(pub.median_paid_price ?? 0);
  const paidCount = Number(pub.paid_games ?? 0);
  if (paidCount === 0) return { label: "Free Only", tone: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (freeShare >= 0.55 && medianPaid >= 8) {
    return { label: "High-Ticket Funnel", tone: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  }
  if (freeShare >= 0.5 && medianPaid < 8) {
    return { label: "Volume Funnel", tone: "bg-sky-500/15 text-sky-400 border-sky-500/30" };
  }
  return { label: "Paid-Heavy Catalogue", tone: "bg-purple-500/15 text-purple-400 border-purple-500/30" };
}

export default function AmazonIntelligenceView({ authFetch }) {
  const fetcher = useCallback(
    (url, options = {}) => {
      if (typeof authFetch === "function") return authFetch(url, options);
      return fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
          ...(options.headers || {})
        }
      });
    },
    [authFetch]
  );

  const [overview, setOverview] = useState({
    summary: { publisherCount: 0, totalGames: 0, freeGames: 0, paidGames: 0, unknownGames: 0, freeShare: 0, totalReviews: 0 },
    publishers: [],
    games: [],
    snapshots: []
  });
  const [loading, setLoading] = useState(true);
  const [activeVisual, setActiveVisual] = useState("comparison"); // comparison | treemap | strategy
  const [treemapMetric, setTreemapMetric] = useState("reviews"); // reviews | price | equal

  // Scanner & validation state
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [linksInput, setLinksInput] = useState("");
  const [validationResult, setValidationResult] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [scanStatus, setScanStatus] = useState({ running: false, state: "idle", log: "" });

  // Interactive selection & filters
  const [selectedPublisher, setSelectedPublisher] = useState("all");
  const [selectedPricing, setSelectedPricing] = useState("all"); // all | free | paid
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("reviews"); // reviews | price_desc | price_asc | rating | release
  const [activeGameDrawer, setActiveGameDrawer] = useState(null);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/overview`);
      if (res.ok) {
        const data = await res.json();
        setOverview(data);
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

  // Poll scan status when running
  useEffect(() => {
    let timer;
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
    timer = setInterval(checkStatus, 2200);
    return () => clearInterval(timer);
  }, [fetcher, loadOverview]);

  const handleValidateLinks = async (rawText = linksInput) => {
    setIsValidating(true);
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links: rawText })
      });
      if (res.ok) {
        const data = await res.json();
        setValidationResult(data);
      }
    } catch (err) {
      console.error("Validation error:", err);
    } finally {
      setIsValidating(false);
    }
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

  const handleStartScan = async () => {
    try {
      const res = await fetcher(`${API_BASE}/api/amazon/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links: linksInput })
      });
      const data = await res.json();
      if (res.ok) {
        setValidationResult(null);
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

  const handleCancelScan = async () => {
    try {
      await fetcher(`${API_BASE}/api/amazon/cancel-scan`, { method: "POST" });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  };

  const filteredGames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (overview.games || [])
      .filter((g) => {
        if (selectedPublisher !== "all" && g.publisher_name !== selectedPublisher) return false;
        if (selectedPricing !== "all" && g.pricing !== selectedPricing) return false;
        if (q) {
          const hay = `${g.title || ""} ${g.asin || ""} ${g.publisher_name || ""}`.toLowerCase();
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
  }, [overview.games, selectedPublisher, selectedPricing, searchQuery, sortBy]);

  const gamesByPublisher = useMemo(() => {
    const map = new Map();
    for (const g of overview.games || []) {
      if (!map.has(g.publisher_name)) map.set(g.publisher_name, []);
      map.get(g.publisher_name).push(g);
    }
    return map;
  }, [overview.games]);

  const exportCsv = () => {
    const headers = ["Publisher", "ASIN", "Title", "Pricing", "Price (USD)", "Rating", "Reviews", "Release Date", "URL"];
    const rows = filteredGames.map((g) => [
      `"${String(g.publisher_name || "").replace(/"/g, '""')}"`,
      g.asin,
      `"${String(g.title || "").replace(/"/g, '""')}"`,
      g.pricing,
      g.price ?? 0,
      g.rating ?? "",
      g.review_count ?? 0,
      g.release_date ? String(g.release_date).slice(0, 10) : "",
      g.url
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-amazon-games-${selectedPublisher === "all" ? "all" : selectedPublisher.replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const maxPublisherGames = useMemo(
    () => Math.max(1, ...(overview.publishers || []).map((p) => Number(p.total_games) || 0)),
    [overview.publishers]
  );

  const selectedPublisherObj = useMemo(
    () => (overview.publishers || []).find((p) => p.publisher_name === selectedPublisher) || null,
    [overview.publishers, selectedPublisher]
  );

  return (
    <div className="flex flex-col w-full gap-6">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 px-1">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[11px] font-semibold mb-2">
            <span className="material-symbols-outlined text-[15px]">storefront</span>
            Amazon Appstore Intelligence
          </div>
          <h1 className="text-2xl md:text-3xl text-text-main tracking-tight font-medium">
            Publisher Portfolio & Funnel Explorer
          </h1>
          <p className="text-xs md:text-sm text-text-muted mt-1">
            Analyze how Amazon publishers split their catalogues between free user-acquisition games and paid titles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowScannerModal((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 transition shadow-sm"
          >
            <span className="material-symbols-outlined text-[18px]">radar</span>
            {showScannerModal ? "Hide Link Scanner" : "Scan Amazon Links"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-surface-solid border border-border-subtle text-text-main text-xs font-medium hover:bg-input-bg transition"
          >
            <span className="material-symbols-outlined text-[17px]">download</span>
            Export CSV ({filteredGames.length})
          </button>
        </div>
      </div>

      {/* LIVE SCAN BANNER */}
      {(scanStatus.running || scanStatus.state === "complete" || scanStatus.state === "cancelled" || scanStatus.state === "error") && scanStatus.log && (
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                scanStatus.running
                  ? "bg-amber-400 animate-pulse"
                  : scanStatus.state === "error"
                  ? "bg-urgent-red"
                  : "bg-emerald-metric"
              }`}
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-main">
                {scanStatus.running
                  ? `Scanning ${scanStatus.currentPublisher || "..."} (${scanStatus.publisherIndex}/${scanStatus.totalPublishers})`
                  : scanStatus.state === "cancelled"
                  ? "Scan Aborted (Collected Data Saved)"
                  : scanStatus.state === "error"
                  ? "Scan Stopped"
                  : "Amazon Scan Complete"}
              </div>
              <div className="text-[11px] text-text-muted font-mono truncate">{scanStatus.log}</div>
            </div>
          </div>
          {scanStatus.running && (
            <button
              type="button"
              onClick={handleCancelScan}
              className="px-3.5 py-1.5 rounded-xl bg-urgent-red/15 border border-urgent-red/30 text-urgent-red text-xs font-semibold hover:bg-urgent-red/25 transition shrink-0"
            >
              Abort & Save Collected
            </button>
          )}
        </div>
      )}

      {/* BATCH SCANNER & LINK VALIDATOR DRAWER */}
      {showScannerModal && (
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-text-main">Batch Amazon Store Link Validator & Scanner</h2>
              <p className="text-xs text-text-muted">
                Paste one or more Amazon publisher links (<code className="text-[11px]">https://www.amazon.com/s?i=mobile-apps&amp;rh=p_4:...</code>), validate before scanning, or load the 16 benchmark accounts.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const text = SAMPLE_LINKS.join("\n");
                setLinksInput(text);
                handleValidateLinks(text);
              }}
              className="text-xs font-medium text-electric-blue hover:underline self-start sm:self-auto"
            >
              Load 16 Benchmark Links
            </button>
          </div>

          <textarea
            rows={5}
            value={linksInput}
            onChange={(e) => setLinksInput(e.target.value)}
            placeholder="https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BArk&search-type=ss"
            className="w-full rounded-xl bg-input-bg border border-border-subtle p-3 text-xs font-mono text-text-main focus:outline-none focus:border-electric-blue"
          />

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={!linksInput.trim() || isValidating}
              onClick={() => handleValidateLinks(linksInput)}
              className="px-4 py-2 rounded-xl bg-input-bg border border-border-subtle text-text-main text-xs font-semibold hover:border-electric-blue transition disabled:opacity-50"
            >
              {isValidating ? "Validating..." : "1. Validate & Preview Batch"}
            </button>
            <button
              type="button"
              disabled={!linksInput.trim() || scanStatus.running}
              onClick={handleStartScan}
              className="px-4 py-2 rounded-xl bg-electric-blue text-white text-xs font-semibold hover:opacity-95 transition disabled:opacity-50"
            >
              {scanStatus.running ? "Scan Running..." : "2. Scan Valid Publishers"}
            </button>
            {validationResult && (validationResult.invalidCount > 0 || validationResult.duplicateCount > 0) && (
              <button
                type="button"
                onClick={handleRemoveInvalidAndDuplicates}
                className="px-3.5 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold hover:bg-amber-500/25 transition"
              >
                Remove {validationResult.invalidCount + validationResult.duplicateCount} Invalid / Duplicate Entries
              </button>
            )}
          </div>

          {validationResult && (
            <div className="border border-border-subtle rounded-xl overflow-hidden">
              <div className="bg-input-bg px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-text-main">
                  Batch Validation: {validationResult.validCount} Valid · {validationResult.duplicateCount} Duplicates · {validationResult.invalidCount} Invalid
                </span>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-border-subtle text-xs">
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
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold shrink-0 border ${
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
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-text-muted">Amazon Publishers</div>
          <div className="text-2xl font-semibold text-text-main mt-1">{overview.summary.publisherCount}</div>
          <div className="text-[10px] text-text-muted mt-1">100% verified accounts</div>
        </div>
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4">
          <div className="text-[11px] text-text-muted">Total Unique Games</div>
          <div className="text-2xl font-semibold text-text-main mt-1">{overview.summary.totalGames.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">Distinct Amazon ASINs</div>
        </div>
        <div
          onClick={() => setSelectedPricing(selectedPricing === "free" ? "all" : "free")}
          className={`cursor-pointer bg-surface-solid border rounded-2xl p-4 transition ${
            selectedPricing === "free" ? "border-emerald-400 ring-1 ring-emerald-400/40" : "border-border-subtle hover:border-emerald-500/40"
          }`}
        >
          <div className="text-[11px] text-emerald-400 font-medium">Free Games (Click to filter)</div>
          <div className="text-2xl font-semibold text-text-main mt-1">{overview.summary.freeGames.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {Math.round((overview.summary.freeShare || 0) * 100)}% of total portfolio
          </div>
        </div>
        <div
          onClick={() => setSelectedPricing(selectedPricing === "paid" ? "all" : "paid")}
          className={`cursor-pointer bg-surface-solid border rounded-2xl p-4 transition ${
            selectedPricing === "paid" ? "border-amber-400 ring-1 ring-amber-400/40" : "border-border-subtle hover:border-amber-500/40"
          }`}
        >
          <div className="text-[11px] text-amber-400 font-medium">Paid Games (Click to filter)</div>
          <div className="text-2xl font-semibold text-text-main mt-1">{overview.summary.paidGames.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">
            {overview.summary.totalGames ? Math.round((overview.summary.paidGames / overview.summary.totalGames) * 100) : 0}% of total portfolio
          </div>
        </div>
        <div className="bg-surface-solid border border-border-subtle rounded-2xl p-4 col-span-2 sm:col-span-1">
          <div className="text-[11px] text-text-muted">Total Customer Reviews</div>
          <div className="text-2xl font-semibold text-text-main mt-1">{overview.summary.totalReviews.toLocaleString()}</div>
          <div className="text-[10px] text-text-muted mt-1">Across all scanned titles</div>
        </div>
      </div>

      {/* VISUAL SWITCHER TABS */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border-subtle pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {[
              { id: "comparison", icon: "bar_chart", label: "View A · Publisher Comparison" },
              { id: "treemap", icon: "account_tree", label: "View B · Interactive Portfolio Map" },
              { id: "strategy", icon: "insights", label: "View C · Monetization Funnel Matrix" }
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveVisual(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                  activeVisual === tab.id
                    ? "bg-primary-container text-on-primary-container"
                    : "bg-input-bg text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[17px]">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs">
            {(selectedPublisher !== "all" || selectedPricing !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setSelectedPublisher("all");
                  setSelectedPricing("all");
                }}
                className="px-3 py-1.5 rounded-lg bg-electric-blue/15 text-electric-blue font-semibold hover:bg-electric-blue/25 transition"
              >
                Reset Filter ({selectedPublisher !== "all" ? selectedPublisher : "All"} · {selectedPricing.toUpperCase()})
              </button>
            )}
          </div>
        </div>

        {/* VIEW A: CLICKABLE STACKED BAR COMPARISON */}
        {activeVisual === "comparison" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
              <span>Click any publisher row, Free bar (green), or Paid bar (amber) to inspect those specific games below.</span>
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> Free Games
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-amber-500 inline-block" /> Paid Games
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 mt-1">
              {(overview.publishers || []).map((pub) => {
                const total = Number(pub.total_games) || 0;
                const free = Number(pub.free_games) || 0;
                const paid = Number(pub.paid_games) || 0;
                const freeWidthPct = (free / maxPublisherGames) * 100;
                const paidWidthPct = (paid / maxPublisherGames) * 100;
                const isSelected = selectedPublisher === pub.publisher_name;
                const strat = classifyStrategy(pub);

                return (
                  <div
                    key={pub.id}
                    className={`p-3 rounded-xl border transition ${
                      isSelected
                        ? "border-electric-blue bg-electric-blue/5"
                        : "border-border-subtle bg-input-bg/40 hover:border-border-subtle/80"
                    }`}
                  >
                    <div className="flex flex-col md:flex-row md:items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPublisher(isSelected && selectedPricing === "all" ? "all" : pub.publisher_name);
                          setSelectedPricing("all");
                        }}
                        className="md:w-56 text-left shrink-0 flex items-center justify-between md:justify-start gap-2"
                      >
                        <span className="text-xs font-semibold text-text-main hover:text-electric-blue truncate">
                          {pub.publisher_name}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${strat.tone}`}>
                          {strat.label}
                        </span>
                      </button>

                      <div className="flex-1 flex items-center gap-1.5 h-7 bg-bg-base/60 rounded-lg p-1 overflow-hidden">
                        {free > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedPublisher(pub.publisher_name);
                              setSelectedPricing("free");
                            }}
                            style={{ width: `${Math.max(freeWidthPct, 3)}%` }}
                            title={`${pub.publisher_name}: ${free} Free games (click to filter)`}
                            className="h-full rounded bg-emerald-500 hover:bg-emerald-400 transition flex items-center justify-center text-[10px] font-bold text-slate-950 overflow-hidden"
                          >
                            {free >= 8 ? `${free} Free` : ""}
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
                            title={`${pub.publisher_name}: ${paid} Paid games · Median $${Number(pub.median_paid_price || 0).toFixed(2)} (click to filter)`}
                            className="h-full rounded bg-amber-500 hover:bg-amber-400 transition flex items-center justify-center text-[10px] font-bold text-slate-950 overflow-hidden"
                          >
                            {paid >= 8 ? `${paid} Paid` : ""}
                          </button>
                        )}
                      </div>

                      <div className="md:w-72 shrink-0 flex items-center justify-between md:justify-end gap-3 text-[11px] text-text-muted font-mono">
                        <span>
                          <strong className="text-text-main">{total}</strong> total
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
          </div>
        )}

        {/* VIEW B: INTERACTIVE PORTFOLIO TREEMAP / HIERARCHY EXPLORER */}
        {activeVisual === "treemap" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-text-muted">
              <span>
                Each publisher block splits into <strong className="text-emerald-400">Free</strong> and{" "}
                <strong className="text-amber-400">Paid</strong> game tiles. Click any tile to inspect that game and its publisher funnel.
              </span>
              <div className="flex items-center gap-1.5">
                <span>Tile Size:</span>
                {[
                  { id: "reviews", label: "By Reviews" },
                  { id: "price", label: "By Price" },
                  { id: "equal", label: "Uniform" }
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setTreemapMetric(m.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                      treemapMetric === m.id ? "bg-electric-blue text-white" : "bg-input-bg text-text-muted"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {(overview.publishers || [])
                .filter((p) => selectedPublisher === "all" || p.publisher_name === selectedPublisher)
                .map((pub) => {
                  const pGames = gamesByPublisher.get(pub.publisher_name) || [];
                  const freeList = pGames.filter((g) => g.pricing === "free");
                  const paidList = pGames.filter((g) => g.pricing === "paid");
                  const strat = classifyStrategy(pub);

                  const calcTileSize = (g) => {
                    if (treemapMetric === "equal") return 34;
                    if (treemapMetric === "price") {
                      const pr = Number(g.price) || 0;
                      return pr <= 0 ? 26 : Math.min(68, Math.max(30, 26 + Math.sqrt(pr) * 7));
                    }
                    const rev = Number(g.review_count) || 0;
                    return Math.min(72, Math.max(26, 24 + Math.log10(rev + 1) * 14));
                  };

                  return (
                    <div
                      key={pub.id}
                      className="border border-border-subtle rounded-2xl p-4 bg-input-bg/30 flex flex-col gap-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedPublisher(selectedPublisher === pub.publisher_name ? "all" : pub.publisher_name)
                          }
                          className="text-left group"
                        >
                          <div className="text-sm font-semibold text-text-main group-hover:text-electric-blue">
                            {pub.publisher_name}
                          </div>
                          <div className="text-[11px] text-text-muted">
                            {pub.total_games} games · {pub.free_games} Free ({Math.round((pub.free_share || 0) * 100)}%) ·{" "}
                            {pub.paid_games} Paid (Med ${Number(pub.median_paid_price || 0).toFixed(2)})
                          </div>
                        </button>
                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${strat.tone}`}>
                          {strat.label}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {/* FREE BRANCH */}
                        <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-2.5 flex flex-col gap-2">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-emerald-400">Free Branch ({freeList.length})</span>
                            <span className="text-text-muted">
                              {freeList.reduce((s, g) => s + (Number(g.review_count) || 0), 0).toLocaleString()} reviews
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto pr-1">
                            {freeList.map((g) => {
                              const sz = calcTileSize(g);
                              return (
                                <button
                                  key={g.asin}
                                  type="button"
                                  onClick={() => setActiveGameDrawer(g)}
                                  style={{ width: `${sz}px`, height: `${sz}px` }}
                                  title={`${g.title} (FREE) · ⭐ ${g.rating ?? "—"} · ${g.review_count ?? 0} reviews`}
                                  className="rounded-lg overflow-hidden border border-emerald-500/40 bg-emerald-500/20 hover:scale-105 hover:border-white transition relative group shrink-0"
                                >
                                  {g.icon ? (
                                    <img src={g.icon} alt="" className="w-full h-full object-cover" loading="lazy" />
                                  ) : (
                                    <span className="text-[9px] text-emerald-300 font-bold">FREE</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* PAID BRANCH */}
                        <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-2.5 flex flex-col gap-2">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-amber-400">Paid Branch ({paidList.length})</span>
                            <span className="text-text-muted">
                              {paidList.reduce((s, g) => s + (Number(g.review_count) || 0), 0).toLocaleString()} reviews
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto pr-1">
                            {paidList.map((g) => {
                              const sz = calcTileSize(g);
                              return (
                                <button
                                  key={g.asin}
                                  type="button"
                                  onClick={() => setActiveGameDrawer(g)}
                                  style={{ width: `${sz}px`, height: `${sz}px` }}
                                  title={`${g.title} ($${Number(g.price || 0).toFixed(2)}) · ⭐ ${g.rating ?? "—"} · ${g.review_count ?? 0} reviews`}
                                  className="rounded-lg overflow-hidden border border-amber-500/40 bg-amber-500/20 hover:scale-105 hover:border-white transition relative group shrink-0"
                                >
                                  {g.icon ? (
                                    <img src={g.icon} alt="" className="w-full h-full object-cover" loading="lazy" />
                                  ) : (
                                    <span className="text-[9px] text-amber-300 font-bold">${g.price}</span>
                                  )}
                                  <span className="absolute bottom-0 inset-x-0 bg-black/75 text-[8px] text-amber-300 font-mono text-center leading-tight py-0.5">
                                    ${Number(g.price || 0).toFixed(0)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* VIEW C: MONETIZATION FUNNEL MATRIX & SCATTER */}
        {activeVisual === "strategy" && (
          <div className="flex flex-col gap-5">
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-text-main">
              <strong>Hypothesis Note:</strong> Catalogue split and review distribution reveal where a publisher has a{" "}
              <em>free user-acquisition funnel alongside high-margin paid titles</em>, though proving in-app cross-promotion requires inspecting the free apps directly.
            </div>

            {/* SCATTER PLOT: X = Free Share %, Y = Median Paid Price ($), Bubble Size = Paid Reviews */}
            <div className="border border-border-subtle rounded-2xl p-4 bg-input-bg/30">
              <div className="text-xs font-semibold text-text-main mb-1">
                Portfolio Strategy Map (X: Free Portfolio % · Y: Median Paid Price $ · Bubble Size: Reviews on Paid Games)
              </div>
              <div className="text-[11px] text-text-muted mb-3">
                Top-right quadrant = High-Ticket Funnel publishers (large free catalogue + high paid prices). Click any bubble to inspect.
              </div>
              <div className="relative h-64 w-full bg-bg-base/70 rounded-xl border border-border-subtle overflow-hidden">
                {/* Quadrant lines */}
                <div className="absolute left-1/2 top-0 bottom-0 border-l border-dashed border-border-subtle" />
                <div className="absolute top-1/2 left-0 right-0 border-t border-dashed border-border-subtle" />
                <span className="absolute top-2 right-3 text-[10px] text-amber-400/80 font-semibold">
                  High-Ticket Funnel (Many Free + High Paid Price)
                </span>
                <span className="absolute bottom-2 right-3 text-[10px] text-sky-400/80 font-semibold">
                  Volume Funnel (Many Free + Low Paid Price)
                </span>
                <span className="absolute top-2 left-3 text-[10px] text-purple-400/80 font-semibold">
                  Paid-Heavy Catalogue (Mostly Paid Titles)
                </span>

                {(overview.publishers || []).map((pub) => {
                  const xPct = Math.min(94, Math.max(6, (Number(pub.free_share) || 0) * 100));
                  const maxPrice = 30;
                  const yPct = Math.min(92, Math.max(8, ((Number(pub.median_paid_price) || 0) / maxPrice) * 100));
                  const paidReviews = Math.round(
                    (Number(pub.total_reviews) || 0) * (1 - (Number(pub.free_review_share) || 0))
                  );
                  const size = Math.min(44, Math.max(18, 14 + Math.log10(paidReviews + 1) * 8));

                  return (
                    <button
                      key={pub.id}
                      type="button"
                      onClick={() => setSelectedPublisher(pub.publisher_name)}
                      style={{
                        left: `${xPct}%`,
                        bottom: `${yPct}%`,
                        width: `${size}px`,
                        height: `${size}px`,
                        transform: "translate(-50%, 50%)"
                      }}
                      title={`${pub.publisher_name} · ${Math.round((pub.free_share || 0) * 100)}% Free · Median Paid $${Number(
                        pub.median_paid_price || 0
                      ).toFixed(2)} · ${paidReviews.toLocaleString()} Paid Reviews`}
                      className={`absolute rounded-full border-2 flex items-center justify-center text-[9px] font-bold transition hover:scale-125 hover:z-20 ${
                        selectedPublisher === pub.publisher_name
                          ? "bg-electric-blue text-white border-white z-10"
                          : "bg-amber-500/80 text-slate-950 border-amber-200"
                      }`}
                    >
                      {pub.publisher_name.slice(0, 2).toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* STRATEGY COMPARISON TABLE */}
            <div className="overflow-x-auto border border-border-subtle rounded-2xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-input-bg text-text-muted uppercase text-[10px]">
                  <tr>
                    <th className="py-3 px-4">Publisher</th>
                    <th className="py-3 px-3">Model Pattern</th>
                    <th className="py-3 px-3 text-right">Total</th>
                    <th className="py-3 px-3 text-right">Free / Paid</th>
                    <th className="py-3 px-3 text-right">Free:Paid Ratio</th>
                    <th className="py-3 px-3 text-right">Median Paid $</th>
                    <th className="py-3 px-3 text-right">Avg Rating</th>
                    <th className="py-3 px-3 text-right">Free Review %</th>
                    <th className="py-3 px-4 text-right">Paid Game Reviews</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {(overview.publishers || []).map((pub) => {
                    const strat = classifyStrategy(pub);
                    const paidReviews = Math.round(
                      (Number(pub.total_reviews) || 0) * (1 - (Number(pub.free_review_share) || 0))
                    );
                    return (
                      <tr
                        key={pub.id}
                        onClick={() => setSelectedPublisher(pub.publisher_name)}
                        className="hover:bg-input-bg/60 cursor-pointer transition"
                      >
                        <td className="py-2.5 px-4 font-semibold text-text-main">{pub.publisher_name}</td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${strat.tone}`}>
                            {strat.label}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">{pub.total_games}</td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          <span className="text-emerald-400">{pub.free_games}F</span> /{" "}
                          <span className="text-amber-400">{pub.paid_games}P</span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {pub.free_to_paid_ratio ? `${Number(pub.free_to_paid_ratio).toFixed(2)}:1` : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-amber-400 font-semibold">
                          {pub.median_paid_price ? `$${Number(pub.median_paid_price).toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {pub.avg_rating ? Number(pub.avg_rating).toFixed(2) : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {pub.free_review_share !== null && pub.free_review_share !== undefined
                            ? `${Math.round(Number(pub.free_review_share) * 100)}%`
                            : "—"}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-text-main">
                          {paidReviews.toLocaleString()}
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

      {/* SELECTED PUBLISHER SUMMARY BAR */}
      {selectedPublisherObj && (
        <div className="bg-electric-blue/10 border border-electric-blue/30 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-main flex items-center gap-2">
              <span>Inspecting: {selectedPublisherObj.publisher_name}</span>
              <a
                href={selectedPublisherObj.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-electric-blue hover:underline inline-flex items-center gap-1"
              >
                Open on Amazon <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {selectedPublisherObj.total_games} total games · {selectedPublisherObj.free_games} Free ·{" "}
              {selectedPublisherObj.paid_games} Paid (Median $
              {Number(selectedPublisherObj.median_paid_price || 0).toFixed(2)}) ·{" "}
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
          </div>
        </div>
      )}

      {/* GAME DIRECTORY TABLE */}
      <div className="bg-surface-solid border border-border-subtle rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-main">
              Extracted Amazon Appstore Listings ({filteredGames.length.toLocaleString()})
            </h2>
            <p className="text-xs text-text-muted">
              Click any game row to open its full metadata and compare free vs. paid sibling titles from the same publisher.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedPublisher}
              onChange={(e) => setSelectedPublisher(e.target.value)}
              className="rounded-xl bg-input-bg border border-border-subtle px-3 py-2 text-xs text-text-main"
            >
              <option value="all">All Publishers ({overview.publishers.length})</option>
              {(overview.publishers || []).map((p) => (
                <option key={p.id} value={p.publisher_name}>
                  {p.publisher_name} ({p.total_games})
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
              placeholder="Search title or ASIN..."
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
                  <th className="py-3 px-3">Publisher</th>
                  <th className="py-3 px-3">Pricing</th>
                  <th className="py-3 px-3 text-right">Price</th>
                  <th className="py-3 px-3 text-right">Rating</th>
                  <th className="py-3 px-3 text-right">Reviews</th>
                  <th className="py-3 px-4 text-right">Release Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredGames.slice(0, 300).map((g) => (
                  <tr
                    key={g.asin}
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
                          <div className="text-[10px] font-mono text-text-muted">{g.asin}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-text-muted">{g.publisher_name}</td>
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
                      {g.release_date ? String(g.release_date).slice(0, 10) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* GAME & PUBLISHER FUNNEL DETAIL DRAWER */}
      {activeGameDrawer && (
        <div
          onClick={() => setActiveGameDrawer(null)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end"
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
                    className="w-16 h-16 rounded-2xl object-cover border border-border-subtle"
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
                  <div className="text-xs text-text-muted">{activeGameDrawer.publisher_name}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveGameDrawer(null)}
                className="p-1.5 rounded-lg hover:bg-input-bg text-text-muted"
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
                <div className="text-[10px] text-text-muted">Rating & Reviews</div>
                <div className="text-xs font-semibold text-text-main mt-0.5">
                  ⭐ {activeGameDrawer.rating ?? "—"} ({Number(activeGameDrawer.review_count || 0).toLocaleString()})
                </div>
              </div>
              <div className="bg-input-bg rounded-xl p-3">
                <div className="text-[10px] text-text-muted">Release Date</div>
                <div className="text-xs font-mono font-semibold text-text-main mt-0.5">
                  {activeGameDrawer.release_date ? String(activeGameDrawer.release_date).slice(0, 10) : "—"}
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

            {/* SIBLING FUNNEL COMPARISON */}
            {(() => {
              const siblings = gamesByPublisher.get(activeGameDrawer.publisher_name) || [];
              const paidSiblings = siblings.filter((g) => g.pricing === "paid" && g.asin !== activeGameDrawer.asin);
              const freeSiblings = siblings.filter((g) => g.pricing === "free" && g.asin !== activeGameDrawer.asin);
              return (
                <div className="flex flex-col gap-4 border-t border-border-subtle pt-4">
                  <div>
                    <h4 className="text-xs font-semibold text-amber-400">
                      {activeGameDrawer.publisher_name}’s Paid Titles ({paidSiblings.length})
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
                      {activeGameDrawer.publisher_name}’s Top Free Titles ({freeSiblings.length})
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
        </div>
      )}
    </div>
  );
}
