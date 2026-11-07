"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { getJson } from "@/lib/api";
import { coinbaseFeed, type FeedStatus, type Ticker } from "@/lib/live/coinbase-ticker";
import type { MarketsResponse } from "@/lib/live/types";

const serverIdle = (): FeedStatus => "idle";
const subscribeStatus = (cb: () => void) => coinbaseFeed.subscribeStatus(cb);
const readStatus = (): FeedStatus => coinbaseFeed.getStatus();
const noop = () => {};

/** Keeps the given Coinbase products subscribed while the calling component is mounted. */
export function useLiveProducts(products: readonly string[]): void {
  const key = products.join(",");
  useEffect(() => {
    if (!key) return;
    return coinbaseFeed.acquire(key.split(","));
  }, [key]);
}

/** Socket state: idle, connecting, open (live) or down (REST polling until the socket recovers). */
export function useFeedStatus(): FeedStatus {
  return useSyncExternalStore(subscribeStatus, readStatus, serverIdle);
}

/** Latest ticker for one product, re-rendering on every tick. Null until the first ws tick or REST seed. */
export function useTicker(product: string | null): Ticker | null {
  const subscribe = useCallback(
    (cb: () => void) => (product ? coinbaseFeed.subscribeTicker(product, cb) : noop),
    [product],
  );
  const snapshot = useCallback(() => (product ? coinbaseFeed.getTicker(product) : null), [product]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * Last price for one product, updated at most once per `ms`. For components that only need a mark (order ticket),
 * so they do not re-render on every trade.
 */
export function useThrottledPrice(product: string | null, ms = 1_000): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!product) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const t = coinbaseFeed.getTicker(product);
      if (t) setPrice(t.price);
    };
    const unsubscribe = coinbaseFeed.subscribeTicker(product, () => {
      if (timer === undefined) timer = setTimeout(flush, ms);
    });
    flush();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [product, ms]);
  return price;
}

/**
 * Initial 24h stats for every platform asset from GET /api/markets, then REST fallback. While the socket is open
 * this refreshes once a minute. While it is down, it polls every 15 s. Each response seeds the shared feed store.
 */
export function useMarketsFeed() {
  const status = useFeedStatus();
  const query = useQuery({
    queryKey: ["markets"],
    queryFn: () => getJson<MarketsResponse>("/api/markets"),
    refetchInterval: status === "open" ? 60_000 : 15_000,
    retry: 1,
  });
  const markets = query.data?.markets;
  useEffect(() => {
    if (markets) coinbaseFeed.seed(markets);
  }, [markets]);
  return query;
}
