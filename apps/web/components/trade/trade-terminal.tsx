"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { AiChartRead } from "@/components/trade/ai-chart-read";
import { AssetHeader } from "@/components/trade/asset-header";
import { BottomPanel } from "@/components/trade/bottom-panel";
import { MarketsList } from "@/components/trade/markets-list";
import { OrderTicket, type TicketPrefill } from "@/components/trade/order-ticket";
import { PriceChart } from "@/components/trade/price-chart";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { getJson } from "@/lib/api";
import { INTERVALS, intervalLabel } from "@/lib/live/intervals";
import { useFeedStatus, useLiveProducts, useMarketsFeed, useThrottledPrice, useTicker } from "@/lib/live/use-live";
import type { MarketResponse, TradingActivity } from "@/lib/types";

/** Candles poll every 15 s (10 s on 1m). The server caches upstream for 10-30 s. Ticks update the chart in between. */
const POLL_MS = 15_000;
const POLL_1M_MS = 10_000;

interface Props {
  /** Platform allowlist with a Coinbase product, in display order. */
  assets: string[];
  /** Coinbase product per asset, e.g. WETH -> ETH-USD. */
  products: Record<string, string>;
  /** Chainlink feed per asset, or null. */
  feeds: Record<string, string | null>;
  /** The selected market's first paint, from the server. */
  initial: { asset: string; granularity: number; market: MarketResponse | null };
  activity: TradingActivity;
}

/** Writes the selection into the URL without a navigation, so a reload or shared link opens the same market. */
function syncUrl(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  window.history.replaceState(window.history.state, "", url);
}

/** Hyperliquid-style terminal: markets list, live header, chart, order ticket. Prices stream over one WebSocket. */
export function TradeTerminal({ assets, products, feeds, initial, activity }: Props) {
  const [asset, setAsset] = useState(initial.asset);
  const [granularity, setGranularity] = useState(initial.granularity);
  const [aiOpen, setAiOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ nonce: number; values: TicketPrefill } | null>(null);

  const product = products[asset] ?? null;
  // Subscribe to every market so the list stays live. The socket carries all of them.
  useLiveProducts(assets.map((a) => products[a]).filter((p): p is string => Boolean(p)));
  useMarketsFeed();
  const status = useFeedStatus();
  const ticker = useTicker(product);
  // The order ticket reads a mark at most once a second, so trades do not re-render the whole terminal.
  const mark = useThrottledPrice(product);

  const market = useQuery({
    queryKey: ["market", asset, granularity],
    queryFn: () => getJson<MarketResponse>(`/api/market?asset=${encodeURIComponent(asset)}&granularity=${granularity}`),
    initialData:
      initial.market && initial.market.asset === asset && initial.market.granularity === granularity
        ? initial.market
        : undefined,
    refetchInterval: granularity === 60 ? POLL_1M_MS : POLL_MS,
    retry: 1,
  });
  const data = market.data ?? null;
  const orderMark = mark ?? data?.priceUsd ?? null;

  const selectAsset = useCallback((next: string) => {
    setAsset(next);
    syncUrl({ asset: next });
  }, []);

  const selectInterval = (seconds: number) => {
    setGranularity(seconds);
    syncUrl({ interval: intervalLabel(seconds) });
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <AssetHeader
        asset={asset}
        product={product ?? asset}
        market={data}
        ticker={ticker}
        status={status}
        feedAddress={feeds[asset] ?? null}
      />

      <div className="grid items-start gap-3 xl:grid-cols-[240px_minmax(0,1fr)_340px]">
        <MarketsList assets={assets} products={products} active={asset} onSelect={selectAsset} />

        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title={`${asset} · ${intervalLabel(granularity)} candles`}
            right={
              <div className="flex items-center gap-2">
                <Segmented
                  value={String(granularity)}
                  options={INTERVALS.map((i) => ({ value: String(i.seconds), label: i.label }))}
                  onChange={(v) => selectInterval(Number(v))}
                />
                <Button variant="secondary" size="sm" disabled={!data} onClick={() => setAiOpen(true)}>
                  AI chart read
                </Button>
              </div>
            }
          >
            <div className="h-[420px] p-2">
              {data && product ? (
                <PriceChart asset={asset} product={data.product} granularity={granularity} candles={data.candles} />
              ) : (
                <div className="grid h-full place-items-center text-[12px] text-muted">
                  {market.isError ? "Market data is unavailable. Retrying automatically." : "Loading market data…"}
                </div>
              )}
            </div>
          </Panel>
          <BottomPanel activity={activity} />
        </div>

        {orderMark !== null ? (
          <OrderTicket
            key={`${asset}-${prefill?.nonce ?? 0}`}
            asset={asset}
            markPrice={orderMark}
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
