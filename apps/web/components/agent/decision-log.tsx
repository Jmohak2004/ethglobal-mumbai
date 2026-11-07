import type { PolicyVerdict } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconClock } from "@/components/ui/icons";
import { Pill, type Tone } from "@/components/ui/pill";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { flashOrderUrl, fmtAmount, fmtPct, journalTxUrl, liveTxUrl, shortHash } from "@/lib/format";
import type { DecisionEpisode } from "@/lib/types";

const VERDICT_TONE: Record<PolicyVerdict["kind"], Tone> = {
  approve: "long",
  clamp: "warn",
  reject: "short",
  noop: "muted",
};

const VERDICT_LABEL: Record<PolicyVerdict["kind"], string> = {
  approve: "Approved",
  clamp: "Resized",
  reject: "Blocked",
  noop: "No action",
};

const ARROW: Record<"up" | "down" | "flat", { glyph: string; cls: string; word: string }> = {
  up: { glyph: "▲", cls: "text-long", word: "up" },
  down: { glyph: "▼", cls: "text-short", word: "down" },
  flat: { glyph: "▬", cls: "text-muted", word: "flat" },
};

function utcShort(ts: number): string {
  return new Date(ts).toISOString().slice(5, 16).replace("T", " ");
}

/** Owner decision log: forecast, proposal, policy verdict, 0G request id and Flash order. */
export function DecisionLog({ episodes }: { episodes: DecisionEpisode[] }) {
  if (episodes.length === 0) {
    return (
      <EmptyState
        compact
        icon={<IconClock size={18} />}
        title="No decisions yet"
        description="Press Run now above, or wait for the next scheduled decision. Each one will show up here."
      />
    );
  }
  return (
    <Table bare>
      <THead>
        <tr>
          <TH>Time (UTC)</TH>
          <TH>AI expected</TH>
          <TH>AI proposed</TH>
          <TH>Safety check</TH>
          <TH>Proof (0G)</TH>
          <TH>Order</TH>
        </tr>
      </THead>
      <tbody>
        {episodes.length === 0 ? <EmptyRow colSpan={6}>No decisions yet.</EmptyRow> : null}
        {episodes.map((e) => (
          <DecisionRow key={e.id} e={e} />
        ))}
      </tbody>
    </Table>
  );
}

function DecisionRow({ e }: { e: DecisionEpisode }) {
  const p = e.decision?.proposal;
  const f = e.decision?.forecast;
  const arrow = f ? ARROW[f.direction] : null;
  const reasons = e.verdict.kind === "approve" ? ["Passed all policy checks."] : e.verdict.reasons;
  const entryPx = p?.limitPrice ?? p?.triggerPrice;
  const flashId = e.flashOrderIds[0];
  const tx = flashId ? e.orderTx?.[flashId] : undefined;

  return (
    <TR>
      <TD className="num text-muted">{utcShort(e.ts)}</TD>
      <TD>
        {f && arrow ? (
          <span>
            <span className={arrow.cls} role="img" aria-label={arrow.word}>{arrow.glyph}</span> {f.asset} {fmtPct(f.expectedMovePct, 1, true)} /{" "}
            {f.horizonMin / 60}h · {Math.round(f.confidence * 100)}%
          </span>
        ) : (
          <span className="text-muted">n/a</span>
        )}
      </TD>
      <TD>
        {p ? (
          <span>
            {p.action}
            {p.orderType ? ` ${p.orderType}` : ""}
            {p.sizePct !== undefined ? ` · ${Math.round(p.sizePct * 100)}%` : ""}
            {entryPx !== undefined ? ` @ ${fmtAmount(entryPx, 2)}` : ""}
            {p.takeProfitPct !== undefined && p.stopLossPct !== undefined
              ? ` · TP ${p.takeProfitPct}% / SL ${p.stopLossPct}%`
              : ""}
          </span>
        ) : (
          <span className="text-short">{e.error ?? "No proposal"}</span>
        )}
      </TD>
      <TD>
        <Tooltip
          side="bottom"
          content={
            <ul className="flex list-disc flex-col gap-0.5 pl-3.5">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          }
        >
          <Pill tone={VERDICT_TONE[e.verdict.kind]}>{VERDICT_LABEL[e.verdict.kind]}</Pill>
        </Tooltip>
      </TD>
      <TD>
        {e.inference ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="num text-text">{shortHash(e.inference.requestId)}</span>
            <CopyButton value={e.inference.requestId} label="Copy" />
            {e.inference.teeVerified ? <Badge tone="success">Verified</Badge> : null}
          </span>
        ) : (
          <span className="text-muted">n/a</span>
        )}
      </TD>
      <TD>
        {!flashId ? (
          <span className="text-muted">None</span>
        ) : tx?.paper ? (
          // Paper orders never reached Flash. Their fill is journaled on Base Sepolia once the worker records it.
          tx.txHash ? (
            <span className="inline-flex flex-wrap items-center gap-2" title={tx.txHash}>
              <Badge tone="success">paper · journaled</Badge>
              <a href={journalTxUrl(tx.txHash)} target="_blank" rel="noreferrer" className="text-accent-fg hover:underline">
                View on BaseScan
              </a>
            </span>
          ) : (
            <Badge tone="warn">simulated</Badge>
          )
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <a href={flashOrderUrl(flashId)} target="_blank" rel="noreferrer" className="num text-accent-fg hover:underline">
              {flashId}
            </a>
            {tx?.txHash ? (
              <a href={liveTxUrl(tx.txHash)} target="_blank" rel="noreferrer" className="text-accent-fg hover:underline" title={tx.txHash}>
                View on BaseScan
              </a>
            ) : null}
          </span>
        )}
      </TD>
    </TR>
  );
}
