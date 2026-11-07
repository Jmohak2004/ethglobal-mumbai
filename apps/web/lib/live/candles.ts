// Pure candle maths for the live chart. The chart keeps one bar in progress and folds every trade into it.

import type { Candle } from "@arena/shared";

/** Start of the candle bucket containing `ms`, for a granularity in seconds. */
export function bucketStart(ms: number, granularity: number): number {
  const step = granularity * 1000;
  return Math.floor(ms / step) * step;
}

/**
 * Folds a trade into the bar in progress. Same bucket: extends high/low, sets close, adds size. A later bucket
 * opens a new bar at the previous close. A tick older than the bar (clock skew at a boundary) joins the current bar
 * instead of being dropped.
 */
export function applyTick(bar: Candle, price: number, size: number, nowMs: number, granularity: number): Candle {
  const bucket = Math.max(bucketStart(nowMs, granularity), bar.t);
  if (bucket === bar.t) {
    return { ...bar, h: Math.max(bar.h, price), l: Math.min(bar.l, price), c: price, v: bar.v + size };
  }
  const open = bar.c;
  return { t: bucket, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: size };
}

/**
 * Merges a REST candle into the bar in progress for the same bucket. REST owns the open. The live bar owns the
 * close, because ticks are newer than a cached candle. High and low take the wider range. Volume takes the larger
 * figure, so trades counted by both sources are not added twice.
 */
export function mergeCandle(rest: Candle, live: Candle): Candle {
  if (rest.t !== live.t) return rest;
  return {
    t: rest.t,
    o: rest.o,
    h: Math.max(rest.h, live.h),
    l: Math.min(rest.l, live.l),
    c: live.c,
    v: Math.max(rest.v, live.v),
  };
}
