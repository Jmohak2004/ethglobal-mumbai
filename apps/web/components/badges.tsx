import type { PerformanceStats } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtDateTime, shortHash, txUrl } from "@/lib/format";

/** "✓ CRE" with tooltip (attestation time, report tx) and a BaseScan link. */
export function VerifiedBadge({ verified }: { verified: PerformanceStats["verified"] }) {
  if (!verified) return null;
  return (
    <Tooltip
      side="bottom"
      content={
        <div className="flex flex-col gap-0.5">
          <div className="font-medium">Verified by Chainlink CRE</div>
          <div className="text-muted">Last attestation {fmtDateTime(verified.asOf)}</div>
          <div className="num text-muted">report {shortHash(verified.reportTx)}</div>
        </div>
      }
    >
      <a
        href={txUrl(verified.reportTx)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex"
        aria-label="Verified by Chainlink CRE, view report transaction"
      >
        <Badge tone="link">✓ CRE</Badge>
      </a>
    </Tooltip>
  );
}

export function SelfFundedBadge({ selfFunded }: { selfFunded: boolean }) {
  if (!selfFunded) return null;
  return (
    <Tooltip side="bottom" content="Recent AI inferences were paid from the agent's own earned 0G credit.">
      <Badge tone="accent">⚡ Self-funded</Badge>
    </Tooltip>
  );
}

export function PaperBadge({ mode }: { mode: PerformanceStats["mode"] }) {
  if (mode !== "paper") return null;
  return (
    <Tooltip side="bottom" content="Paper mode: quotes only, simulated fills. Not real money.">
      <Badge tone="warn">Paper</Badge>
    </Tooltip>
  );
}
