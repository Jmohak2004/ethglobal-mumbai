"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { categoryOf } from "@/lib/live/categories";
import type { FeedStatus, Ticker } from "@/lib/live/coinbase-ticker";
import { formatCompact, formatPrice, formatUsdPrice } from "@/lib/live/price-format";
import { fmtPct, pnlClass, shortAddr } from "@/lib/format";
import type { MarketResponse } from "@/lib/types";

/**
 * Header for the selected market. Price, change, range, volume, bid and ask come from the live ticker when it has
 * arrived, and from the REST candle snapshot until then.
 */
export function AssetHeader({
  asset,
  product,
  market,
  ticker,
  status,
  feedAddress,
}: {
  asset: string;
  product: string;
  market: MarketResponse | null;
  ticker: Ticker | null;
  status: FeedStatus;
  feedAddress: string | null;
}) {
  const price = ticker?.price ?? market?.priceUsd ?? null;
  const change = ticker?.change24hPct ?? market?.change24hPct ?? null;
  const high = ticker?.high24h ?? market?.high24h ?? null;
  const low = ticker?.low24h ?? market?.low24h ?? null;
  const volume = ticker?.volume24h ?? market?.volume24h ?? null;
  const dir = ticker?.dir ?? "flat";
  const priceClass = dir === "up" ? "text-long" : dir === "down" ? "text-short" : "text-text";
  // Base symbol from the Coinbase product (ETH for WETH, BTC for cbBTC).
  const base = product.split("-")[0] ?? asset;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-panel px-5 py-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold tracking-[-0.015em]">{asset}</h1>
        <span className="num text-xs text-muted">{product}</span>
        <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-inset ring-border">
          {categoryOf(asset)}
        </span>
      </div>
      <div className="num flex items-baseline gap-2">
        <span className={`text-2xl font-medium ${priceClass}`}>{price === null ? "—" : formatUsdPrice(price)}</span>
        <span className="font-sans text-xs text-muted">last price</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Stat
          label="24h change"
          value={change === null ? "—" : fmtPct(change, 2, true)}
          className={change === null ? undefined : pnlClass(change)}
        />
        <Stat label="24h high" value={high === null ? "—" : formatPrice(high)} />
        <Stat label="24h low" value={low === null ? "—" : formatPrice(low)} />
        <Stat label={`24h volume (${base})`} value={volume === null ? "—" : formatCompact(volume)} />
        <Stat label="Bid" value={ticker?.bid != null ? formatPrice(ticker.bid) : "—"} className="text-long" />
        <Stat label="Ask" value={ticker?.ask != null ? formatPrice(ticker.ask) : "—"} className="text-short" />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <FeedPill status={status} />
        <Tooltip
          side="bottom"
          align="end"
          content={
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">{feedAddress ? "Chainlink Data Feed (Base)" : "No Chainlink feed on Base"}</div>
              <div className="opacity-80">
                Mark for the order ticket is the last Coinbase trade price. Stop and TP triggers are evaluated by Flash,
                not by this feed.
              </div>
              <div className="opacity-80">
                Price streams from the Coinbase Exchange ticker channel. If the socket is blocked, it polls every 15 s.
              </div>
            </div>
          }
        >
          <span className="num rounded-md bg-panel-2 px-2 py-1 text-xs text-muted ring-1 ring-inset ring-border">
            {feedAddress ? `Chainlink ${base}/USD · ${shortAddr(feedAddress, 6, 4)}` : `Mark: Coinbase ${product}`}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

function FeedPill({ status }: { status: FeedStatus }) {
  const live = status === "open";
  const label = live ? "Live" : status === "connecting" ? "Connecting" : status === "down" ? "Polling 15 s" : "Paused";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-panel-2 px-2 py-1 text-xs text-muted ring-1 ring-inset ring-border">
      <span aria-hidden className={`size-1.5 rounded-full ${live ? "bg-long" : "bg-subtle"}`} />
      {label}
    </span>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className={`num ${className ?? "text-text"}`}>{value}</span>
    </div>
  );
}
