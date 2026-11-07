"use client";

import { TvWidget } from "@/components/tradingview/tv-widget";

/** TradingView crypto coins heatmap: block size is market cap, colour is 24h change. Fills its parent's height. */
export function CryptoHeatmap({ className }: { className?: string }) {
  return (
    <TvWidget
      widget="crypto-coins-heatmap"
      label="Crypto market heatmap"
      lazy
      className={className}
      config={{
        dataSource: "Crypto",
        blockSize: "market_cap_calc",
        blockColor: "24h_close_change|5",
        symbolUrl: "",
        hasTopBar: false,
        isDataSetEnabled: false,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        isMonoSize: false,
      }}
    />
  );
}

/**
 * TradingView news. A symbol (COINBASE:ETHUSD) shows that asset's stories. Null falls back to the market-wide crypto feed,
 * which is also what the landing page uses. The widget re-renders whenever the symbol changes.
 */
export function CryptoNews({ symbol = null, className }: { symbol?: string | null; className?: string }) {
  return (
    <TvWidget
      widget="timeline"
      label={symbol ? `News for ${symbol.split(":")[1]}` : "Crypto market news"}
      lazy
      className={className}
      config={
        symbol
          ? { feedMode: "symbol", symbol, displayMode: "regular" }
          : { feedMode: "market", market: "crypto", displayMode: "regular" }
      }
    />
  );
}
