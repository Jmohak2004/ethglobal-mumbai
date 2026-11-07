// Market data: 5-minute candles from the public Coinbase Exchange API, mark price from the Chainlink
// feed on the configured chain (falling back to the last candle close), and deterministic indicators.
// Results are cached for 30 s per asset. The fetch, the feed read and the clock are all injected.

import { computeIndicators } from "@arena/policy";
import { COINBASE_PRODUCTS, type Candle, type MarketSnapshot } from "@arena/shared";
import { parseAbi, type PublicClient } from "viem";
import type { Clock, MarketData } from "./deps.ts";
import type { ChainConfig } from "./chain.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export const COINBASE_API_URL = "https://api.exchange.coinbase.com";
export const CANDLE_GRANULARITY_SEC = 300;
export const MARKET_CACHE_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads the Chainlink USD price of an asset on the configured chain. */
export type FeedReader = (asset: string) => Promise<{ priceUsd: number; updatedAt: number }>;

/** Fetches up to 300 recent 5-minute candles, oldest first. Coinbase rows are [time, low, high, open, close, volume], newest first. */
export async function fetchCandles(asset: string, fetchFn: FetchLike): Promise<Candle[]> {
  const product = COINBASE_PRODUCTS[asset];
  if (!product) throw new Error(`no market-data product for asset ${asset}`);
  const url = `${COINBASE_API_URL}/products/${product}/candles?granularity=${CANDLE_GRANULARITY_SEC}`;
  const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Coinbase candles for ${product} returned HTTP ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Coinbase candles for ${product} returned no array`);

  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, low, high, open, close, volume] = row.map(Number);
    if ([time, low, high, open, close, volume].every(Number.isFinite)) {
      candles.push({ t: (time as number) * 1000, o: open as number, h: high as number, l: low as number, c: close as number, v: volume as number });
    }
  }
  return candles.sort((a, b) => a.t - b.t);
}

const AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/** Chainlink AggregatorV3 reader for the feeds listed in the chain's token registry. */
export function chainlinkFeedReader(client: PublicClient, chain: ChainConfig): FeedReader {
  return async (asset) => {
    const feed = chain.tokens[asset]?.usdFeed;
    if (!feed) throw new Error(`no Chainlink USD feed for ${asset} on ${chain.name}`);
    const [round, decimals] = await Promise.all([
      client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
      client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: "decimals" }),
    ]);
    const answer = round[1];
    if (answer <= 0n) throw new Error(`Chainlink feed for ${asset} returned a non-positive answer`);
    return { priceUsd: Number(answer) / 10 ** Number(decimals), updatedAt: Number(round[3]) * 1000 };
  };
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface MarketDataOptions {
  /** Null when no RPC is configured. The candle close is used as the price. */
  feed: FeedReader | null;
  /** Whether the configured chain has a Chainlink feed for this asset. Assets without one skip the feed read. */
  hasFeed?: (asset: string) => boolean;
  fetch?: FetchLike;
  clock: Clock;
  logger?: Logger;
  cacheMs?: number;
}

export function createMarketData(opts: MarketDataOptions): MarketData {
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const logger = opts.logger ?? silentLogger;
  const cacheMs = opts.cacheMs ?? MARKET_CACHE_MS;
  const snapshots = new Map<string, CacheEntry<MarketSnapshot>>();
  const prices = new Map<string, CacheEntry<number>>();

  const fresh = <T>(entry: CacheEntry<T> | undefined): T | null =>
    entry && opts.clock.now() - entry.at < cacheMs ? entry.value : null;

  async function feedPrice(asset: string): Promise<number | null> {
    if (!opts.feed || (opts.hasFeed && !opts.hasFeed(asset))) return null;
    try {
      const { priceUsd } = await opts.feed(asset);
      return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
    } catch (err) {
      logger.warn("chainlink feed read failed, using candle close", { asset, error: err });
      return null;
    }
  }

  return {
    async getSnapshot(asset) {
      const cached = fresh(snapshots.get(asset));
      if (cached) return cached;

      const candles = await fetchCandles(asset, fetchFn);
      const last = candles[candles.length - 1];
      if (!last) throw new Error(`no candles returned for ${asset}`);
      const priceUsd = (await feedPrice(asset)) ?? last.c;
      const snapshot: MarketSnapshot = {
        asset,
        priceUsd,
        ts: opts.clock.now(),
        candles,
        indicators: computeIndicators(candles),
      };
      snapshots.set(asset, { at: opts.clock.now(), value: snapshot });
      return snapshot;
    },

    async getPrice(asset) {
      const cachedPrice = fresh(prices.get(asset));
      if (cachedPrice !== null) return cachedPrice;
      const cachedSnapshot = fresh(snapshots.get(asset));
      if (cachedSnapshot) return cachedSnapshot.priceUsd;

      const price = (await feedPrice(asset)) ?? (await fetchCandles(asset, fetchFn)).at(-1)?.c;
      if (!price || !Number.isFinite(price) || price <= 0) throw new Error(`no price available for ${asset}`);
      prices.set(asset, { at: opts.clock.now(), value: price });
      return price;
    },
  };
}
