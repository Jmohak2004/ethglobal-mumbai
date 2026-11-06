// Live candles for /trade from Coinbase Exchange public market data. Server-only.
// Coinbase rows are [time, low, high, open, close, volume], newest first. Output is ascending Candle[] with
// unix-ms times. A 30 s in-memory cache per asset and granularity keeps us well under the public rate limit.
import type { Candle, Indicators } from "@arena/shared";

import { ApiError } from "@/lib/server/errors";
import type { MarketResponse } from "@/lib/types";

const COINBASE_EXCHANGE = "https://api.exchange.coinbase.com";
/** Allowlisted trade assets mapped to their Coinbase Exchange product. */
const PRODUCT: Record<string, string> = { WETH: "ETH-USD", cbBTC: "BTC-USD" };
/** Granularities Coinbase accepts (seconds). */
export const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400] as const;
export const DEFAULT_GRANULARITY = 300;

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const DAY_MS = 86_400_000;

interface CacheEntry {
  at: number;
  value: MarketResponse;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MarketResponse>>();

export function isTradeAsset(asset: string): boolean {
  return Object.hasOwn(PRODUCT, asset);
}

export function isGranularity(n: number): n is (typeof GRANULARITIES)[number] {
  return (GRANULARITIES as readonly number[]).includes(n);
}

/**
 * Market snapshot for one allowlisted asset. Serves the cached value for 30 s. If Coinbase fails and an older
 * value exists, the older value is served instead of an error. Throws ApiError(502) when there is nothing to serve.
 */
export async function loadMarket(asset: string, granularity: number = DEFAULT_GRANULARITY): Promise<MarketResponse> {
  const product = Object.hasOwn(PRODUCT, asset) ? PRODUCT[asset] : undefined;
  if (!product) throw new ApiError(404, "NOT_FOUND", `Unknown asset ${asset}`);
  const key = `${asset}:${granularity}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchMarket(asset, product, granularity)
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
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

async function fetchMarket(asset: string, product: string, granularity: number): Promise<MarketResponse> {
  const url = `${COINBASE_EXCHANGE}/products/${product}/candles?granularity=${granularity}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "arena-web" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "UPSTREAM", "Market data is unreachable right now");
  }
  if (!res.ok) throw new ApiError(502, "UPSTREAM", `Market data returned ${res.status}`);

  const candles = parseCandles(await res.json().catch(() => null));
  const last = candles.at(-1);
  if (!last) throw new ApiError(502, "UPSTREAM", "Market data returned no candles");

  // 24h stats from the candles themselves: window is the last 24 h, reference price is the bar open 24 h back.
  const windowStart = last.t - DAY_MS;
  const window = candles.filter((c) => c.t > windowStart);
  const ref = [...candles].reverse().find((c) => c.t <= windowStart) ?? candles[0] ?? last;
  const change24hPct = ref.o > 0 ? ((last.c - ref.o) / ref.o) * 100 : 0;

  return {
    asset,
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
