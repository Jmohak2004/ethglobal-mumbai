"use client";

import type { StrategyConfig } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { IconCheck } from "@/components/ui/icons";
import { fmtPct, shortAddr } from "@/lib/format";
import { CRASH_MODES, DEMO_CAPS, FORK_PLATFORM_BPS, MODEL_TIERS, getTemplate } from "@/lib/templates";

/** Plain-words review of the agent being built, the demo-limit note and the raw JSON for anyone who wants it. */
export function SummaryPanel({
  name,
  config,
  ownerLabel,
  mode,
  errors,
}: {
  name: string;
  config: StrategyConfig;
  ownerLabel: string | null;
  mode: "paper" | "live";
  errors: string[];
}) {
  const tpl = getTemplate(config.template);
  const json = JSON.stringify({ name: name.trim(), config }, null, 2);
  const rows: [string, string][] = [
    ["Name", name.trim() || "Not set yet"],
    ["Strategy", tpl?.name ?? config.template],
    ["Owner", ownerLabel ? (ownerLabel.startsWith("0x") ? shortAddr(ownerLabel) : ownerLabel) : "No wallet connected"],
    ["Mode", mode === "paper" ? "Paper (simulated, no real money)" : "Live (real money)"],
    ["Markets", config.assets.join(", ")],
    ["Settings", tpl ? tpl.sliders.map((s) => `${s.label} ${config.sliders[s.key] ?? s.default}${s.unit}`).join(", ") : "-"],
    ["Per trade", `Up to $${config.limits.maxTradeUsd}`],
    ["Daily loss stop", `$${config.limits.maxDailyLossUsd}`],
    ["Total funds", `Up to $${config.limits.maxAllocationUsd}`],
    ["Open trades", `Up to ${config.limits.maxOpenPositions}`],
    ["Pauses after a fall of", fmtPct(config.limits.maxDrawdownPct, 0)],
    ["Decides every", `${config.tickIntervalSec} seconds`],
    ["AI model", MODEL_TIERS.find((m) => m.value === config.modelTier)?.label ?? config.modelTier],
    ["In a crash", CRASH_MODES.find((m) => m.value === config.crashMode)?.label ?? config.crashMode],
    ["Commission", `${fmtPct(config.commissionBps / 100, 1)} of new profit highs`],
    ["Auto-tune", config.autoTune.enabled ? `On, up to ${config.autoTune.maxDeltaPct}% a day` : "Off"],
    ["Public commentary", config.publicCommentary === "off" ? "Off" : "Delayed"],
    ["Extra sources", config.insightSources.length ? String(config.insightSources.length) : "None"],
    [
      "Forking",
      config.fork.forkable
        ? `Allowed at $${config.fork.priceUsd.toFixed(2)} USDC (you keep ${100 - FORK_PLATFORM_BPS / 100}%)`
        : "Not allowed",
    ],
  ];

  return (
    <div className="flex flex-col gap-4">
      <dl className="divide-y divide-border rounded-xl border border-border bg-panel">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 px-4 py-2.5 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-text">{v}</dd>
          </div>
        ))}
      </dl>

      <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn">
        Limits are tiny in this demo: ${DEMO_CAPS.maxTradeUsd} per trade, ${DEMO_CAPS.maxAllocationUsd} total funds, $
        {DEMO_CAPS.maxDailyLossUsd} daily loss and {DEMO_CAPS.maxOpenPositions} open trades at most.
      </p>

      {errors.length > 0 ? (
        <div role="alert" className="rounded-lg bg-short-soft px-3 py-2.5 text-sm text-short">
          <div className="font-medium">Fix these before creating:</div>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <Badge tone="success">
            <IconCheck size={11} strokeWidth={2.5} />
            Ready to create
          </Badge>
        </div>
      )}

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm text-muted hover:text-text">Show raw settings (JSON)</summary>
        <pre className="num max-h-80 overflow-auto border-t border-border p-3 text-xs leading-relaxed text-muted">{json}</pre>
      </details>
    </div>
  );
}
