// Live candles and 24h stats for /trade from Coinbase Exchange public market data. Server-only.
// Coinbase candle rows are [time, low, high, open, close, volume], newest first. Output is ascending Candle[] with
// unix-ms times. Caches are per key and short: candles 10-30 s by granularity, stats 15 s, so the public rate limit
// holds even with every tab open.
import { COINBASE_PRODUCTS, type Candle, type Indicators } from "@arena/shared";

import { env } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";
import type { MarketStats, MarketsResponse } from "@/lib/live/types";
import type { MarketResponse } from "@/lib/types";

const COINBASE_EXCHANGE = "https://api.exchange.coinbase.com";
/** Granularities Coinbase accepts (seconds). */
export const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400] as const;
export const DEFAULT_GRANULARITY = 300;

const STATS_TTL_MS = 15_000;
const STATS_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8_000;
const DAY_MS = 86_400_000;
const STALE_CANDLE_MS = 7 * DAY_MS;

/** Candle cache lifetime. Short for 1m so history stays close to the live tape. */
export function candleTtlMs(granularity: number): number {
  if (granularity <= 60) return 10_000;
  if (granularity <= 300) return 15_000;
  return 30_000;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}
const candleCache = new Map<string, CacheEntry<MarketResponse>>();
const candleInflight = new Map<string, Promise<MarketResponse>>();
const statsCache = new Map<string, CacheEntry<MarketStats>>();
const statsInflight = new Map<string, Promise<MarketStats>>();

/** True for tickers with a Coinbase product (every tradable ticker in @arena/shared). */
export function isTradeAsset(asset: string): boolean {
  return Object.hasOwn(COINBASE_PRODUCTS, asset);
}

/** Platform allowlist (ALLOWED_TOKENS) limited to tickers that have a Coinbase product, in env order. */
export function tradeAssets(): string[] {
  return env().ALLOWED_TOKENS.filter(isTradeAsset);
}

export function isGranularity(n: number): n is (typeof GRANULARITIES)[number] {
  return (GRANULARITIES as readonly number[]).includes(n);
}

/**
 * Serves a cached value while it is fresh. Otherwise it loads once (concurrent callers share the request). If the
 * load fails and an older value exists, the older value is served instead of an error.
 */
function cachedLoad<T>(
  store: Map<string, CacheEntry<T>>,
  inflight: Map<string, Promise<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);

  let pending = inflight.get(key);
  if (!pending) {
    pending = load()
      .then((value) => {
        store.set(key, { at: Date.now(), value });
        return value;
      })
      .catch((err: unknown) => {
        if (hit) return hit.value;
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * Market snapshot for one allowlisted asset at one granularity. Throws ApiError(502) when there is nothing to serve.
 */
export async function loadMarket(asset: string, granularity: number = DEFAULT_GRANULARITY): Promise<MarketResponse> {
  const product = isTradeAsset(asset) ? COINBASE_PRODUCTS[asset] : undefined;
  if (!product) throw new ApiError(404, "NOT_FOUND", `Unknown asset ${asset}`);
  return cachedLoad(candleCache, candleInflight, `${asset}:${granularity}`, candleTtlMs(granularity), () =>
    fetchMarket(asset, product, granularity),
  );
}

/** 24h stats for one allowlisted asset (Coinbase /products/{id}/stats), cached 15 s. */
export function loadStats(asset: string): Promise<MarketStats> {
  const product = isTradeAsset(asset) ? COINBASE_PRODUCTS[asset] : undefined;
  if (!product) return Promise.reject(new ApiError(404, "NOT_FOUND", `Unknown asset ${asset}`));
  return cachedLoad(statsCache, statsInflight, asset, STATS_TTL_MS, () => fetchStats(asset, product));
}

/**
 * Stats for every asset, fetched with a concurrency limit. Assets that fail are left out. Throws ApiError(502) only
 * when none succeed.
 */
export async function loadStatsForAssets(assets: readonly string[]): Promise<MarketsResponse> {
  const settled = await mapLimit(assets, STATS_CONCURRENCY, (asset) =>
    loadStats(asset).then(
      (v) => v,
      () => null,
    ),
  );
  const markets = settled.filter((m): m is MarketStats => m !== null);
  if (markets.length === 0) throw new ApiError(502, "UPSTREAM", "Market data is unavailable right now");
  const unavailable = assets.filter((_, i) => settled[i] === null);
  return { ts: Date.now(), markets, unavailable };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** GET a public Coinbase Exchange path and return the parsed JSON. Maps failures to ApiError(502). */
async function coinbaseGet(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${COINBASE_EXCHANGE}${path}`, {
      headers: { accept: "application/json", "user-agent": "arena-web" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "UPSTREAM", "Market data is unreachable right now");
  }
  if (!res.ok) throw new ApiError(502, "UPSTREAM", `Market data returned ${res.status}`);
  return res.json().catch(() => null);
}

async function fetchMarket(asset: string, product: string, granularity: number): Promise<MarketResponse> {
  const candles = parseCandles(await coinbaseGet(`/products/${product}/candles?granularity=${granularity}`));
  const last = candles.at(-1);
  if (!last) throw new ApiError(502, "UPSTREAM", "Market data returned no candles");
  // Coinbase keeps history for delisted products. A last candle this old means there is no live market.
  if (Date.now() - last.t > STALE_CANDLE_MS) throw new ApiError(502, "UPSTREAM", `No recent candles for ${product}`);

  // 24h stats from the candles themselves: window is the last 24 h, reference price is the bar open 24 h back.
  const windowStart = last.t - DAY_MS;
  const window = candles.filter((c) => c.t > windowStart);
  const ref = [...candles].reverse().find((c) => c.t <= windowStart) ?? candles[0] ?? last;
  const change24hPct = ref.o > 0 ? ((last.c - ref.o) / ref.o) * 100 : 0;

  return {
    asset,
    product,
    granularity,
    priceUsd: last.c,
    ts: Date.now(),
    candles,
    indicators: computeIndicators(candles),
    change24hPct: round(change24hPct, 2),
    high24h: Math.max(...window.map((c) => c.h)),
    low24h: Math.min(...window.map((c) => c.l)),
    volume24h: round(window.reduce((sum, c) => sum + c.v, 0), 4),
    source: "coinbase",
  };
}

async function fetchStats(asset: string, product: string): Promise<MarketStats> {
  const body = (await coinbaseGet(`/products/${product}/stats`)) as Record<string, unknown> | null;
  const last = num(body?.last);
  const open = num(body?.open);
  const high = num(body?.high);
  const low = num(body?.low);
  const volume = num(body?.volume);
  if (last === null || open === null || high === null || low === null || volume === null || last <= 0) {
    throw new ApiError(502, "UPSTREAM", `Market stats for ${product} were malformed`);
  }
  return {
    asset,
    product,
    priceUsd: last,
    open24h: open,
    high24h: high,
    low24h: low,
    volume24h: round(volume, 4),
    change24hPct: round(open > 0 ? ((last - open) / open) * 100 : 0, 2),
    ts: Date.now(),
  };
}

/** Coinbase rows to ascending candles. Malformed rows are dropped; duplicate times keep the first row. */
export function parseCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map<number, Candle>();
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, low, high, open, close, volume] = row as unknown[];
    if (![time, low, high, open, close, volume].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    const t = (time as number) * 1000;
    if (!byTime.has(t)) {
      byTime.set(t, { t, o: open as number, h: high as number, l: low as number, c: close as number, v: volume as number });
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ---- Indicators (same formulas the AI chart read uses as its baseline) ----

function round(n: number, digits = 2): number {
  return Math.round(n * 10 ** digits) / 10 ** digits;
}

function ema(vals: number[], n: number): number {
  if (vals.length === 0) return 0;
  const k = 2 / (n + 1);
  let e = vals[0] ?? 0;
  for (const v of vals) e = v * k + e * (1 - k);
  return e;
}

function rsi(vals: number[], n: number): number {
  const changes: number[] = [];
  for (let i = 1; i < vals.length; i++) changes.push((vals[i] ?? 0) - (vals[i - 1] ?? 0));
  const last = changes.slice(-n);
  const up = last.reduce((a, x) => a + Math.max(x, 0), 0) / n;
  const down = last.reduce((a, x) => a + Math.max(-x, 0), 0) / n;
  if (down === 0) return 100;
  return 100 - 100 / (1 + up / down);
}

function atr(c: Candle[], n: number): number {
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const cur = c[i];
    const prev = c[i - 1];
    if (!cur || !prev) continue;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const tail = trs.slice(-n);
  return tail.reduce((a, x) => a + x, 0) / Math.max(1, tail.length);
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeIndicators(c: Candle[]): Indicators {
  const closes = c.map((x) => x.c);
  const last = closes[closes.length - 1] ?? 0;
  const past = closes[closes.length - 11] ?? closes[0] ?? last;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] ?? 0;
    const cur = closes[i] ?? 0;
    if (prev) rets.push((cur - prev) / prev);
  }
  const tail = c.slice(-20);
  return {
    emaFast: round(ema(closes, 12), 2),
    emaSlow: round(ema(closes, 26), 2),
    rsi14: round(rsi(closes, 14), 1),
    atr14: round(atr(c, 14), 2),
    rocPct: round(past ? ((last - past) / past) * 100 : 0, 2),
    rangeHigh: round(Math.max(...tail.map((x) => x.h)), 2),
    rangeLow: round(Math.min(...tail.map((x) => x.l)), 2),
    volatilityPct: round(stdev(rets.slice(-24)) * 100, 3),
  };
}
