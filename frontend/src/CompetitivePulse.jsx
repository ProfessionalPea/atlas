import { memo, useMemo } from "react";

function formatDelta(value) {
  const amount = Number(value) || 0;
  return amount > 0 ? `+${amount}` : "0";
}

const CompetitivePulse = memo(function CompetitivePulse({ historyData }) {
  const pulse = useMemo(() => {
    const rows = Array.isArray(historyData?.data) ? historyData.data : [];
    const competitors = Array.isArray(historyData?.lines) ? historyData.lines : [];
    const latest = rows.at(-1) || null;
    const previous = rows.length > 1 ? rows.at(-2) : null;

    if (!latest || competitors.length === 0) {
      return {
        ready: false,
        latestLabel: "No snapshot yet",
        newDiscoveries: 0,
        movingCompetitors: 0,
        biggestMover: null,
        competitorCount: competitors.length,
      };
    }

    const changes = competitors.map((name) => {
      const current = Number(latest[name]) || 0;
      const prior = previous ? (Number(previous[name]) || 0) : current;
      return { name, current, delta: current - prior };
    });

    const positiveChanges = changes.filter(item => item.delta > 0);
    const biggestMover = [...positiveChanges].sort((a, b) => b.delta - a.delta)[0] || null;

    return {
      ready: Boolean(previous),
      latestLabel: latest.date || "Latest snapshot",
      newDiscoveries: positiveChanges.reduce((sum, item) => sum + item.delta, 0),
      movingCompetitors: positiveChanges.length,
      biggestMover,
      competitorCount: competitors.length,
    };
  }, [historyData]);

  return (
    <section className="w-full rounded-[24px] border border-border-subtle bg-surface-solid shadow-sm px-4 py-4 md:px-5 md:py-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-[280px]">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-electric-blue text-[20px]">insights</span>
            <h2 className="text-sm md:text-base font-semibold text-text-main tracking-tight">Discovery pulse</h2>
          </div>
          <p className="mt-1 text-[10px] md:text-xs leading-5 text-text-muted">
            {pulse.ready
              ? `What changed since the previous Atlas snapshot · ${pulse.latestLabel}`
              : "Run at least two scans to see meaningful discovery changes."}
          </p>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-2.5 md:grid-cols-3 lg:max-w-[860px]">
          <div className="rounded-2xl border border-border-subtle bg-input-bg/55 px-3.5 py-3">
            <div className="text-[10px] text-text-muted">New discoveries</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-text-main tabular-nums">
              {pulse.ready ? formatDelta(pulse.newDiscoveries) : "—"}
            </div>
            <div className="mt-0.5 text-[9px] text-text-muted">since prior snapshot</div>
          </div>

          <div className="rounded-2xl border border-border-subtle bg-input-bg/55 px-3.5 py-3">
            <div className="text-[10px] text-text-muted">Competitors moving</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-text-main tabular-nums">
              {pulse.ready ? `${pulse.movingCompetitors}/${pulse.competitorCount}` : "—"}
            </div>
            <div className="mt-0.5 text-[9px] text-text-muted">with new games detected</div>
          </div>

          <div className="col-span-2 rounded-2xl border border-border-subtle bg-input-bg/55 px-3.5 py-3 md:col-span-1">
            <div className="text-[10px] text-text-muted">Largest mover</div>
            <div className="mt-1 flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-semibold text-text-main">
                {pulse.ready ? (pulse.biggestMover?.name || "No change") : "—"}
              </span>
              {pulse.biggestMover && (
                <span className="flex-shrink-0 text-[10px] font-semibold text-emerald-metric tabular-nums">
                  +{pulse.biggestMover.delta}
                </span>
              )}
            </div>
            <div className="mt-1 text-[9px] text-text-muted">new games in latest interval</div>
          </div>
        </div>
      </div>
    </section>
  );
});

export default CompetitivePulse;
