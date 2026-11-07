import { Badge } from "@/components/ui/badge";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { fmtAmount, fmtDateTime, fmtUsd, fmtUsdSigned, pnlClass } from "@/lib/format";
import type { PortfolioSnapshot } from "@/lib/types";

/** Owner-only paper book from the worker's runtime snapshot: cash, positions, equity and PnL. */
export function PaperPortfolioCard({ portfolio }: { portfolio: PortfolioSnapshot | null | undefined }) {
  if (!portfolio) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm text-muted">
        <div>
          <Badge tone="warn">Paper</Badge>
        </div>
        No snapshot yet. It appears after the agent makes its first decision.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge tone="warn">Paper</Badge>
        <span className="num text-xs text-muted">as of {fmtDateTime(portfolio.asOf)}</span>
      </div>

      <dl className="num grid grid-cols-2 gap-y-2 text-sm [&_dt]:font-sans">
        <dt className="text-muted">Cash</dt>
        <dd className="text-right">{fmtUsd(portfolio.cashUsd, 2)}</dd>
        <dt className="text-muted">Equity</dt>
        <dd className="text-right font-medium">{fmtUsd(portfolio.equityUsd, 2)}</dd>
        <dt className="text-muted">Profit taken</dt>
        <dd className={`text-right ${pnlClass(portfolio.realizedPnlUsd)}`}>{fmtUsdSigned(portfolio.realizedPnlUsd)}</dd>
        <dt className="text-muted">Profit on open trades</dt>
        <dd className={`text-right ${pnlClass(portfolio.unrealizedPnlUsd)}`}>{fmtUsdSigned(portfolio.unrealizedPnlUsd)}</dd>
      </dl>

      <Table bare>
        <THead>
          <tr>
            <TH>Asset</TH>
            <TH align="right">Qty</TH>
            <TH align="right">Avg price</TH>
            <TH align="right">Now</TH>
            <TH align="right">Value</TH>
            <TH align="right">Gain or loss</TH>
          </tr>
        </THead>
        <tbody>
          {portfolio.positions.length === 0 ? <EmptyRow colSpan={6}>No open positions right now.</EmptyRow> : null}
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
