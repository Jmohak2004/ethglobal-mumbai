"use client";

import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { EquityPoint } from "@/lib/types";

/** Aggregate equity area chart. Aggregate only; no individual trades. */
export function EquityChart({ points }: { points: EquityPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const last = points[points.length - 1]?.pnlUsd ?? 0;
    const up = last >= 0;
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
    const series = chart.addSeries(AreaSeries, {
      lineColor: up ? "#50d2c1" : "#ed7088",
      topColor: up ? "rgba(80, 210, 193, 0.18)" : "rgba(237, 112, 128, 0.18)",
      bottomColor: "rgba(0, 0, 0, 0)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    series.setData(points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.equityUsd })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  if (points.length === 0) {
    return <div className="flex h-64 items-center justify-center text-[12px] text-muted">No history yet.</div>;
  }
  return <div ref={ref} className="h-64 w-full" />;
}
