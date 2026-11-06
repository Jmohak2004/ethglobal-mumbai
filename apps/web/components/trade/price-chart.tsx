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
  color: c.c >= c.o ? "rgba(80, 210, 193, 0.35)" : "rgba(237, 112, 128, 0.35)",
});

/**
 * Candlestick chart with a volume histogram. The chart is created once. On a poll the new candles are applied
 * with series.update() from the last bar we already drew, so the view keeps its zoom. A full reset happens only
 * when the asset changes or the feed no longer overlaps what is drawn.
 */
export function PriceChart({ asset, candles }: { asset: string; candles: Candle[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ candle: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> } | null>(null);
  const drawnRef = useRef<{ asset: string; lastT: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0f1a1e" },
        textColor: "#8a9a98",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#13222a" }, horzLines: { color: "#13222a" } },
      rightPriceScale: { borderColor: "#1c2d34" },
      timeScale: { borderColor: "#1c2d34", timeVisible: true },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#50d2c1",
      downColor: "#ed7088",
      wickUpColor: "#50d2c1",
      wickDownColor: "#ed7088",
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

  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    const last = candles.at(-1);
    const first = candles[0];
    if (!s || !chart || !last || !first) return;

    const drawn = drawnRef.current;
    const canAppend = drawn !== null && drawn.asset === asset && drawn.lastT >= first.t;
    if (canAppend) {
      for (const c of candles) {
        if (c.t < drawn.lastT) continue;
        s.candle.update(toBar(c));
        s.volume.update(toVolume(c));
      }
    } else {
      s.candle.setData(candles.map(toBar));
      s.volume.setData(candles.map(toVolume));
      chart.timeScale().fitContent();
    }
    drawnRef.current = { asset, lastT: last.t };
  }, [asset, candles]);

  return <div ref={ref} className="h-full min-h-[360px] w-full" />;
}
