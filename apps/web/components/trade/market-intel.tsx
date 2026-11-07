"use client";

import { useState } from "react";

import { CryptoHeatmap, CryptoNews } from "@/components/tradingview/tv-panels";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { tvSymbolForProduct } from "@/lib/tradingview";

type IntelTab = "news" | "heatmap";

const TABS: TabItem<IntelTab>[] = [
  { value: "news", label: "News" },
  { value: "heatmap", label: "Market heatmap" },
];

/**
 * TradingView news for the selected asset (the crypto market feed when TradingView has no symbol for it) and the crypto
 * heatmap, as tabs under the terminal. Only the open tab mounts, and each widget waits until it is near the viewport.
 */
export function MarketIntel({ asset, product }: { asset: string; product: string | null }) {
  const [tab, setTab] = useState<IntelTab>("news");
  const symbol = tvSymbolForProduct(product);
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]" aria-label="Market news and heatmap">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4">
        <Tabs label="Market news and heatmap" value={tab} items={TABS} onChange={setTab} className="border-b-0" />
        <span className="text-xs text-muted">
          {tab === "news" ? (symbol ? `${asset} news` : `${asset} has no TradingView feed, showing crypto market news`) : "Block size is market cap, colour is 24h change"}
        </span>
      </div>
      <div className="overflow-hidden rounded-b-xl border-t border-border">
        {tab === "news" ? <CryptoNews symbol={symbol} className="h-[480px]" /> : <CryptoHeatmap className="h-[480px]" />}
      </div>
    </section>
  );
}
