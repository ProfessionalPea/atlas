import AtlasIcon from "./AtlasIcon.jsx";

export function Badge({ tone = "neutral", children, className = "", title }) {
  const toneClass = {
    neutral: "atlas-badge-neutral",
    accent: "atlas-badge-accent",
    success: "atlas-badge-success",
    warning: "atlas-badge-warning",
    danger: "atlas-badge-danger"
  }[tone] || "atlas-badge-neutral";

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${toneClass} ${className}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, badge = null, actions = null, className = "" }) {
  return (
    <div className={`flex flex-col md:flex-row md:items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-[-0.02em] text-text-main">
            {title}
          </h1>
          {badge}
        </div>
        {subtitle && (
          <p className="text-[13px] text-text-muted mt-1">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}

export function KpiStrip({ items = [], className = "" }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <div
      className={`bg-surface-solid border border-border-subtle rounded-xl overflow-hidden ${className}`}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border-subtle">
        {items.map((item) => {
          const isInteractive = typeof item.onClick === "function";
          const Tag = isInteractive ? "button" : "div";
          return (
            <Tag
              key={item.key || item.label}
              type={isInteractive ? "button" : undefined}
              onClick={item.onClick}
              className={`px-4 py-3.5 text-left flex flex-col justify-between min-w-0 ${
                isInteractive ? "hover:bg-input-bg/60 transition-colors cursor-pointer" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-muted truncate">
                  {item.label}
                </span>
                {item.badge}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2 min-w-0">
                <span className="text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] text-text-main tabular-nums truncate">
                  {item.value}
                </span>
                {item.suffix && (
                  <span className="text-xs text-text-muted tabular-nums shrink-0">
                    {item.suffix}
                  </span>
                )}
              </div>
              {item.note && (
                <div className={`mt-1 text-xs truncate ${item.noteClass || "text-text-muted"}`}>
                  {item.note}
                </div>
              )}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

export function ScanProgressBanner({
  running = false,
  state = "idle",
  title,
  phase = "",
  meta = null,
  log = "",
  progressPct = 0,
  onCancel = null,
  cancelLabel = "Abort",
  onRetryFailed = null,
  failedCount = 0,
  retryDisabled = false,
  onDismiss = null,
  actionsExtra = null
}) {
  const clampedPct = Math.min(100, Math.max(0, Number(progressPct) || 0));
  const isError = state === "error";

  return (
    <div className="bg-surface-solid border border-border-subtle rounded-xl p-4 flex flex-col gap-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {running ? (
            <span className="mt-1.5 w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" aria-hidden="true" />
          ) : (
            <AtlasIcon
              name={
                isError
                  ? "warning"
                  : state === "paused"
                  ? "pause_circle"
                  : state === "cancelled"
                  ? "stop_circle"
                  : "check_circle"
              }
              size={16}
              className={`mt-0.5 ${
                isError
                  ? "text-sem-danger"
                  : state === "paused"
                  ? "text-sem-warning"
                  : state === "cancelled"
                  ? "text-text-muted"
                  : "text-sem-success"
              }`}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-text-main flex flex-wrap items-center gap-2">
              <span>{title}</span>
              {phase && (
                <Badge tone={isError ? "danger" : running ? "accent" : "neutral"}>
                  {String(phase).replace(/_/g, " ")}
                </Badge>
              )}
              {meta && (
                <span className="text-xs font-mono text-text-muted">{meta}</span>
              )}
            </div>
            {log && (
              <div className="text-xs text-text-muted font-mono truncate mt-1" title={log}>
                {log}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {actionsExtra}
          {!running && failedCount > 0 && typeof onRetryFailed === "function" && (
            <button
              type="button"
              disabled={retryDisabled}
              onClick={onRetryFailed}
              className="h-8 px-3 rounded-lg atlas-badge-warning border text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50"
            >
              <AtlasIcon name="refresh" size={14} />
              Retry Failed ({failedCount})
            </button>
          )}
          {running && typeof onCancel === "function" && (
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 rounded-lg atlas-badge-danger border text-xs font-medium hover:opacity-90"
            >
              {cancelLabel}
            </button>
          )}
          {!running && typeof onDismiss === "function" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss banner"
              className="h-8 w-8 rounded-lg hover:bg-input-bg text-text-muted hover:text-text-main flex items-center justify-center"
            >
              <AtlasIcon name="close" size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="w-full h-1.5 rounded-full bg-input-bg overflow-hidden">
        <div
          style={{ width: `${running || state === "paused" ? clampedPct : 100}%` }}
          className={`h-full transition-all duration-300 ${
            isError
              ? "bg-sem-danger"
              : state === "paused"
              ? "bg-sem-warning"
              : running
              ? "bg-btn-primary"
              : "bg-sem-success"
          }`}
        />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 6 }) {
  return (
    <div className="bg-surface-solid border border-border-subtle rounded-xl overflow-hidden">
      <div className="divide-y divide-border-subtle">
        {Array.from({ length: rows }).map((_, rIdx) => (
          <div key={rIdx} className="px-4 py-3.5 flex items-center gap-4 animate-pulse">
            <div className="w-9 h-9 rounded-lg bg-input-bg shrink-0" />
            <div className="flex-1 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(2, cols - 1)}, minmax(0, 1fr))` }}>
              {Array.from({ length: Math.max(2, cols - 1) }).map((__, cIdx) => (
                <div
                  key={cIdx}
                  className="h-3.5 rounded bg-input-bg"
                  style={{ width: cIdx === 0 ? "78%" : cIdx === 1 ? "62%" : "48%" }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ icon = "search_off", title, description, actions = null }) {
  return (
    <div className="bg-surface-solid border border-border-subtle rounded-xl py-12 px-6 flex flex-col items-center justify-center text-center">
      <div className="w-10 h-10 rounded-lg bg-input-bg border border-border-subtle text-text-muted flex items-center justify-center mb-3">
        <AtlasIcon name={icon} size={18} />
      </div>
      <h3 className="text-sm font-semibold text-text-main">{title}</h3>
      {description && (
        <p className="text-[13px] text-text-muted mt-1 max-w-md">{description}</p>
      )}
      {actions && <div className="mt-4 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
