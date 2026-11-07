import { clsx } from "clsx";

import type { BudgetTier } from "@arena/shared";
import type { ZgBudget } from "@/lib/types";
import { fmtAmount, fmtUsd } from "@/lib/format";

const TIERS: { tier: BudgetTier; label: string; rule: string; bar: string }[] = [
  { tier: "healthy", label: "Healthy", rule: "3 or more days of AI credit left", bar: "bg-long" },
  { tier: "low", label: "Low", rule: "1 to 3 days left: uses a cheaper model and decides less often", bar: "bg-warn" },
  { tier: "critical", label: "Critical", rule: "Under a day left: no new entries", bar: "bg-short" },
  { tier: "empty", label: "Empty", rule: "No credit left, or today's cap was reached", bar: "bg-subtle" },
];

/** AI budget tier meter and 0G credit state (PRD 6.11.6). */
export function BudgetCard({ zg }: { zg: ZgBudget }) {
  const active = TIERS.find((t) => t.tier === zg.tier) ?? TIERS[0];
  const capPct = zg.dailyCapUsd > 0 ? Math.min(100, (zg.spentTodayUsd / zg.dailyCapUsd) * 100) : 0;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-4 gap-1.5" role="meter" aria-label="Budget tier" aria-valuetext={active?.label}>
        {TIERS.map((t) => (
          <div
            key={t.tier}
            className={clsx("h-2 rounded-full", t.bar, t.tier === zg.tier ? "opacity-100" : "opacity-20")}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-medium">{active?.label}</div>
          <div className="text-sm text-muted">{active?.rule}</div>
        </div>
        <div className="num text-right text-sm text-muted">{fmtAmount(zg.runwayDays, 1)} days left</div>
      </div>
      <dl className="num grid grid-cols-2 gap-y-2 text-sm [&_dt]:font-sans">
        <dt className="text-muted">AI credit balance</dt>
        <dd className="text-right">{fmtUsd(zg.balanceUsd, 4)}</dd>
        <dt className="text-muted">Usual daily spend</dt>
        <dd className="text-right">{fmtUsd(zg.dailySpendUsd, 4)}</dd>
        <dt className="text-muted">Spent today / daily cap</dt>
        <dd className="text-right">
          {fmtUsd(zg.spentTodayUsd, 4)} / {fmtUsd(zg.dailyCapUsd, 2)}
        </dd>
      </dl>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2" aria-hidden>
        <div className="h-full bg-link" style={{ width: `${capPct}%` }} />
      </div>
      <div className="text-xs text-muted">
        The daily cap is enforced by 0G on the agent&apos;s own key.
      </div>
    </div>
  );
}
