"use client";

import type { PerformanceStats } from "@arena/shared";
import { useState } from "react";

import { IconChevronDown } from "@/components/ui/icons";
import { StatCard } from "@/components/ui/stat-card";
import { fmtBps, fmtNum, fmtPct, fmtUsdSigned } from "@/lib/format";

/** Public stats only (free tier). Four headline numbers, the rest one click away. */
export function StatsGrid({ stats }: { stats: PerformanceStats }) {
  const [more, setMore] = useState(false);
  const isAgent = stats.kind === "agent";
  return (
    <section aria-label="Results" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Return"
          value={fmtPct(stats.realizedPnlPct, 2, true)}
          tone={stats.realizedPnlPct >= 0 ? "long" : "short"}
          help="Profit from closed trades as a share of starting funds."
        />
        <StatCard
          label="Profit"
          value={fmtUsdSigned(stats.realizedPnlUsd)}
          tone={stats.realizedPnlUsd >= 0 ? "long" : "short"}
          help="Realized profit or loss in US dollars."
        />
        <StatCard label="Win rate" value={fmtBps(stats.winRateBps)} help="How often a closed trade made money." />
        <StatCard
          label="Worst dip"
          value={<span className="text-short">-{fmtBps(stats.maxDrawdownBps)}</span>}
          help="The biggest fall from a peak. Smaller means steadier."
        />
      </div>

      {more ? (
        <div className="grid animate-fade-in grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="AI accuracy"
            value={isAgent ? fmtBps(stats.forecastHitRateBps) : "n/a"}
            sub={isAgent ? "Forecasts scored later" : "Humans do not forecast"}
          />
          <StatCard label="Trades" value={fmtNum(stats.trades)} />
          <StatCard label="Volume" value={`$${fmtNum(stats.volumeUsd, 2)}`} />
          <StatCard label="Days active" value={fmtNum(stats.daysActive)} />
          <StatCard label="Copies" value={isAgent ? fmtNum(stats.forkCount) : "n/a"} />
          <StatCard label="Followed crash rules" value="Not checked" sub="Not verified yet" />
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setMore((m) => !m)}
        aria-expanded={more}
        className="inline-flex w-fit items-center gap-1 rounded-md text-sm font-medium text-accent-fg hover:underline"
      >
        {more ? "Show fewer stats" : "Show all stats"}
        <IconChevronDown size={14} className={more ? "rotate-180" : ""} />
      </button>
    </section>
  );
}
