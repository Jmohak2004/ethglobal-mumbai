"use client";

import type { MarketSnapshot } from "@arena/shared";
import { useState } from "react";

import { AiChartRead } from "@/components/trade/ai-chart-read";
import { AssetHeader } from "@/components/trade/asset-header";
import { BottomPanel } from "@/components/trade/bottom-panel";
import { OrderTicket, type TicketPrefill } from "@/components/trade/order-ticket";
import { PriceChart } from "@/components/trade/price-chart";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import type { TradingActivity } from "@/lib/data";

interface Props {
  markets: MarketSnapshot[];
  activity: TradingActivity;
  feeds: Record<string, string | null>;
}

/** Hyperliquid-style terminal: asset header, chart + bottom panel on the left, order ticket on the right. */
export function TradeTerminal({ markets, activity, feeds }: Props) {
  const [asset, setAsset] = useState<string>(markets[0]?.asset ?? "WETH");
  const [aiOpen, setAiOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ nonce: number; values: TicketPrefill } | null>(null);

  const market = markets.find((m) => m.asset === asset) ?? markets[0];
  if (!market) {
    return <div className="px-4 py-6 text-muted">No market data available.</div>;
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <AssetHeader
            market={market}
            assets={markets.map((m) => m.asset)}
            feedAddress={feeds[market.asset] ?? null}
            onAsset={setAsset}
            activeAsset={market.asset}
          />
        </div>
        <Button variant="secondary" className="h-9" onClick={() => setAiOpen(true)}>
          AI chart read
        </Button>
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title={`${market.asset} · 1h candles`}>
            <div className="h-[420px] p-2">
              <PriceChart candles={market.candles} />
            </div>
          </Panel>
          <BottomPanel activity={activity} />
        </div>

        <OrderTicket
          key={`${market.asset}-${prefill?.nonce ?? 0}`}
          asset={market.asset}
          markPrice={market.priceUsd}
          prefill={prefill?.values ?? null}
        />
      </div>

      <AiChartRead
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        market={market}
        onPrefill={(values) => setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, values }))}
      />
    </div>
  );
}
