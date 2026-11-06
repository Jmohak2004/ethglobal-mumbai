import type { Candle, Indicators } from "@arena/shared";

export interface IndicatorOptions {
  /** Bars for ROC% and volatility%. Default 20. */
  lookbackBars?: number;
  /** Bars for the range high/low. Default 20. */
  rangeBars?: number;
}

const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * EMA seeded with the SMA of the first `period` values.
 * With fewer values than `period`, returns their mean (no NaN).
 */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return mean(values);
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = (values[i] as number) * k + e * (1 - k);
  return e;
}

/** Wilder RSI. Returns 50 (neutral) when there are not enough closes. Flat series gives 50. */
function rsi(closes: number[], period: number): number {
  if (closes.length <= period) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder ATR over true ranges. With fewer bars than `period`, returns the mean true range. */
function atr(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0;
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = (candles[i - 1] as Candle).c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
  if (trs.length < period) return mean(trs);
  let a = mean(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) a = ((a * (period - 1)) + (trs[i] as number)) / period;
  return a;
}

/** Rate of change in percent over `lookback` bars. Uses the oldest available bar if history is short. */
function rocPct(closes: number[], lookback: number): number {
  if (closes.length < 2) return 0;
  const last = closes[closes.length - 1] as number;
  const ref = closes[Math.max(0, closes.length - 1 - lookback)] as number;
  return ref > 0 ? (last / ref - 1) * 100 : 0;
}

/** Population stdev of simple close-to-close returns over the last `lookback` bars, in percent. */
function volatilityPct(closes: number[], lookback: number): number {
  const window = closes.slice(-(lookback + 1));
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1] as number;
    if (prev > 0) returns.push((window[i] as number) / prev - 1);
  }
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const variance = mean(returns.map((r) => (r - m) ** 2));
  return Math.sqrt(variance) * 100;
}

/**
 * Deterministic indicators for the policy and the prompt.
 * Non-finite candles are dropped. Short or empty input returns finite fallbacks, never NaN.
 */
export function computeIndicators(candles: Candle[], opts: IndicatorOptions = {}): Indicators {
  const lookback = Math.max(1, Math.floor(opts.lookbackBars ?? 20));
  const rangeBars = Math.max(1, Math.floor(opts.rangeBars ?? 20));

  const cs = candles.filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
  const closes = cs.map((c) => c.c);
  const tail = cs.slice(-rangeBars);

  return {
    emaFast: ema(closes, EMA_FAST),
    emaSlow: ema(closes, EMA_SLOW),
    rsi14: rsi(closes, RSI_PERIOD),
    atr14: atr(cs, ATR_PERIOD),
    rocPct: rocPct(closes, lookback),
    rangeHigh: tail.length ? Math.max(...tail.map((c) => c.h)) : 0,
    rangeLow: tail.length ? Math.min(...tail.map((c) => c.l)) : 0,
    volatilityPct: volatilityPct(closes, lookback),
  };
}
