import { Pill, type Tone } from "@/components/ui/pill";
import { Tooltip } from "@/components/ui/tooltip";
import type { RiskDisplay } from "@/lib/types";

const LABEL: Record<RiskDisplay, { text: string; tone: Tone; meaning: string }> = {
  NORMAL: { text: "NORMAL", tone: "long", meaning: "Market calm. Agents trade normally." },
  CAUTION: { text: "CAUTION", tone: "warn", meaning: "Market shaky. Half size, no new breakout buys." },
  HALT: { text: "HALT", tone: "short", meaning: "Crash or danger. No new buys, pending entries cancelled." },
  UNKNOWN: { text: "UNKNOWN", tone: "muted", meaning: "Risk level could not be read right now. Treat it as unverified." },
};

/** Global crash-sentinel light. Server-renderable (no client JS). UNKNOWN is grey. */
export function RiskPill({ level }: { level: RiskDisplay }) {
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
