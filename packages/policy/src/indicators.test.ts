import { describe, expect, test } from "bun:test";
import type { Candle } from "@arena/shared";
import { computeIndicators } from "./indicators.ts";

/** Builds candles from closes. High and low sit ±halfRange around the close. */
function candlesFromCloses(closes: number[], halfRange = 0): Candle[] {
  return closes.map((c, i) => ({ t: i * 60_000, o: c, h: c + halfRange, l: c - halfRange, c, v: 1 }));
}

describe("computeIndicators", () => {
  test("empty input returns finite zeros and neutral RSI, never NaN", () => {
    const ind = computeIndicators([]);
    for (const v of Object.values(ind)) expect(Number.isFinite(v)).toBe(true);
    expect(ind.rsi14).toBe(50);
    expect(ind.emaFast).toBe(0);
    expect(ind.rangeHigh).toBe(0);
  });

  test("a few candles give finite fallbacks", () => {
    const ind = computeIndicators(candlesFromCloses([100, 101, 99]), { lookbackBars: 20, rangeBars: 20 });
    for (const v of Object.values(ind)) expect(Number.isFinite(v)).toBe(true);
    expect(ind.emaFast).toBeCloseTo(100, 9); // mean of the three closes
  });

  test("non-finite candles are ignored", () => {
    const candles = candlesFromCloses([100, 110]);
    candles.push({ t: 0, o: Number.NaN, h: Number.NaN, l: Number.NaN, c: Number.NaN, v: 0 });
    const ind = computeIndicators(candles);
    for (const v of Object.values(ind)) expect(Number.isNaN(v)).toBe(false);
    expect(ind.rocPct).toBeCloseTo(10, 9);
  });

  test("constant series: EMAs equal the price, RSI is neutral, ATR is the bar range, ROC and volatility are 0", () => {
    const ind = computeIndicators(candlesFromCloses(Array.from({ length: 30 }, () => 10), 1));
    expect(ind.emaFast).toBeCloseTo(10, 9);
    expect(ind.emaSlow).toBeCloseTo(10, 9);
    expect(ind.rsi14).toBe(50);
    expect(ind.atr14).toBeCloseTo(2, 9);
    expect(ind.rocPct).toBeCloseTo(0, 9);
    expect(ind.volatilityPct).toBeCloseTo(0, 9);
  });

  test("EMA(9) and EMA(21) match a hand-rolled recurrence on 1..30", () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1);
    const ema = (period: number) => {
      const k = 2 / (period + 1);
      let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < closes.length; i++) e = (closes[i] as number) * k + e * (1 - k);
      return e;
    };
    const ind = computeIndicators(candlesFromCloses(closes));
    expect(ind.emaFast).toBeCloseTo(ema(9), 9);
    expect(ind.emaSlow).toBeCloseTo(ema(21), 9);
    expect(ind.emaFast).toBeGreaterThan(ind.emaSlow); // rising series: fast above slow
  });

  test("RSI is 100 for a series that only rises", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(computeIndicators(candlesFromCloses(closes)).rsi14).toBe(100);
  });

  test("RSI is 0 for a series that only falls", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
    expect(computeIndicators(candlesFromCloses(closes)).rsi14).toBe(0);
  });

  test("Wilder RSI matches a worked example: 14 gains of 1, then one loss of 1", () => {
    // avgGain = 13/14 and avgLoss = 1/14 after the final bar, so RS = 13 and RSI = 100 - 100/14.
    const closes = [100, ...Array.from({ length: 14 }, (_, i) => 101 + i), 113];
    expect(computeIndicators(candlesFromCloses(closes)).rsi14).toBeCloseTo(100 - 100 / 14, 9);
  });

  test("ATR uses true range including gaps from the previous close", () => {
    // Bar 1: h-l = 2. Bar 2 gaps up from 10 to 20, so TR = |21 - 10| = 11. Mean of [2, 11] = 6.5.
    const candles: Candle[] = [
      { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { t: 1, o: 20, h: 21, l: 19, c: 20, v: 1 },
    ];
    expect(computeIndicators(candles).atr14).toBeCloseTo(6.5, 9);
  });

  test("ROC% compares the last close with the close lookbackBars ago", () => {
    expect(computeIndicators(candlesFromCloses([100, 105, 110]), { lookbackBars: 1 }).rocPct).toBeCloseTo(
      (110 / 105 - 1) * 100,
      9,
    );
    expect(computeIndicators(candlesFromCloses([100, 110]), { lookbackBars: 1 }).rocPct).toBeCloseTo(10, 9);
  });

  test("range high and low use only the last rangeBars candles", () => {
    const candles: Candle[] = [
      { t: 0, o: 5, h: 5, l: 1, c: 5, v: 1 },
      { t: 1, o: 5, h: 9, l: 2, c: 5, v: 1 },
      { t: 2, o: 5, h: 7, l: 0, c: 5, v: 1 },
      { t: 3, o: 5, h: 3, l: 4, c: 5, v: 1 },
    ];
    const ind = computeIndicators(candles, { rangeBars: 3 });
    expect(ind.rangeHigh).toBe(9);
    expect(ind.rangeLow).toBe(0);
  });

  test("volatility% is the population stdev of returns x 100", () => {
    // Returns are +10% and -10%. Mean is 0 and population stdev is 0.1, so 10%.
    expect(computeIndicators(candlesFromCloses([100, 110, 99])).volatilityPct).toBeCloseTo(10, 9);
  });
});
