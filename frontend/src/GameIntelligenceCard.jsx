import { memo } from "react";
import { cn } from "./lib/utils";

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
    return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}K`;
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

export function resolveCardState(game) {
  const latestCreativeSeen = game?.latest_creative_seen || null;
  const adCount = Number(game?.ad_count);
  const nowMs = Date.now();

  // 1. If we have observed ad creatives in the ad library:
  if (latestCreativeSeen) {
    const parsed = new Date(latestCreativeSeen);
    if (!Number.isNaN(parsed.getTime())) {
      const ageMs = nowMs - parsed.getTime();
      if (ageMs <= 14 * 86400000) return "active";
      return "closed";
    }
  }

  // 2. If an ad count is recorded:
  if (Number.isFinite(adCount)) {
    const lastSeen = game?.last_seen_at || game?.card_scanned_at || game?.store_scanned_at;
    if (lastSeen) {
      const parsed = new Date(lastSeen);
      if (!Number.isNaN(parsed.getTime())) {
        const ageMs = nowMs - parsed.getTime();
        if (adCount > 0 && ageMs <= 14 * 86400000) return "active";
        if (adCount > 0 && ageMs > 14 * 86400000) return "closed";
      }
    } else if (adCount > 0) {
      return "active";
    }

    if (adCount === 0 && (game?.account_id || game?.competitor_id || game?.card_scanned_at)) {
      return "closed";
    }
  }

  const rawStatus = String(game?.card_status || "").trim().toLowerCase();
  if (rawStatus === "active" || rawStatus === "open") return "active";
  if (rawStatus === "closed") return "closed";

  return "unscanned";
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
  return [];
}

const GameIntelligenceCard = memo(function GameIntelligenceCard({
  game,
  onClick,
  onDelete,
  onRefreshTelemetry,
  isAdmin = false,
  isScanning = false,
  isRefreshing = false,
  className = "",
}) {
  if (!game) return null;

  const installsTier = game.installs_tier || game.installs || "0+";
  const realInstalls = game.real_installs != null
    ? Number(game.real_installs)
    : Number(game.min_installs || 0);
  const delta1d = Number(game.installs_delta_1d ?? 0);

  const subcategories = normalizeSubcategories(game);
  const cardState = resolveCardState(game);
  const formattedReleaseDate = formatReleaseDate(game.release_date || game.released);

  const developerDisplay =
    game.developer_name || game.publisher_name || "Unknown Developer";
  const advertiserDisplay =
    game.advertiser_legal_name ||
    game.competitor_name ||
    developerDisplay;

  const ratingNum = Number(game.rating);
  const ratingCount = Number(game.ratings_count || game.review_count || 0);

  const adCount = Number(game.ad_count || 0);

  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-surface-solid border border-border-subtle rounded-2xl p-5 shadow-sm flex flex-col justify-between gap-4 transition-all relative group text-left",
        onClick && "cursor-pointer hover:border-electric-blue/40 hover:shadow-md",
        className
      )}
    >
      {/* Top action buttons */}
      {(onRefreshTelemetry || (isAdmin && onDelete)) && (
        <div
          className="absolute top-4 right-4 z-10 flex items-center gap-1.5"
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

      {/* Main card body */}
      <div className="flex flex-col gap-3">
        {/* Header Block: App Icon + Title */}
        <div className="flex items-start gap-3.5 pr-14">
          <div className="w-14 h-14 rounded-2xl bg-input-bg border border-border-subtle overflow-hidden flex items-center justify-center shadow-sm shrink-0">
            {game.icon ? (
              <img
                loading="lazy"
                decoding="async"
                src={game.icon}
                alt={game.title || game.package_name}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="material-symbols-outlined text-text-muted text-[28px]">
                sports_esports
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-text-main text-sm leading-snug truncate group-hover:text-electric-blue transition-colors" title={game.title || game.package_name}>
              {game.title || game.package_name}
            </h3>

            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
                {realInstalls > 0 ? formatCompact(realInstalls) : installsTier} inst
              </span>

              {ratingNum > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-input-bg text-text-main border border-border-subtle">
                  ⭐ {ratingNum.toFixed(1)} {ratingCount > 0 ? `(${formatCompact(ratingCount)})` : ""}
                </span>
              )}

              {game.is_suspended && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-urgent-red/15 text-urgent-red border border-urgent-red/30">
                  Suspended
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Velocity Row (if present) */}
        {delta1d > 0 && (
          <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-electric-blue bg-electric-blue/5 border border-electric-blue/15 px-2.5 py-1 rounded-lg">
            <span>📈</span>
            <span>+{formatCompact(delta1d)} / day daily velocity</span>
          </div>
        )}

        {/* Badges Row: Category + Release Date + Card State */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {subcategories.slice(0, 2).map((sub, idx) => (
            <span
              key={`${sub}-${idx}`}
              className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-input-bg border border-border-subtle text-text-muted"
            >
              {sub}
            </span>
          ))}

          {formattedReleaseDate && (
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/20">
              🚀 {formattedReleaseDate}
            </span>
          )}

          {cardState === "active" ? (
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
              🟢 Card Active {adCount > 0 ? `(${adCount} ads)` : ""}
            </span>
          ) : cardState === "closed" ? (
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
              ⏹ Card Closed
            </span>
          ) : (
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-input-bg text-text-muted border border-border-subtle">
              ⚪ No Active Ads
            </span>
          )}
        </div>
      </div>

      {/* Attribution Block */}
      <div className="pt-2.5 border-t border-border-subtle flex flex-col gap-1 text-[11px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0 text-text-muted">
          <span className="shrink-0">Publisher:</span>
          <span className="font-medium text-text-main truncate text-right">{developerDisplay}</span>
        </div>
        {advertiserDisplay && advertiserDisplay !== developerDisplay && (
          <div className="flex items-baseline justify-between gap-2 min-w-0 text-text-muted">
            <span className="shrink-0">Advertiser:</span>
            <span className="font-semibold text-text-main truncate text-right">{advertiserDisplay}</span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2 min-w-0 text-[10px] text-text-muted font-mono">
          <span className="shrink-0">Package:</span>
          <span className="truncate text-right">{game.package_name}</span>
        </div>
      </div>
    </div>
  );
});

export default GameIntelligenceCard;
