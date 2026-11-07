"use client";

import { useQuery } from "@tanstack/react-query";

import { Pill, type Tone } from "@/components/ui/pill";
import { Tooltip } from "@/components/ui/tooltip";
import { getJson } from "@/lib/api";
import type { RiskDisplay, RiskStatus } from "@/lib/types";

const LABEL: Record<RiskDisplay, { text: string; tone: Tone; meaning: string }> = {
  NORMAL: { text: "Market calm", tone: "long", meaning: "Conditions look normal, so agents trade as usual." },
  CAUTION: { text: "Market shaky", tone: "warn", meaning: "Things look unsteady. Agents trade at half size and skip breakout buys." },
  HALT: { text: "Trading paused", tone: "short", meaning: "A crash or danger was detected. Agents stop buying and cancel pending entries." },
  UNKNOWN: { text: "Status unknown", tone: "muted", meaning: "We could not read the safety signal just now. Treat it as unverified." },
};

/**
 * Global crash-sentinel light, shown as a friendly status chip. Starts from the level the layout rendered, then polls
 * /api/risk every 5 s so a level change (CRE report, or a demo control) shows within a few seconds. A failed poll shows
 * "Status unknown". The raw level (NORMAL, CAUTION, HALT) stays in the tooltip for anyone who wants it.
 */
export function RiskPill({ level }: { level: RiskDisplay }) {
  const q = useQuery({
    queryKey: ["risk"],
    queryFn: () => getJson<RiskStatus>("/api/risk"),
    refetchInterval: 5_000,
    retry: false,
  });
  const current: RiskDisplay = q.isError ? "UNKNOWN" : (q.data?.level ?? level);
  const cfg = LABEL[current];
  return (
    <Tooltip
      side="bottom"
      align="end"
      label={`Crash light: ${cfg.text}`}
      content={
        <div className="flex flex-col gap-1">
          <div className="font-medium">
            Crash light: {cfg.text} <span className="num font-normal opacity-70">({current})</span>
          </div>
          <div className="opacity-80">{cfg.meaning}</div>
          <div className="opacity-60">Set onchain by Chainlink and rechecked every few seconds.</div>
        </div>
      }
    >
      <Pill tone={cfg.tone} className="cursor-help">
        {cfg.text}
      </Pill>
    </Tooltip>
  );
}
