import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Pill, type Tone } from "@/components/ui/pill";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { fmtAmount, fmtUsd } from "@/lib/format";
import type { PaperLedgerView } from "@/lib/types";

const KIND: Record<PaperLedgerView["entries"][number]["kind"], { label: string; tone: Tone }> = {
  commission: { label: "commission", tone: "long" },
  topup: { label: "top-up", tone: "link" },
};

function utcShort(ts: number): string {
  return new Date(ts).toISOString().slice(5, 16).replace("T", " ");
}

/**
 * Paper self-funding loop: commission earned on paper profit, top-ups bought with it (USD to 0G credit), the
 * balance, and the ledger. Every row is simulated. Owner only, paper agents only.
 */
export function PaperFundingCard({ ledger, loading }: { ledger: PaperLedgerView | undefined; loading: boolean }) {
  const t = ledger?.totals;
  return (
    <Panel
      title="Paper self-funding"
      right={<Badge tone="warn">Paper</Badge>}
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="text-[11.5px] text-muted">PAPER — simulated commission → 0G credit loop</div>

        <div className="grid grid-cols-3 gap-2">
          <Figure label="Commission earned" value={fmtUsd(t?.commissionUsd ?? 0, 4)} />
          <Figure label="Top-ups (USD → 0G)" value={`${fmtUsd(t?.topupUsd ?? 0, 4)} → ${fmtAmount(t?.topup0g ?? 0, 4)} 0G`} />
          <Figure label="Balance" value={fmtUsd(t?.balanceUsd ?? 0, 4)} />
        </div>

        {loading && !ledger ? (
          <div className="h-16 animate-pulse rounded bg-panel-2" aria-hidden />
        ) : (
          <Table bare>
            <THead>
              <tr>
                <TH>Time (UTC)</TH>
                <TH>Kind</TH>
                <TH align="right">USD</TH>
                <TH align="right">0G</TH>
                <TH>Note</TH>
              </tr>
            </THead>
            <tbody>
              {(ledger?.entries.length ?? 0) === 0 ? (
                <EmptyRow colSpan={5}>No commission yet. It accrues when paper trades realize profit.</EmptyRow>
              ) : null}
              {ledger?.entries.map((e) => (
                <TR key={e.id}>
                  <TD className="text-muted">{utcShort(e.ts)}</TD>
                  <TD>
                    <Pill tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Pill>
                  </TD>
                  <TD align="right">{fmtUsd(e.amountUsd, 4)}</TD>
                  <TD align="right">{e.amount0g === null ? <span className="text-muted">n/a</span> : fmtAmount(e.amount0g, 4)}</TD>
                  <TD className="text-muted">{e.note ?? ""}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Panel>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-panel-2 px-2.5 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className="num text-[12.5px] font-medium">{value}</div>
    </div>
  );
}
