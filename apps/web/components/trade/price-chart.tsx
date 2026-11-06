"use client";

import type { Candle } from "@arena/shared";
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

/** 1h candlestick chart with a volume histogram. */
export function PriceChart({ candles }: { candles: Candle[] }) {
  const ref = useRef<HTMLDivElement>(null);

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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#50d2c1",
      downColor: "#ed7088",
      wickUpColor: "#50d2c1",
      wickDownColor: "#ed7088",
      borderVisible: false,
    });
    candleSeries.setData(
      candles.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    volume.setData(
      candles.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        value: c.v,
        color: c.c >= c.o ? "rgba(80, 210, 193, 0.35)" : "rgba(237, 112, 128, 0.35)",
      })),
    );

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles]);

  return <div ref={ref} className="h-full min-h-[360px] w-full" />;
}
