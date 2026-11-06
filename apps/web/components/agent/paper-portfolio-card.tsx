import { Badge } from "@/components/ui/badge";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { fmtAmount, fmtDateTime, fmtUsd, fmtUsdSigned, pnlClass } from "@/lib/format";
import type { PortfolioSnapshot } from "@/lib/types";

/** Owner-only paper book from the worker's runtime snapshot: cash, positions, equity and PnL. */
export function PaperPortfolioCard({ portfolio }: { portfolio: PortfolioSnapshot | null | undefined }) {
  if (!portfolio) {
    return (
      <div className="flex flex-col gap-2 p-3 text-[12px] text-muted">
        <div>
          <Badge tone="warn">Paper</Badge>
        </div>
        No portfolio snapshot yet. The worker writes one after the first decision.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge tone="warn">Paper</Badge>
        <span className="num text-[11px] text-muted">as of {fmtDateTime(portfolio.asOf)}</span>
      </div>

      <dl className="num grid grid-cols-2 gap-y-1.5 text-[12px]">
        <dt className="text-muted">Cash</dt>
        <dd className="text-right">{fmtUsd(portfolio.cashUsd, 2)}</dd>
        <dt className="text-muted">Equity</dt>
        <dd className="text-right font-medium">{fmtUsd(portfolio.equityUsd, 2)}</dd>
        <dt className="text-muted">Realized PnL</dt>
        <dd className={`text-right ${pnlClass(portfolio.realizedPnlUsd)}`}>{fmtUsdSigned(portfolio.realizedPnlUsd)}</dd>
        <dt className="text-muted">Unrealized PnL</dt>
        <dd className={`text-right ${pnlClass(portfolio.unrealizedPnlUsd)}`}>{fmtUsdSigned(portfolio.unrealizedPnlUsd)}</dd>
      </dl>

      <Table bare>
        <THead>
          <tr>
            <TH>Asset</TH>
            <TH align="right">Qty</TH>
            <TH align="right">Avg</TH>
            <TH align="right">Mark</TH>
            <TH align="right">Value</TH>
            <TH align="right">Unrealized</TH>
          </tr>
        </THead>
        <tbody>
          {portfolio.positions.length === 0 ? <EmptyRow colSpan={6}>Flat. No open positions.</EmptyRow> : null}
          {portfolio.positions.map((p) => (
            <TR key={p.asset}>
              <TD>{p.asset}</TD>
              <TD align="right">{fmtAmount(p.qty, 6)}</TD>
              <TD align="right">{fmtUsd(p.avgPriceUsd, 2)}</TD>
              <TD align="right">{fmtUsd(p.markPriceUsd, 2)}</TD>
              <TD align="right">{fmtUsd(p.valueUsd, 2)}</TD>
              <TD align="right" className={pnlClass(p.unrealizedPnlUsd)}>
                {fmtUsdSigned(p.unrealizedPnlUsd)}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
