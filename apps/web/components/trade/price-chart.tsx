"use client";

import type { Candle } from "@arena/shared";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import { applyTick, mergeCandle } from "@/lib/live/candles";
import { coinbaseFeed } from "@/lib/live/coinbase-ticker";
import { priceDecimals } from "@/lib/live/price-format";

const toBar = (c: Candle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
});

const toVolume = (c: Candle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  value: c.v,
  color: c.c >= c.o ? "rgba(11, 122, 83, 0.28)" : "rgba(196, 43, 69, 0.28)",
});

interface Series {
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
}

/** The bar in progress, plus the market it belongs to. */
interface Drawn {
  key: string;
  product: string;
  granularity: number;
  last: Candle;
}

/**
 * Folds a price into the bar in progress and pushes that bar to the chart. The bar rolls over on the interval
 * boundary (a new bar opens at the previous close). Nothing re-renders: the chart is updated in place.
 */
function foldPrice(
  s: Series,
  drawnRef: { current: Drawn | null },
  product: string,
  price: number,
  size: number,
): void {
  const d = drawnRef.current;
  if (!d || d.product !== product) return;
  const bar = applyTick(d.last, price, size, Date.now(), d.granularity);
  d.last = bar;
  s.candle.update(toBar(bar));
  s.volume.update(toVolume(bar));
}

const priceFormatFor = (price: number) => {
  const precision = priceDecimals(price);
  return { type: "price" as const, precision, minMove: 10 ** -precision };
};

/**
 * Candlestick chart with a volume histogram. The chart is created once. REST candles (polled) are merged into the
 * bar in progress, and every trade from the shared feed updates the last bar's close, high, low and volume. A full
 * reset happens only when the market or interval changes.
 */
export function PriceChart({
  asset,
  product,
  granularity,
  candles,
}: {
  asset: string;
  product: string;
  granularity: number;
  candles: Candle[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Series | null>(null);
  const drawnRef = useRef<Drawn | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#62666f",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#f2f2f4" }, horzLines: { color: "#f2f2f4" } },
      rightPriceScale: { borderColor: "#e7e7ea" },
      timeScale: { borderColor: "#e7e7ea", timeVisible: true },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#0b7a53",
      downColor: "#c42b45",
      wickUpColor: "#0b7a53",
      wickDownColor: "#c42b45",
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    chartRef.current = chart;
    seriesRef.current = { candle, volume };
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawnRef.current = null;
    };
  }, []);

  // REST candles. Historical bars are applied as-is. The bar in progress is merged, so a cached candle never
  // rewinds a live close.
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    const first = candles[0];
    const last = candles.at(-1);
    if (!s || !chart || !first || !last) return;

    const key = `${asset}:${granularity}`;
    const drawn = drawnRef.current;
    if (drawn && drawn.key === key && drawn.product === product && drawn.last.t >= first.t) {
      let live = drawn.last;
      for (const c of candles) {
        if (c.t < live.t) continue;
        live = c.t === live.t ? mergeCandle(c, live) : c;
        s.candle.update(toBar(live));
        s.volume.update(toVolume(live));
      }
      drawnRef.current = { key, product, granularity, last: live };
    } else {
      s.candle.setData(candles.map(toBar));
      s.volume.setData(candles.map(toVolume));
      chart.timeScale().fitContent();
      drawnRef.current = { key, product, granularity, last };
    }
    s.candle.applyOptions({ priceFormat: priceFormatFor(last.c) });

    // The feed price is newer than any cached candle, so fold it in and keep the bar in step with the header.
    const t = coinbaseFeed.getTicker(product);
    if (t) foldPrice(s, drawnRef, product, t.price, 0);
  }, [asset, product, granularity, candles]);

  // Live trades. Each feed update folds into the bar in progress with its trade size. A 1 s timer rolls the bar on
  // the interval boundary when no trade arrives.
  useEffect(() => {
    const unsubscribe = coinbaseFeed.subscribeTicker(product, () => {
      const s = seriesRef.current;
      const t = coinbaseFeed.getTicker(product);
      if (s && t) foldPrice(s, drawnRef, product, t.price, t.lastSize);
    });
    const timer = setInterval(() => {
      const s = seriesRef.current;
      const t = coinbaseFeed.getTicker(product);
      if (s && t) foldPrice(s, drawnRef, product, t.price, 0);
    }, 1_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [product]);

  return <div ref={ref} role="img" aria-label={`${asset} candlestick price chart`} className="h-full min-h-[360px] w-full" />;
}
