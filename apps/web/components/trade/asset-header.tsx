"use client";

import type { Candle, MarketSnapshot } from "@arena/shared";

import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtAmount, fmtCompactUsd, fmtPct, pnlClass, shortAddr } from "@/lib/format";

const FEED_LABEL: Record<string, string> = { WETH: "ETH/USD", cbBTC: "BTC/USD" };

/** Derives 24h stats from the 1h candles (last 24 bars). */
export function dayStats(candles: Candle[]) {
  const last = candles.slice(-24);
  const first = candles[candles.length - 25] ?? candles[0];
  const lastBar = candles[candles.length - 1];
  if (!first || !lastBar || last.length === 0) return null;
  return {
    change: ((lastBar.c - first.c) / first.c) * 100,
    high: Math.max(...last.map((c) => c.h)),
    low: Math.min(...last.map((c) => c.l)),
    volumeAsset: last.reduce((a, c) => a + c.v, 0),
  };
}

export function AssetHeader({
  market,
  assets,
  feedAddress,
  onAsset,
  activeAsset,
}: {
  market: MarketSnapshot;
  assets: string[];
  feedAddress: string | null;
  onAsset: (a: string) => void;
  activeAsset: string;
}) {
  const stats = dayStats(market.candles);
  const feedLabel = FEED_LABEL[market.asset] ?? "USD";
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-3 py-2">
      <Segmented
        value={activeAsset}
        options={assets.map((a) => ({ value: a, label: a }))}
        onChange={onAsset}
      />
      <div className="num flex items-baseline gap-2">
        <span className="text-[18px] font-semibold">${fmtAmount(market.priceUsd, 2)}</span>
        <span className="text-[11px] text-muted">mark</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px]">
        <Stat label="24h change" value={stats ? fmtPct(stats.change, 2, true) : "n/a"} className={stats ? pnlClass(stats.change) : undefined} />
        <Stat label="24h high" value={stats ? fmtAmount(stats.high, 2) : "n/a"} />
        <Stat label="24h low" value={stats ? fmtAmount(stats.low, 2) : "n/a"} />
        <Stat label={`24h vol (${market.asset})`} value={stats ? fmtCompactUsd(stats.volumeAsset) : "n/a"} />
      </div>
      <div className="ml-auto">
        <Tooltip
          side="bottom"
          align="end"
          content={
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">Chainlink Data Feed (Base)</div>
              <div className="text-muted">
                Mark price reference. Stop and TP triggers are evaluated by Flash, not by this feed.
              </div>
            </div>
          }
        >
          <span className="num rounded border border-border px-2 py-1 text-[11px] text-muted">
            Chainlink {feedLabel}
            {feedAddress ? ` · ${shortAddr(feedAddress, 6, 4)}` : ""}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`num ${className ?? "text-text"}`}>{value}</span>
    </div>
  );
}
