import type { RiskLevel } from "@arena/shared";

import { Pill, type Tone } from "@/components/ui/pill";
import { Tooltip } from "@/components/ui/tooltip";

const LABEL: Record<RiskLevel, { text: string; tone: Tone; meaning: string }> = {
  NORMAL: { text: "NORMAL", tone: "long", meaning: "Market calm. Agents trade normally." },
  CAUTION: { text: "CAUTION", tone: "warn", meaning: "Market shaky. Half size, no new breakout buys." },
  HALT: { text: "HALT", tone: "short", meaning: "Crash or danger. No new buys, pending entries cancelled." },
};

/** Global crash-sentinel light. Server-renderable (no client JS). */
export function RiskPill({ level }: { level: RiskLevel }) {
  const cfg = LABEL[level];
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
