import { describe, expect, test } from "bun:test";
import { computeAgentMetrics, type Fill } from "./pnl.ts";
import { commissionOwedCumulative, humanAgentId, toPerfEntry } from "./onchain.ts";

const USD = (n: number) => BigInt(Math.round(n * 1_000_000));
const ETH = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 1e18 units, exact for these inputs

let seq = 0;
function fill(p: Partial<Fill> & Pick<Fill, "side" | "qtyUnits" | "notionalUsd6">): Fill {
  seq += 1;
  return {
    orderId: `o${seq}`,
    filledAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    asset: "WETH",
    feeUsd6: 0n,
    ...p,
  };
}

// Cumulative realized: +100, -30, +50 => 100, 70, 120
const curve = [
  fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
  fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(200) }), // +100
  fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
  fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(70) }), // -30
  fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
  fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(150) }), // +50
];

describe("FIFO realized PnL", () => {
  test("single round trip with fees", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100), feeUsd6: USD(1) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(150), feeUsd6: USD(1) }),
    ]);
    // proceeds 149 - cost 101 = 48
    expect(m.realizedPnlUsd6).toBe(USD(48));
    expect(m.closedTrades).toBe(1);
    expect(m.winningTrades).toBe(1);
    expect(m.winRateBps).toBe(10_000);
    expect(m.openQtyUnits).toEqual({});
  });

  test("sell consumes the oldest lot first across partial lots", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(2), notionalUsd6: USD(200) }), // 100/unit
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(200) }), // 200/unit
      fill({ side: "sell", qtyUnits: ETH(2), notionalUsd6: USD(300) }), // 150/unit, matches the 100/unit lot
    ]);
    expect(m.realizedPnlUsd6).toBe(USD(100)); // 300 - 200
    expect(m.openQtyUnits.WETH).toBe(ETH(1));
  });

  test("a loss is counted as a closed, non-winning trade", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(70) }),
    ]);
    expect(m.realizedPnlUsd6).toBe(USD(-30));
    expect(m.winningTrades).toBe(0);
    expect(m.winRateBps).toBe(0);
  });

  test("sell with no matching lots realizes zero and is reported as unmatched", () => {
    const m = computeAgentMetrics([fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(500) })]);
    expect(m.realizedPnlUsd6).toBe(0n);
    expect(m.closedTrades).toBe(0);
    expect(m.unmatchedSellQtyUnits.WETH).toBe(ETH(1));
  });

  test("fills are sorted deterministically: input order does not change the result", () => {
    const a = fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) });
    const b = fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(130) });
    const c = fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(90) });
    const forward = computeAgentMetrics([a, b, c]);
    const reversed = computeAgentMetrics([c, b, a]);
    expect(reversed).toEqual(forward);
  });

  test("invalid fills throw instead of being guessed", () => {
    expect(() => computeAgentMetrics([fill({ side: "buy", qtyUnits: 0n, notionalUsd6: USD(1) })])).toThrow();
    expect(() => computeAgentMetrics([fill({ side: "buy", qtyUnits: 1n, notionalUsd6: -1n })])).toThrow();
  });
});

describe("volume, trades and unrealized", () => {
  test("volume sums notionals; trades counts distinct orders", () => {
    const m = computeAgentMetrics([
      { ...fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }), orderId: "same" },
      { ...fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(50) }), orderId: "same" },
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(25) }),
    ]);
    expect(m.volumeUsd6).toBe(USD(175));
    expect(m.trades).toBe(2);
  });

  test("unrealized PnL uses marks for open lots only", () => {
    const m = computeAgentMetrics(
      [fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100), feeUsd6: USD(1) })],
      { marks: { WETH: { priceUsd6: USD(120), decimals: 18 } } },
    );
    expect(m.unrealizedPnlUsd6).toBe(USD(19)); // 120 - 101
    expect(m.realizedPnlUsd6).toBe(0n);
  });

  test("assets without a mark stay out of unrealized", () => {
    const m = computeAgentMetrics([fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100), asset: "cbBTC" })]);
    expect(m.unrealizedPnlUsd6).toBe(0n);
  });
});

describe("high-water mark, drawdown and commission", () => {

  test("HWM follows the peak and never decreases", () => {
    const m = computeAgentMetrics(curve);
    expect(m.realizedPnlUsd6).toBe(USD(120));
    expect(m.hwmUsd6).toBe(USD(120));
  });

  test("max drawdown is the largest peak-to-trough drop", () => {
    const m = computeAgentMetrics(curve);
    expect(m.maxDrawdownUsd6).toBe(USD(30));
    expect(m.maxDrawdownBps).toBe(3000); // 30 / 100
  });

  test("a drawdown with no profit peak counts as 100%", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(80) }), // -20 with peak 0
    ]);
    expect(m.hwmUsd6).toBe(0n);
    expect(m.maxDrawdownBps).toBe(10_000);
  });

  test("hwm is never negative and stays zero for a losing agent", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(10) }),
    ]);
    expect(m.hwmUsd6).toBe(0n);
    expect(commissionOwedCumulative(m.hwmUsd6, 1000)).toBe(0n);
  });

  test("commission is bps of the HWM, not of current realized PnL", () => {
    // HWM 120 USD, current realized 120 USD, commission 10% => 12 USD
    expect(commissionOwedCumulative(USD(120), 1000)).toBe(USD(12));
    // After a drawdown the HWM still drives commission: realized 70, HWM 100, 10% => 10 USD
    const m = computeAgentMetrics(curve.slice(0, 4));
    expect(m.realizedPnlUsd6).toBe(USD(70));
    expect(m.hwmUsd6).toBe(USD(100));
    expect(commissionOwedCumulative(m.hwmUsd6, 1000)).toBe(USD(10));
  });

  test("commission math floors and rejects negative HWM", () => {
    expect(commissionOwedCumulative(USD(1), 1)).toBe(100n); // 1 USD * 0.01% = 0.0001 USD = 100 units
    expect(commissionOwedCumulative(-USD(5), 1000)).toBe(0n);
  });

  test("win rate in bps over closing trades", () => {
    const m = computeAgentMetrics([
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(200) }), // win
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(70) }), // loss
      fill({ side: "buy", qtyUnits: ETH(1), notionalUsd6: USD(100) }),
      fill({ side: "sell", qtyUnits: ETH(1), notionalUsd6: USD(150) }), // win
    ]);
    expect(m.closedTrades).toBe(3);
    expect(m.winRateBps).toBe(6666); // 2/3 floored
  });

  test("forecast hit rate is 0 unless provided", () => {
    expect(computeAgentMetrics([]).forecastHitRateBps).toBe(0);
    expect(computeAgentMetrics([], { forecastHitRateBps: 5500 }).forecastHitRateBps).toBe(5500);
  });
});

describe("PerfEntry construction", () => {
  test("toPerfEntry carries metrics and computes commission from HWM", () => {
    const m = computeAgentMetrics(curve);
    const entry = toPerfEntry({
      agentId: humanAgentId("0x1111111111111111111111111111111111111111"),
      metrics: m,
      commissionBps: 1000,
      asOf: 1767225600n,
    });
    expect(entry.realizedPnlUsd6).toBe(USD(120));
    expect(entry.hwmUsd6).toBe(USD(120));
    expect(entry.commissionOwedCumulativeUsd6).toBe(USD(12));
    expect(entry.trades).toBe(6); // six distinct orders: three round trips
    expect(entry.agentId).toBe("0x0000000000000000000000001111111111111111111111111111111111111111");
  });

  test("toPerfEntry rejects values the uint16 fields cannot hold", () => {
    const m = { ...computeAgentMetrics(curve), winRateBps: 10_001 };
    expect(() => toPerfEntry({ agentId: "0x" + "00".repeat(32) as `0x${string}`, metrics: m, commissionBps: 0, asOf: 0n })).toThrow();
  });
});
