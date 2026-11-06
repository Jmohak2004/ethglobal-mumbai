import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "@arena/policy";
import { applySliderSuggestions, closedTradesFrom } from "./reflection.ts";
import type { Trade } from "@arena/flash";

const momentum = TEMPLATES.momentum.sliders;

describe("applySliderSuggestions", () => {
  test("applies a change that sits inside the owner's ±maxDeltaPct window", () => {
    const { sliders, applied } = applySliderSuggestions(
      { lookbackBars: 20, minConfidence: 60, sizePct: 25, takeProfitPct: 4, stopLossPct: 2, trailPct: 2 },
      [{ key: "lookbackBars", from: 20, to: 21, reason: "slightly longer" }],
      momentum,
      5,
    );
    expect(sliders.lookbackBars).toBe(21);
    expect(applied).toEqual(["lookbackBars 20->21"]);
  });

  test("clamps a large suggestion to the window, then snaps to the slider step", () => {
    // takeProfitPct 4 with ±5% is [3.8, 4.2]; step 0.5 from min 0.5 leaves no step inside the window.
    const { sliders, applied } = applySliderSuggestions(
      { takeProfitPct: 4 },
      [{ key: "takeProfitPct", from: 4, to: 12, reason: "go big" }],
      momentum,
      5,
    );
    expect(sliders.takeProfitPct).toBe(4);
    expect(applied).toEqual([]);
  });

  test("never leaves the template bounds, and ignores unknown keys", () => {
    const { sliders } = applySliderSuggestions(
      { lookbackBars: 100 },
      [
        { key: "lookbackBars", from: 100, to: 500, reason: "way past max" },
        { key: "notASlider", from: 1, to: 2, reason: "unknown" },
      ],
      momentum,
      50,
    );
    expect(sliders.lookbackBars).toBe(100);
    expect(sliders).not.toHaveProperty("notASlider");
  });

  test("uses at most one suggestion per key", () => {
    const { applied } = applySliderSuggestions(
      { lookbackBars: 20 },
      [
        { key: "lookbackBars", from: 20, to: 22, reason: "first" },
        { key: "lookbackBars", from: 20, to: 25, reason: "second" },
      ],
      momentum,
      50,
    );
    expect(applied).toEqual(["lookbackBars 20->22"]);
  });
});

describe("closedTradesFrom", () => {
  test("pairs each sell with the PnL it realized under FIFO", () => {
    const trades: Trade[] = [
      { orderId: "b", side: "buy", asset: "WETH", qty: 1, price: 2000, notionalUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 1 },
      { orderId: "s", side: "sell", asset: "WETH", qty: 1, price: 2200, notionalUsd: 2200, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 2 },
    ];
    const [closed] = closedTradesFrom(trades);
    expect(closed?.pnlUsd).toBeCloseTo(200, 9);
    expect(closed?.entryPrice).toBeCloseTo(2000, 9);
    expect(closed?.pnlPct).toBeCloseTo(10, 9);
  });

  test("buys are not closed trades", () => {
    const trades: Trade[] = [
      { orderId: "b", side: "buy", asset: "WETH", qty: 1, price: 2000, notionalUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 1 },
    ];
    expect(closedTradesFrom(trades)).toEqual([]);
  });
});
