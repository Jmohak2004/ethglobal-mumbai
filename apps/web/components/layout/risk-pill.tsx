"use client";

import { useQuery } from "@tanstack/react-query";

import { Pill, type Tone } from "@/components/ui/pill";
import { Tooltip } from "@/components/ui/tooltip";
import { getJson } from "@/lib/api";
import type { RiskDisplay, RiskStatus } from "@/lib/types";

const LABEL: Record<RiskDisplay, { text: string; tone: Tone; meaning: string }> = {
  NORMAL: { text: "NORMAL", tone: "long", meaning: "Market calm. Agents trade normally." },
  CAUTION: { text: "CAUTION", tone: "warn", meaning: "Market shaky. Half size, no new breakout buys." },
  HALT: { text: "HALT", tone: "short", meaning: "Crash or danger. No new buys, pending entries cancelled." },
  UNKNOWN: { text: "UNKNOWN", tone: "muted", meaning: "Risk level could not be read right now. Treat it as unverified." },
};

/**
 * Global crash-sentinel light. Starts from the level the layout rendered, then polls /api/risk every 5 s so a level
 * change (CRE report, or a demo control) shows within a few seconds. A failed poll shows UNKNOWN.
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
      content={
        <div className="flex flex-col gap-0.5">
          <div className="font-medium">Chainlink CRE Crash Sentinel: onchain</div>
          <div className="text-muted">{cfg.meaning}</div>
        </div>
      }
    >
      <Pill tone={cfg.tone} className="cursor-help">
        {cfg.text}
      </Pill>
    </Tooltip>
  );
}
