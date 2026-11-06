"use client";

import type { StrategyConfig } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { fmtBps, fmtPct, shortAddr } from "@/lib/format";
import { DEMO_CAPS, FORK_PLATFORM_BPS, getTemplate, MODEL_TIERS, CRASH_MODES } from "@/lib/templates";

/** Readable spec, demo-limit warning and collapsible JSON for the config being built. */
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
    ["Template", tpl?.name ?? config.template],
    ["Name", name.trim() || "not set"],
    ["Owner", ownerLabel ? (ownerLabel.startsWith("0x") ? shortAddr(ownerLabel) : ownerLabel) : "not connected"],
    ["Mode", mode],
    ["Assets", config.assets.join(", ")],
    ["Sliders", tpl ? tpl.sliders.map((s) => `${s.label} ${config.sliders[s.key] ?? s.default}${s.unit}`).join(" · ") : "-"],
    ["Max trade", `$${config.limits.maxTradeUsd}`],
    ["Max allocation", `$${config.limits.maxAllocationUsd}`],
    ["Daily loss stop", `$${config.limits.maxDailyLossUsd}`],
    ["Max drawdown", fmtPct(config.limits.maxDrawdownPct, 0)],
    ["Cooldown", `${config.limits.cooldownSec}s`],
    ["Tick", `${config.tickIntervalSec}s`],
    ["Model", MODEL_TIERS.find((m) => m.value === config.modelTier)?.label ?? config.modelTier],
    ["On HALT", CRASH_MODES.find((m) => m.value === config.crashMode)?.label ?? config.crashMode],
    ["Commission", `${fmtPct(config.commissionBps / 100, 1)} (${fmtBps(config.commissionBps)} = ${config.commissionBps} bps)`],
    ["Auto-tune", config.autoTune.enabled ? `on, ±${config.autoTune.maxDeltaPct}%/day` : "off"],
    ["Commentary", config.publicCommentary],
    ["Insight sources", String(config.insightSources.length)],
    [
      "Fork",
      config.fork.forkable
        ? `$${config.fork.priceUsd.toFixed(2)} USDC · creator ${100 - FORK_PLATFORM_BPS / 100}% / platform ${FORK_PLATFORM_BPS / 100}%`
        : "not forkable",
    ],
  ];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn">
        Demo limits are tiny: ${DEMO_CAPS.maxTradeUsd} per trade, ${DEMO_CAPS.maxAllocationUsd} allocation, $
        {DEMO_CAPS.maxDailyLossUsd} daily loss, {DEMO_CAPS.maxOpenPositions} open positions. Set by platform env.
      </div>

      <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 text-right text-text">{v}</dd>
          </div>
        ))}
      </dl>

      {errors.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded border border-short/40 bg-short/10 px-3 py-2 text-[11.5px] text-short">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : (
        <div>
          <Badge tone="accent">Config valid</Badge>
        </div>
      )}

      <details className="rounded border border-border">
        <summary className="cursor-pointer px-3 py-1.5 text-[11.5px] text-muted hover:text-text">JSON</summary>
        <pre className="num max-h-80 overflow-auto border-t border-border p-3 text-[11px] leading-relaxed text-muted">
          {json}
        </pre>
      </details>
    </div>
  );
}
