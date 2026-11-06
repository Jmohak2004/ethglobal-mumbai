import { describe, expect, test } from "bun:test";
import type { Trade } from "@arena/flash";
import { computePortfolio } from "./portfolio.ts";
import { NOW } from "./test-fixtures.ts";

const trade = (p: Partial<Trade> & Pick<Trade, "orderId" | "side">): Trade => ({
  asset: "WETH",
  qty: 1,
  price: 100,
  notionalUsd: 100,
  feeUsd: 0,
  integratorFeeUsd: 0,
  txId: "",
  ts: NOW,
  ...p,
});

describe("computePortfolio", () => {
  test("cash, positions, realized and unrealized PnL reconcile to equity", () => {
    const fills = [
      trade({ orderId: "buy-1", side: "buy", qty: 2, price: 100, notionalUsd: 200, feeUsd: 2 }),
      trade({ orderId: "sell-1", side: "sell", qty: 1, price: 130, notionalUsd: 130, feeUsd: 1, ts: NOW + 1 }),
    ];
    const snap = computePortfolio(fills, 1000, { WETH: 120 }, 42);

    // Sold 1 of 2 units: proceeds 129 vs cost 101 => realized 28. Open lot cost 101.
    expect(snap.realizedPnlUsd).toBeCloseTo(28);
    expect(snap.cashUsd).toBeCloseTo(927); // 1000 + 28 - 101
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]).toMatchObject({ asset: "WETH", qty: 1 });
    expect(snap.positions[0]?.avgPriceUsd).toBeCloseTo(101);
    expect(snap.positions[0]?.markPriceUsd).toBe(120);
    expect(snap.positions[0]?.valueUsd).toBeCloseTo(120);
    expect(snap.positions[0]?.unrealizedPnlUsd).toBeCloseTo(19);
    expect(snap.unrealizedPnlUsd).toBeCloseTo(19);
    expect(snap.equityUsd).toBeCloseTo(1047);
    expect(snap.equityUsd).toBeCloseTo(1000 + snap.realizedPnlUsd + snap.unrealizedPnlUsd);
    expect(snap.asOf).toBe(42);
  });

  test("with no fills, cash is the starting allocation and equity equals it", () => {
    const snap = computePortfolio([], 500, {});
    expect(snap.cashUsd).toBe(500);
    expect(snap.equityUsd).toBe(500);
    expect(snap.positions).toEqual([]);
    expect(snap.realizedPnlUsd).toBe(0);
  });

  test("a missing mark values the position at cost, so its unrealized PnL is zero", () => {
    const fills = [trade({ orderId: "buy-1", side: "buy", qty: 2, price: 100, notionalUsd: 200, feeUsd: 2 })];
    const snap = computePortfolio(fills, 1000, {});
    expect(snap.positions[0]?.markPriceUsd).toBeCloseTo(101);
    expect(snap.positions[0]?.unrealizedPnlUsd).toBeCloseTo(0);
    expect(snap.equityUsd).toBeCloseTo(1000 - 202 + 202);
  });

  test("a fully closed position leaves its realized PnL in cash", () => {
    const fills = [
      trade({ orderId: "buy-1", side: "buy", qty: 1, price: 100, notionalUsd: 100, feeUsd: 1 }),
      trade({ orderId: "sell-1", side: "sell", qty: 1, price: 120, notionalUsd: 120, feeUsd: 1, ts: NOW + 1 }),
    ];
    const snap = computePortfolio(fills, 1000, {});
    expect(snap.positions).toEqual([]);
    expect(snap.realizedPnlUsd).toBeCloseTo(18);
    expect(snap.cashUsd).toBeCloseTo(1018);
    expect(snap.equityUsd).toBeCloseTo(1018);
  });
});
