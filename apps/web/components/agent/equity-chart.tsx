"use client";

import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { IconChart } from "@/components/ui/icons";
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
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#62666f",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#f2f2f4" }, horzLines: { color: "#f2f2f4" } },
      rightPriceScale: { borderColor: "#e7e7ea" },
      timeScale: { borderColor: "#e7e7ea", timeVisible: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: up ? "#0b7a53" : "#c42b45",
      topColor: up ? "rgba(11, 122, 83, 0.16)" : "rgba(196, 43, 69, 0.14)",
      bottomColor: "rgba(255, 255, 255, 0)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    series.setData(points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.equityUsd })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  if (points.length === 0) {
    return (
      <EmptyState
        compact
        className="h-64 justify-center"
        icon={<IconChart size={18} />}
        title="No trades yet"
        description="The chart appears after the agent's first trade."
      />
    );
  }
  return <div ref={ref} role="img" aria-label="Chart of the agent's total account value over time" className="h-64 w-full" />;
}
