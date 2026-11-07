import { describe, expect, test } from "bun:test";
import { COINBASE_PRODUCTS } from "@arena/shared";
import { createMarketData, fetchCandles, MARKET_CACHE_MS } from "./market.ts";
import { fixedClock, NOW } from "./test-fixtures.ts";

// Coinbase rows are [time, low, high, open, close, volume], newest first.
const ROWS = [
  [1_700_000_600, 1990, 2010, 2000, 2005, 12],
  [1_700_000_300, 1980, 2000, 1990, 1995, 10],
];

function coinbase(rows: unknown[] = ROWS) {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  return { fetchFn, urls };
}

describe("fetchCandles", () => {
  test("maps WETH to ETH-USD, returns oldest first, and converts seconds to ms", async () => {
    const { fetchFn, urls } = coinbase();
    const candles = await fetchCandles("WETH", fetchFn);
    expect(urls[0]).toBe("https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=300");
    expect(candles.map((c) => c.t)).toEqual([1_700_000_300_000, 1_700_000_600_000]);
    expect(candles[1]).toEqual({ t: 1_700_000_600_000, o: 2000, h: 2010, l: 1990, c: 2005, v: 12 });
  });

  test("maps cbBTC to BTC-USD and rejects unknown assets", async () => {
    expect(COINBASE_PRODUCTS.cbBTC).toBe("BTC-USD");
    const { fetchFn, urls } = coinbase();
    await fetchCandles("cbBTC", fetchFn);
    expect(urls[0]).toContain("/products/BTC-USD/");
    await expect(fetchCandles("USDC", fetchFn)).rejects.toThrow("no market-data product");
  });

  test("every new token fetches its own Coinbase product", async () => {
    for (const [asset, product] of [
      ["AERO", "AERO-USD"],
      ["VIRTUAL", "VIRTUAL-USD"],
      ["DEGEN", "DEGEN-USD"],
      ["TOSHI", "TOSHI-USD"],
      ["WELL", "WELL-USD"],
      ["ZORA", "ZORA-USD"],
    ] as const) {
      const { fetchFn, urls } = coinbase();
      const candles = await fetchCandles(asset, fetchFn);
      expect(urls[0]).toBe(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=300`);
      expect(candles).toHaveLength(2);
    }
  });

  test("a non-2xx response is an error", async () => {
    const fetchFn = async () => new Response("nope", { status: 503 });
    await expect(fetchCandles("WETH", fetchFn)).rejects.toThrow("HTTP 503");
  });
});

describe("createMarketData", () => {
  test("uses the Chainlink price when the feed answers, and computes indicators from the candles", async () => {
    const { fetchFn } = coinbase();
    const market = createMarketData({
      feed: async () => ({ priceUsd: 2001.5, updatedAt: NOW }),
      fetch: fetchFn,
      clock: fixedClock(),
    });
    const snap = await market.getSnapshot("WETH");
    expect(snap.priceUsd).toBe(2001.5);
    expect(snap.candles).toHaveLength(2);
    expect(Number.isFinite(snap.indicators.rsi14)).toBe(true);
  });

  test("falls back to the last candle close when the feed fails", async () => {
    const { fetchFn } = coinbase();
    const market = createMarketData({
      feed: async () => {
        throw new Error("rpc down");
      },
      fetch: fetchFn,
      clock: fixedClock(),
    });
    expect((await market.getSnapshot("WETH")).priceUsd).toBe(2005);
    expect(await market.getPrice("WETH")).toBe(2005);
  });

  test("skips the Chainlink read for assets with no feed on the chain, and uses the candle close", async () => {
    const { fetchFn } = coinbase();
    const reads: string[] = [];
    const market = createMarketData({
      feed: async (asset) => {
        reads.push(asset);
        return { priceUsd: 1, updatedAt: NOW };
      },
      hasFeed: (asset) => asset === "WETH",
      fetch: fetchFn,
      clock: fixedClock(),
    });
    expect((await market.getSnapshot("DEGEN")).priceUsd).toBe(2005);
    expect(await market.getPrice("AERO")).toBe(2005);
    expect(reads).toEqual([]);
    expect((await market.getSnapshot("WETH")).priceUsd).toBe(1);
    expect(reads).toEqual(["WETH"]);
  });

  test("caches snapshots for 30 s", async () => {
    const { fetchFn, urls } = coinbase();
    const clock = fixedClock();
    const market = createMarketData({ feed: null, fetch: fetchFn, clock });
    await market.getSnapshot("WETH");
    await market.getSnapshot("WETH");
    expect(urls).toHaveLength(1);
    clock.advance(MARKET_CACHE_MS + 1);
    await market.getSnapshot("WETH");
    expect(urls).toHaveLength(2);
  });
});
