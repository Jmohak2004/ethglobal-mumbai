import type { Episode, PolicyVerdict } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { Pill, type Tone } from "@/components/ui/pill";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { flashOrderUrl, fmtAmount, fmtPct, shortHash } from "@/lib/format";

const VERDICT_TONE: Record<PolicyVerdict["kind"], Tone> = {
  approve: "long",
  clamp: "warn",
  reject: "short",
  noop: "muted",
};

const ARROW: Record<"up" | "down" | "flat", { glyph: string; cls: string }> = {
  up: { glyph: "▲", cls: "text-long" },
  down: { glyph: "▼", cls: "text-short" },
  flat: { glyph: "▬", cls: "text-muted" },
};

function utcShort(ts: number): string {
  return new Date(ts).toISOString().slice(5, 16).replace("T", " ");
}

/** Owner decision log: forecast, proposal, policy verdict, 0G request id and Flash order. */
export function DecisionLog({ episodes }: { episodes: Episode[] }) {
  return (
    <Table bare>
      <THead>
        <tr>
          <TH>Time (UTC)</TH>
          <TH>Forecast</TH>
          <TH>Proposed</TH>
          <TH>Verdict</TH>
          <TH>0G request</TH>
          <TH>Flash order</TH>
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

function DecisionRow({ e }: { e: Episode }) {
  const p = e.decision?.proposal;
  const f = e.decision?.forecast;
  const arrow = f ? ARROW[f.direction] : null;
  const reasons = e.verdict.kind === "approve" ? ["Passed all policy checks."] : e.verdict.reasons;
  const entryPx = p?.limitPrice ?? p?.triggerPrice;
  const flashId = e.flashOrderIds[0];

  return (
    <TR>
      <TD className="text-muted">{utcShort(e.ts)}</TD>
      <TD>
        {f && arrow ? (
          <span>
            <span className={arrow.cls}>{arrow.glyph}</span> {f.asset} {fmtPct(f.expectedMovePct, 1, true)} /{" "}
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
          <span className="text-short">{e.error ?? "no proposal"}</span>
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
          <Pill tone={VERDICT_TONE[e.verdict.kind]}>{e.verdict.kind}</Pill>
        </Tooltip>
      </TD>
      <TD>
        {e.inference ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-text">{shortHash(e.inference.requestId)}</span>
            <CopyButton value={e.inference.requestId} label="Copy" />
            {e.inference.teeVerified ? <Badge tone="accent">TEE ✓</Badge> : null}
          </span>
        ) : (
          <span className="text-muted">n/a</span>
        )}
      </TD>
      <TD>
        {flashId ? (
          <a href={flashOrderUrl(flashId)} target="_blank" rel="noreferrer" className="text-link hover:underline">
            {flashId}
          </a>
        ) : (
          <span className="text-muted">none</span>
        )}
      </TD>
    </TR>
  );
}
