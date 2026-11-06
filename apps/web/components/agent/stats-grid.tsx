import type { PerformanceStats } from "@arena/shared";

import { StatCard } from "@/components/ui/stat-card";
import { fmtBps, fmtNum, fmtPct, fmtUsdSigned } from "@/lib/format";

/** Public stats only (free tier). */
export function StatsGrid({ stats }: { stats: PerformanceStats }) {
  const isAgent = stats.kind === "agent";
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      <StatCard label="Realized PnL" value={fmtPct(stats.realizedPnlPct, 2, true)} tone={stats.realizedPnlPct >= 0 ? "long" : "short"} />
      <StatCard label="PnL (USD)" value={fmtUsdSigned(stats.realizedPnlUsd)} tone={stats.realizedPnlUsd >= 0 ? "long" : "short"} />
      <StatCard label="Win rate" value={fmtBps(stats.winRateBps)} />
      <StatCard label="Max drawdown" value={<span className="text-short">-{fmtBps(stats.maxDrawdownBps)}</span>} />
      <StatCard
        label="Forecast hit"
        value={isAgent ? fmtBps(stats.forecastHitRateBps) : "n/a"}
        sub={isAgent ? "Scored at resolveAt" : "Humans do not forecast"}
      />
      <StatCard label="Trades" value={fmtNum(stats.trades)} />
      <StatCard label="Volume" value={`$${fmtNum(stats.volumeUsd, 2)}`} />
      <StatCard label="Days active" value={fmtNum(stats.daysActive)} />
      <StatCard label="Forks" value={isAgent ? fmtNum(stats.forkCount) : "n/a"} />
      <StatCard label="Crash-rule compliance" value="n/a" sub="Not attested yet (CRE WF1)" />
    </div>
  );
}
