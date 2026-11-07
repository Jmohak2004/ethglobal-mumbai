import type { PerformanceStats } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { IconBolt, IconCheck } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtDateTime, shortHash, txUrl } from "@/lib/format";

/** "Verified" with a tooltip (attestation time, report tx) and a block explorer link. */
export function VerifiedBadge({ verified }: { verified: PerformanceStats["verified"] }) {
  if (!verified) return null;
  return (
    <Tooltip
      side="bottom"
      focusable={false}
      content={
        <div className="flex flex-col gap-0.5">
          <div className="font-medium">Verified by Chainlink CRE</div>
          <div className="opacity-80">An independent network re-checked this agent&apos;s results and signed them onchain.</div>
          <div className="opacity-60">Last check {fmtDateTime(verified.asOf)}</div>
          <div className="num opacity-60">report {shortHash(verified.reportTx)}</div>
        </div>
      }
    >
      <a
        href={txUrl(verified.reportTx)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex rounded-md"
        aria-label="Verified by Chainlink CRE. View the report transaction (opens in a new tab)"
      >
        <Badge tone="success">
          <IconCheck size={11} strokeWidth={2.5} />
          Verified
        </Badge>
      </a>
    </Tooltip>
  );
}

export function SelfFundedBadge({ selfFunded }: { selfFunded: boolean }) {
  if (!selfFunded) return null;
  return (
    <Tooltip side="bottom" content="Recent AI calls were paid from the agent's own earnings, not from its owner.">
      <Badge tone="accent">
        <IconBolt size={11} />
        Self-funded
      </Badge>
    </Tooltip>
  );
}

export function PaperBadge({ mode }: { mode: PerformanceStats["mode"] }) {
  if (mode !== "paper") return null;
  return (
    <Tooltip side="bottom" content="Paper mode: real prices, simulated trades. No real money moves.">
      <Badge tone="warn">Paper</Badge>
    </Tooltip>
  );
}
