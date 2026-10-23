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
    <section className="atlas-discovery-pulse w-full rounded-[24px] border border-border-subtle bg-surface-solid p-3.5 shadow-sm md:p-4">
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-12">
        <div className="atlas-pulse-intro rounded-2xl border border-border-subtle bg-input-bg/55 p-4 md:p-5 lg:col-span-4">
          <div className="flex h-full min-h-[108px] flex-col justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-electric-blue/10 text-electric-blue">
                  <span className="material-symbols-outlined text-[19px]">insights</span>
                </span>
                <div>
                  <h2 className="text-sm font-semibold tracking-tight text-text-main md:text-base">Discovery pulse</h2>
                  <p className="mt-0.5 text-[10px] text-text-muted">Competitive movement at a glance</p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-[10px] leading-5 text-text-muted md:text-[11px]">
              {pulse.ready
                ? `Changes since the previous Atlas snapshot · ${pulse.latestLabel}`
                : "Run at least two scans to see meaningful discovery changes."}
            </p>
          </div>
        </div>

        <div className="atlas-pulse-tile rounded-2xl border border-border-subtle bg-input-bg/55 p-4 lg:col-span-2" data-tone="positive">
          <div className="flex h-full min-h-[108px] flex-col justify-between">
            <div className="text-[10px] font-medium text-text-muted">New discoveries</div>
            <div>
              <div className="text-[28px] font-semibold tracking-[-0.03em] text-text-main tabular-nums">
                {pulse.ready ? formatDelta(pulse.newDiscoveries) : "—"}
              </div>
              <div className="mt-1 text-[9px] text-text-muted">since prior snapshot</div>
            </div>
          </div>
        </div>

        <div className="atlas-pulse-tile rounded-2xl border border-border-subtle bg-input-bg/55 p-4 lg:col-span-3">
          <div className="flex h-full min-h-[108px] flex-col justify-between">
            <div className="text-[10px] font-medium text-text-muted">Competitors moving</div>
            <div>
              <div className="text-[28px] font-semibold tracking-[-0.03em] text-text-main tabular-nums">
                {pulse.ready ? `${pulse.movingCompetitors}/${pulse.competitorCount}` : "—"}
              </div>
              <div className="mt-1 text-[9px] text-text-muted">with new games detected</div>
            </div>
          </div>
        </div>

        <div className="atlas-pulse-tile rounded-2xl border border-border-subtle bg-input-bg/55 p-4 md:col-span-2 lg:col-span-3">
          <div className="flex h-full min-h-[108px] flex-col justify-between">
            <div className="text-[10px] font-medium text-text-muted">Largest mover</div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-base font-semibold text-text-main">
                  {pulse.ready ? (pulse.biggestMover?.name || "No change") : "—"}
                </span>
                {pulse.biggestMover && (
                  <span className="flex-shrink-0 rounded-full bg-emerald-metric/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-metric tabular-nums">
                    +{pulse.biggestMover.delta}
                  </span>
                )}
              </div>
              <div className="mt-1.5 text-[9px] text-text-muted">new games in latest interval</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});

export default CompetitivePulse;
