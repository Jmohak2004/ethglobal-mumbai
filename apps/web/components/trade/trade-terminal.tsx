"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AiChartRead } from "@/components/trade/ai-chart-read";
import { AssetHeader } from "@/components/trade/asset-header";
import { BottomPanel } from "@/components/trade/bottom-panel";
import { OrderTicket, type TicketPrefill } from "@/components/trade/order-ticket";
import { PriceChart } from "@/components/trade/price-chart";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { getJson } from "@/lib/api";
import type { MarketResponse, TradingActivity } from "@/lib/types";

/** 5-minute candles, polled every 15 s. The server caches upstream for 30 s. */
const GRANULARITY = 300;
const POLL_MS = 15_000;

interface Props {
  /** Platform allowlist with market data, in display order. */
  assets: string[];
  initialMarkets: Record<string, MarketResponse | null>;
  activity: TradingActivity;
  feeds: Record<string, string | null>;
}

/** Hyperliquid-style terminal: asset header, chart + bottom panel on the left, order ticket on the right. */
export function TradeTerminal({ assets, initialMarkets, activity, feeds }: Props) {
  const [asset, setAsset] = useState<string>(assets[0] ?? "WETH");
  const [aiOpen, setAiOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ nonce: number; values: TicketPrefill } | null>(null);

  const market = useQuery({
    queryKey: ["market", asset, GRANULARITY],
    queryFn: () => getJson<MarketResponse>(`/api/market?asset=${encodeURIComponent(asset)}&granularity=${GRANULARITY}`),
    initialData: initialMarkets[asset] ?? undefined,
    refetchInterval: POLL_MS,
    retry: 1,
  });
  const data = market.data ?? null;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          {data ? (
            <AssetHeader
              market={data}
              assets={assets}
              feedAddress={feeds[data.asset] ?? null}
              onAsset={setAsset}
              activeAsset={asset}
            />
          ) : (
            <Segmented value={asset} options={assets.map((a) => ({ value: a, label: a }))} onChange={setAsset} />
          )}
        </div>
        <Button variant="secondary" className="h-9" disabled={!data} onClick={() => setAiOpen(true)}>
          AI chart read
        </Button>
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title={`${asset} · 5m candles`}>
            <div className="h-[420px] p-2">
              {data ? (
                <PriceChart asset={asset} candles={data.candles} />
              ) : (
                <div className="grid h-full place-items-center text-[12px] text-muted">
                  {market.isError ? "Market data is unavailable. Retrying every 15 s." : "Loading market data…"}
                </div>
              )}
            </div>
          </Panel>
          <BottomPanel activity={activity} />
        </div>

        {data ? (
          <OrderTicket
            key={`${asset}-${prefill?.nonce ?? 0}`}
            asset={asset}
            markPrice={data.priceUsd}
            prefill={prefill?.values ?? null}
          />
        ) : (
          <Panel title="Order ticket">
            <div className="p-3 text-[12px] text-muted">The ticket opens once a live mark price is available.</div>
          </Panel>
        )}
      </div>

      {data ? (
        <AiChartRead
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          market={data}
          onPrefill={(values) => setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, values }))}
        />
      ) : null}
    </div>
  );
}
