import { clsx } from "clsx";

import type { BudgetTier } from "@arena/shared";
import type { ZgBudget } from "@/lib/data";
import { fmtAmount, fmtUsd } from "@/lib/format";

const TIERS: { tier: BudgetTier; label: string; rule: string; bar: string }[] = [
  { tier: "healthy", label: "Healthy", rule: "3+ days runway", bar: "bg-long" },
  { tier: "low", label: "Low", rule: "1-3 days: economical model, tick x3", bar: "bg-warn" },
  { tier: "critical", label: "Critical", rule: "under 1 day or 402: no new entries", bar: "bg-short" },
  { tier: "empty", label: "Empty", rule: "0 balance or daily cap hit", bar: "bg-muted" },
];

/** AI budget tier meter and 0G credit state (PRD 6.11.6). */
export function BudgetCard({ zg }: { zg: ZgBudget }) {
  const active = TIERS.find((t) => t.tier === zg.tier) ?? TIERS[0];
  const capPct = zg.dailyCapUsd > 0 ? Math.min(100, (zg.spentTodayUsd / zg.dailyCapUsd) * 100) : 0;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-4 gap-1" role="meter" aria-label="Budget tier" aria-valuetext={active?.label}>
        {TIERS.map((t) => (
          <div
            key={t.tier}
            className={clsx("h-1.5 rounded-full", t.bar, t.tier === zg.tier ? "opacity-100" : "opacity-20")}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium">{active?.label}</div>
          <div className="text-[11.5px] text-muted">{active?.rule}</div>
        </div>
        <div className="num text-right text-[11.5px] text-muted">runway {fmtAmount(zg.runwayDays, 1)}d</div>
      </div>
      <dl className="num grid grid-cols-2 gap-y-1.5 text-[12px]">
        <dt className="text-muted">0G balance</dt>
        <dd className="text-right">{fmtUsd(zg.balanceUsd, 4)}</dd>
        <dt className="text-muted">Daily spend</dt>
        <dd className="text-right">{fmtUsd(zg.dailySpendUsd, 4)}</dd>
        <dt className="text-muted">Spent today / cap</dt>
        <dd className="text-right">
          {fmtUsd(zg.spentTodayUsd, 4)} / {fmtUsd(zg.dailyCapUsd, 2)}
        </dd>
      </dl>
      <div className="h-1 overflow-hidden rounded-full bg-panel-2" aria-hidden>
        <div className="h-full bg-link" style={{ width: `${capPct}%` }} />
      </div>
      <div className="text-[11px] text-muted">
        Daily cap is enforced by 0G on the agent&apos;s sk- key and tracked from x_0g_trace billing.
      </div>
    </div>
  );
}
