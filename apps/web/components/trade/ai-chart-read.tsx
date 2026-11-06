"use client";

import type { MarketSnapshot } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { TicketPrefill } from "@/components/trade/order-ticket";
import { fmtAmount, fmtPct } from "@/lib/format";

/**
 * "AI chart read". Stub: the structured read is derived from the indicators on the snapshot.
 * The 0G vision model (user-side credits, chart upload) is not connected yet.
 */
export function AiChartRead({
  open,
  onClose,
  market,
  onPrefill,
}: {
  open: boolean;
  onClose: () => void;
  market: MarketSnapshot;
  onPrefill: (p: TicketPrefill) => void;
}) {
  const ind = market.indicators;
  const px = market.priceUsd;
  const trend = ind.emaFast > ind.emaSlow ? "Uptrend (EMA12 above EMA26)" : "Downtrend (EMA12 below EMA26)";
  const rsiState = ind.rsi14 >= 70 ? "overbought" : ind.rsi14 <= 30 ? "oversold" : "neutral";
  const entry = Math.round(px * 0.998 * 100) / 100;
  const tp = Math.round((px + 1.5 * ind.atr14) * 100) / 100;
  const sl = Math.round((px - 1 * ind.atr14) * 100) / 100;

  return (
    <Modal open={open} onClose={onClose} title={`AI chart read · ${market.asset} 1h`} width="max-w-lg">
      <div className="flex flex-col gap-3 text-[12.5px]">
        <Badge tone="warn">Stub: vision model not connected</Badge>
        <dl className="num grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted">Trend</dt>
          <dd>{trend}</dd>
          <dt className="text-muted">Momentum (ROC)</dt>
          <dd>{fmtPct(ind.rocPct, 2, true)} over 10 bars</dd>
          <dt className="text-muted">RSI(14)</dt>
          <dd>
            {fmtAmount(ind.rsi14, 1)} · {rsiState}
          </dd>
          <dt className="text-muted">Range (20 bars)</dt>
          <dd>
            {fmtAmount(ind.rangeLow, 2)} to {fmtAmount(ind.rangeHigh, 2)}
          </dd>
          <dt className="text-muted">Volatility</dt>
          <dd>{fmtPct(ind.volatilityPct, 2)} per bar (stdev)</dd>
        </dl>
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted">Suggested bracket</div>
          <dl className="num grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-[10px] text-muted">Entry</dt>
              <dd>{fmtAmount(entry, 2)}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted">Take-profit</dt>
              <dd className="text-long">{fmtAmount(tp, 2)}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted">Stop-loss</dt>
              <dd className="text-short">{fmtAmount(sl, 2)}</dd>
            </div>
          </dl>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Dismiss
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onPrefill({ limitPx: entry, tpPx: tp, slPx: sl });
              onClose();
            }}
          >
            Prefill ticket
          </Button>
        </div>
      </div>
    </Modal>
  );
}
