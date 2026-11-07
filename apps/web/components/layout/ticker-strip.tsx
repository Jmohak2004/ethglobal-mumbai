"use client";

import { TvWidget } from "@/components/tradingview/tv-widget";
import { TV_TAPE_SYMBOLS } from "@/lib/tradingview";

/** Slim TradingView ticker tape under the top nav, on every page. Prices for the Base tokens ARENA trades. */
export function TickerStrip() {
  return (
    <div className="border-b border-border bg-panel">
      <TvWidget
        widget="ticker-tape"
        label="Live crypto prices"
        className="h-[84px]"
        config={{ symbols: TV_TAPE_SYMBOLS, showSymbolLogo: true, displayMode: "compact" }}
      />
    </div>
  );
}
