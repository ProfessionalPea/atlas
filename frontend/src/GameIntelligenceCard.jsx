import { memo } from "react";
import { cn } from "./lib/utils";

const NETWORK_COLOR_MAP = {
  Admob: "#3b82f6",
  AppLovin: "#6366f1",
  "Unity Ads": "#10b981",
  ironSource: "#f59e0b",
  Meta: "#0ea5e9",
  Liftoff: "#ec4899",
  Mintegral: "#8b5cf6",
  Chartboost: "#14b8a6",
  Pangle: "#f97316",
};

export function formatCompact(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 1_000_000_000) {
    const v = num / 1_000_000_000;
    return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}B`;
  }
  if (num >= 1_000_000) {
    const v = num / 1_000_000;
    return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}M`;
  }
  if (num >= 1_000) {
    const v = num / 1_000;
    return `${v >= 100 ? Number(v.toFixed(1)) : Number(v.toFixed(1))}K`;
  }
  return String(Math.round(num));
}

export function formatReleaseDate(value) {
  if (!value || value === "Unknown") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00Z`)
    : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatShortScanDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
  });
}

export function isTimestampStale(value, maxDays = 14) {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const ageMs = Date.now() - parsed.getTime();
  return ageMs > maxDays * 86400000;
}

function normalizeSubcategories(game) {
  let subs = game?.subcategories;
  if (typeof subs === "string") {
    try {
      subs = JSON.parse(subs);
    } catch {
      subs = [];
    }
  }
  if (Array.isArray(subs) && subs.length > 0) {
    return subs.filter(Boolean).map(String);
  }
  if (game?.category) {
    return [String(game.category)];
  }
  return ["Simulation"];
}

function normalizeAdNetworks(game) {
  let net = game?.ad_networks;
  if (typeof net === "string") {
    try {
      net = JSON.parse(net);
    } catch {
      net = {};
    }
  }
  if (net && typeof net === "object" && !Array.isArray(net) && Object.keys(net).length > 0) {
    return net;
  }
  return { Admob: 100 };
}

function normalizeInstallHistory(game) {
  let hist = game?.install_history;
  if (typeof hist === "string") {
    try {
      hist = JSON.parse(hist);
    } catch {
      hist = [];
    }
  }
  if (Array.isArray(hist) && hist.length >= 2) {
    return hist
      .map((item) => ({
        date: item?.date || item?.snapshot_date || "",
        value: Number(item?.realInstalls ?? item?.real_installs ?? item?.dailyDelta ?? 0),
      }))
      .filter((pt) => Number.isFinite(pt.value));
  }

  // Fallback synthetic 7-point trajectory from real_installs and installs_total_7d
  const realInstalls = Number(game?.real_installs ?? game?.min_installs ?? 0);
  const total7d = Number(game?.installs_total_7d ?? 0);
  if (realInstalls > 0) {
    const start = Math.max(0, realInstalls - (total7d > 0 ? total7d : Math.round(realInstalls * 0.15)));
    const diff = realInstalls - start;
    const weights = [0, 0.12, 0.26, 0.42, 0.6, 0.79, 1.0];
    return weights.map((w, idx) => ({
      date: `d-${6 - idx}`,
      value: Math.round(start + diff * w),
    }));
  }

  return [];
}

function SparklineChart({ points = [] }) {
  const width = 260;
  const height = 42;
  const padX = 6;
  const padY = 6;

  if (!Array.isArray(points) || points.length < 2) {
    return (
      <div className="w-full h-[42px] flex items-center">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[42px] overflow-visible">
          <polyline
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinecap="round"
            points={`${padX},${height / 2} ${width - padX},${height / 2}`}
          />
          <circle cx={width - padX} cy={height / 2} r="3.5" fill="#64748b" />
        </svg>
      </div>
    );
  }

  const values = points.map((p) => Number(p.value) || 0);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal || 1;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const coords = values.map((v, idx) => {
    const x = padX + (idx / (values.length - 1)) * innerW;
    const y = padY + innerH - ((v - minVal) / span) * innerH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const polylineStr = coords.map(([x, y]) => `${x},${y}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <div className="w-full py-1">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-[42px] overflow-visible"
        role="img"
        aria-label="7 to 14 day install trajectory sparkline"
      >
        <polyline
          fill="none"
          stroke="#94a3b8"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polylineStr}
        />
        <circle cx={lastX} cy={lastY} r="3.8" fill="#64748b" />
      </svg>
    </div>
  );
}

const GameIntelligenceCard = memo(function GameIntelligenceCard({
  game,
  onClick,
  onDelete,
  onRefreshTelemetry,
  isAdmin = false,
  isScanning = false,
  isRefreshing = false,
  inDrawer = false,
  className = "",
}) {
  if (!game) return null;

  const installsTier = game.installs_tier || game.installs || "0+";
  const avgDaily7d = Number(game.installs_avg_daily_7d ?? 0);
  const total7d = Number(game.installs_total_7d ?? 0);
  const delta1d = Number(game.installs_delta_1d ?? 0);

  const estimatedDau = Number(game.estimated_dau ?? 0);
  const retentionD1 = Number(game.retention_d1 ?? 23);
  const retentionD7 = Number(game.retention_d7 ?? 4);
  const avgSessionMinutes = Number(game.avg_session_minutes ?? 10);
  const revMin = Number(game.rev_monthly_min ?? 0);
  const revMax = Number(game.rev_monthly_max ?? 0);
  const revConfidence = game.rev_confidence || "low";

  const subcategories = normalizeSubcategories(game);
  const cardStatus = (game.card_status || "closed").toLowerCase();
  const formattedReleaseDate = formatReleaseDate(game.release_date || game.released);

  const adNetworks = normalizeAdNetworks(game);
  const networkEntries = Object.entries(adNetworks)
    .map(([name, pct]) => [name, Number(pct) || 0])
    .filter(([, pct]) => pct > 0)
    .sort((a, b) => b[1] - a[1]);

  const topNetworkLabel = networkEntries
    .map(([name, pct]) => `${name} · ${Math.round(pct)}%`)
    .join("  ");

  const developerDisplay =
    game.developer_name || game.publisher_name || "Unknown Developer";
  const advertiserDisplay =
    game.advertiser_legal_name ||
    game.competitor_name ||
    developerDisplay.toUpperCase();

  const sparklinePoints = normalizeInstallHistory(game);

  const freshnessItems = [
    { key: "store", label: "Store", ts: game.store_scanned_at },
    { key: "installs", label: "Installs", ts: game.installs_scanned_at },
    { key: "networks", label: "Networks", ts: game.networks_scanned_at },
    { key: "card", label: "Card", ts: game.card_scanned_at },
  ];

  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-surface-solid border border-border-subtle rounded-[22px] p-5 shadow-sm flex flex-col gap-3.5 transition-all relative group text-left",
        onClick && "cursor-pointer hover:border-electric-blue/35 hover:shadow-md",
        className
      )}
    >
      {/* Top-right admin / refresh controls */}
      {(onRefreshTelemetry || (isAdmin && onDelete)) && (
        <div
          className="absolute top-4 right-4 z-20 flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {onRefreshTelemetry && (
            <button
              type="button"
              onClick={() => onRefreshTelemetry(game)}
              disabled={isRefreshing}
              title="Refresh live Play Store telemetry"
              className="w-8 h-8 rounded-lg bg-input-bg/90 border border-border-subtle text-text-muted hover:text-electric-blue hover:border-electric-blue/30 transition-colors flex items-center justify-center disabled:opacity-40"
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[16px]",
                  isRefreshing && "animate-spin text-electric-blue"
                )}
              >
                sync
              </span>
            </button>
          )}
          {isAdmin && onDelete && (
            <button
              type="button"
              onClick={(e) => onDelete(e, game)}
              disabled={isScanning}
              title={isScanning ? "Wait for active scan to finish" : "Delete game from Atlas"}
              className="w-8 h-8 rounded-lg bg-input-bg/90 border border-border-subtle text-text-muted hover:text-urgent-red hover:border-urgent-red/30 hover:bg-urgent-red/10 transition-colors flex items-center justify-center disabled:opacity-30"
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
            </button>
          )}
        </div>
      )}

      {/* 1. Header Block: Rounded App Icon at top, Bold Title, Green Milestone Install Badge */}
      <div className="flex flex-col items-start gap-2.5">
        <div className="w-16 h-16 rounded-2xl bg-input-bg border border-border-subtle overflow-hidden flex items-center justify-center shadow-sm flex-shrink-0">
          {game.icon ? (
            <img
              loading="lazy"
              decoding="async"
              src={game.icon}
              alt={game.title || game.package_name}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="material-symbols-outlined text-text-muted text-[30px]">
              sports_esports
            </span>
          )}
        </div>

        <div className="w-full min-w-0 pr-8">
          <h3
            className={cn(
              "font-bold text-text-main leading-snug truncate",
              inDrawer ? "text-lg" : "text-base group-hover:text-electric-blue transition-colors"
            )}
          >
            {game.title || game.package_name}
          </h3>

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
              {installsTier}
            </span>
            {game.is_suspended && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-urgent-red/15 text-urgent-red border border-urgent-red/30">
                Suspended
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Install Velocity Block */}
      <div className="flex flex-col gap-0.5">
        <div className="text-xs md:text-[13px] font-bold text-blue-600 dark:text-blue-400 tracking-tight">
          📈 {formatCompact(avgDaily7d)} / day · {formatCompact(total7d)} / week
        </div>
        <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Play Δ: {formatCompact(delta1d)}/d
        </div>
      </div>

      {/* 3. Engagement & Revenue Block */}
      <div className="flex flex-col gap-1">
        <div className="text-xs md:text-[13px] font-bold text-purple-600 dark:text-purple-400 tracking-tight">
          🎮 DAU {formatCompact(estimatedDau)} · D1 {Math.round(retentionD1)}% · D7 {Math.round(retentionD7)}% · {Math.round(avgSessionMinutes)}m/day
        </div>
        <div className="text-xs md:text-[13px] font-bold text-emerald-600 dark:text-emerald-400 tracking-tight">
          💰 SS rev: ${Math.round(revMin)}–${Math.round(revMax)}/mo{" "}
          <span className="font-semibold opacity-85">~{revConfidence} conf</span>
        </div>
      </div>

      {/* 4. Sparkline Chart */}
      <SparklineChart points={sparklinePoints} />

      {/* 5. Pills & Status Badges */}
      <div className="flex flex-col gap-2">
        {/* Row 1: Genre / Subcategory pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {subcategories.map((sub, idx) => (
            <span
              key={`${sub}-${idx}`}
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[11px] font-semibold border",
                idx === 0
                  ? "bg-sky-500/12 text-sky-700 dark:text-sky-300 border-sky-500/25"
                  : "bg-purple-500/12 text-purple-700 dark:text-purple-300 border-purple-500/25"
              )}
            >
              {sub}
            </span>
          ))}
        </div>

        {/* Row 2: Card status pill + Release date pill */}
        <div className="flex flex-wrap items-center gap-1.5">
          {cardStatus === "open" ? (
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
              ✅ Card Open
            </span>
          ) : (
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
              ⏹ Card Closed
            </span>
          )}

          {formattedReleaseDate && (
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-500/12 text-purple-700 dark:text-purple-300 border border-purple-500/25">
              🚀 {formattedReleaseDate}
            </span>
          )}
        </div>
      </div>

      {/* 6. Ad Network Bar */}
      <div className="flex flex-col gap-1.5 pt-0.5">
        <div className="text-[11px] font-bold text-text-main flex items-center justify-between">
          <span>{topNetworkLabel || "Admob · 100%"}</span>
        </div>
        <div className="w-full h-2 rounded-full bg-input-bg overflow-hidden flex">
          {networkEntries.map(([name, pct]) => (
            <div
              key={name}
              style={{
                width: `${Math.max(2, Math.min(100, pct))}%`,
                backgroundColor: NETWORK_COLOR_MAP[name] || "#3b82f6",
              }}
              className="h-full transition-all"
              title={`${name}: ${Math.round(pct)}%`}
            />
          ))}
        </div>
      </div>

      {/* 7. Attribution Details */}
      <div className="flex flex-col gap-1 text-[11px] pt-1 border-t border-border-subtle/60">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-text-muted font-medium flex-shrink-0">Package:</span>
          <span className="font-mono text-text-main truncate">{game.package_name}</span>
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-text-muted font-medium flex-shrink-0">Developer:</span>
          <span className="text-text-main font-medium truncate">{developerDisplay}</span>
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-text-muted font-medium flex-shrink-0">Advertiser:</span>
          <span className="text-text-main font-semibold truncate">{advertiserDisplay}</span>
        </div>
      </div>

      {/* 8. Footer Freshness Bar with Stale Warning Highlight */}
      <div className="pt-2 border-t border-border-subtle/50 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-text-muted">
        <span>🕒</span>
        {freshnessItems.map((item, idx) => {
          const stale = isTimestampStale(item.ts, 14);
          const dateText = formatShortScanDate(item.ts);
          return (
            <span key={item.key} className="inline-flex items-center gap-1">
              {idx > 0 && <span className="opacity-50">·</span>}
              {stale ? (
                <span className="px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 font-semibold inline-flex items-center gap-0.5">
                  ⚠️ {item.label}: {dateText}
                </span>
              ) : (
                <span>
                  {item.label}: {dateText}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
});

export default GameIntelligenceCard;
