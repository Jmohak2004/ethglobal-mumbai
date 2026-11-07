"use client";

import type { MarketResponse } from "@/lib/types";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtAmount, fmtPct, pnlClass, shortAddr } from "@/lib/format";

export function AssetHeader({
  market,
  assets,
  feedAddress,
  onAsset,
  activeAsset,
}: {
  market: MarketResponse;
  assets: string[];
  feedAddress: string | null;
  onAsset: (a: string) => void;
  activeAsset: string;
}) {
  // Base symbol from the Coinbase product (ETH for WETH, BTC for cbBTC, AERO for AERO-USD).
  const base = market.product.split("-")[0] ?? market.asset;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-3 py-2">
      <Segmented
        value={activeAsset}
        options={assets.map((a) => ({ value: a, label: a }))}
        onChange={onAsset}
      />
      <div className="num flex items-baseline gap-2">
        <span className="text-[18px] font-semibold">${fmtAmount(market.priceUsd, 2)}</span>
        <span className="text-[11px] text-muted">last</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px]">
        <Stat label="24h change" value={fmtPct(market.change24hPct, 2, true)} className={pnlClass(market.change24hPct)} />
        <Stat label="24h high" value={fmtAmount(market.high24h, 2)} />
        <Stat label="24h low" value={fmtAmount(market.low24h, 2)} />
        <Stat label="24h volume" value={`${fmtAmount(market.volume24h, 2)} ${market.asset}`} />
      </div>
      <div className="ml-auto">
        <Tooltip
          side="bottom"
          align="end"
          content={
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">{feedAddress ? "Chainlink Data Feed (Base)" : "No Chainlink feed on Base"}</div>
              <div className="text-muted">
                {feedAddress
                  ? "Mark price reference. Stop and TP triggers are evaluated by Flash, not by this feed."
                  : "Mark price is the last Coinbase candle close. Stop and TP triggers are evaluated by Flash."}
              </div>
              <div className="text-muted">Last price and 24h stats: Coinbase Exchange, 5m candles, refreshed every 15 s.</div>
            </div>
          }
        >
          <span className="num rounded border border-border px-2 py-1 text-[11px] text-muted">
            {feedAddress ? `Chainlink ${base}/USD · ${shortAddr(feedAddress, 6, 4)}` : `Mark: Coinbase ${market.product}`}
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
