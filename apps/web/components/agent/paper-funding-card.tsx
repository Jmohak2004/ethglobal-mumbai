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
    <div>
      <div className="flex flex-col gap-4 p-4">
        <div className="text-sm text-muted">Everything here is simulated: commission earned on practice profit, turned into AI credit.</div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Figure label="Commission earned" value={fmtUsd(t?.commissionUsd ?? 0, 4)} />
          <Figure label="AI top-ups (USD to 0G)" value={`${fmtUsd(t?.topupUsd ?? 0, 4)} → ${fmtAmount(t?.topup0g ?? 0, 4)} 0G`} />
          <Figure label="Balance" value={fmtUsd(t?.balanceUsd ?? 0, 4)} />
        </div>

        {loading && !ledger ? (
          <div className="h-16 animate-pulse rounded-lg bg-panel-2" aria-hidden />
        ) : (
          <Table bare>
            <THead>
              <tr>
                <TH>Time (UTC)</TH>
                <TH>Type</TH>
                <TH align="right">USD</TH>
                <TH align="right">0G</TH>
                <TH>Note</TH>
              </tr>
            </THead>
            <tbody>
              {(ledger?.entries.length ?? 0) === 0 ? (
                <EmptyRow colSpan={5}>No commission yet. It builds up when practice trades make a profit.</EmptyRow>
              ) : null}
              {ledger?.entries.map((e) => (
                <TR key={e.id}>
                  <TD className="num text-muted">{utcShort(e.ts)}</TD>
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
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-panel-2 px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="num text-base font-medium">{value}</div>
    </div>
  );
}
