import { describe, expect, it } from "bun:test";
import { computeFifoPnl, normalizeFills } from "./fills.ts";
import { orderFixture, ORDER_ID } from "./test-helpers.ts";
import type { FlashFill, Trade } from "./types.ts";

function fill(over: Partial<FlashFill>): FlashFill {
  return {
    status: "CHAIN_STATUS_FINALIZED",
    notional: "0",
    venues: ["uniswap"],
    filledAt: "2026-11-06T10:00:00Z",
    rootOrderId: ORDER_ID,
    orderId: ORDER_ID,
    parentOrderId: ORDER_ID,
    transactionId: "0xtx",
    fillPrice: "0",
    feeAmount: "0",
    feeTicker: "USDC",
    integratorFeeAmount: "0",
    feeNotional: "0",
    integratorFeeNotional: "0",
    contraAmount: "0",
    targetAmount: "0",
    ...over,
  } as FlashFill;
}

const t = (over: Partial<Trade>): Trade => ({
  orderId: "o",
  side: "buy",
  asset: "WETH",
  qty: 1,
  price: 3000,
  notionalUsd: 3000,
  feeUsd: 0,
  integratorFeeUsd: 0,
  txId: "0x",
  ts: 0,
  ...over,
});

describe("normalizeFills", () => {
  it("maps Flash fill fields to Trade, sorts by time, and drops reorged fills", () => {
    const order = orderFixture({ side: "sell" });
    const trades = normalizeFills({
      order,
      fills: [
        fill({ filledAt: "2026-11-06T10:05:00Z", targetAmount: "0.5", fillPrice: "3010", notional: "1505", feeNotional: "1.5", integratorFeeNotional: "0.15", transactionId: "0xb" }),
        fill({ filledAt: "2026-11-06T10:00:00Z", targetAmount: "1", fillPrice: "3000", notional: "3000", feeNotional: "3", integratorFeeNotional: "0.3", transactionId: "0xa" }),
        fill({ status: "CHAIN_STATUS_REORGED", targetAmount: "9", notional: "9999", transactionId: "0xgone" }),
      ],
    });
    expect(trades).toHaveLength(2);
    expect(trades[0]).toEqual({
      orderId: ORDER_ID,
      side: "sell",
      asset: "WETH",
      qty: 1,
      price: 3000,
      notionalUsd: 3000,
      feeUsd: 3,
      integratorFeeUsd: 0.3,
      txId: "0xa",
      ts: Date.parse("2026-11-06T10:00:00Z"),
    });
    expect(trades[1]!.txId).toBe("0xb");
  });

  it("throws on a non-numeric fill field instead of producing NaN", () => {
    expect(() =>
      normalizeFills({ order: orderFixture(), fills: [fill({ targetAmount: "abc" })] }),
    ).toThrow(/targetAmount/);
  });
});

describe("computeFifoPnl", () => {
  // Handcrafted sequence (all WETH vs USDC):
  //  1. buy 1 WETH, notional 3000, fee 3     -> lot A: cost 3003 (3003/unit)
  //  2. buy 1 WETH, notional 3300, fee 3.3   -> lot B: cost 3303.3 (3303.3/unit)
  //  3. sell 1.5 WETH, notional 4950, fee 4.95
  //       net proceeds 4945.05 -> 3296.7/unit
  //       closes A (1 @ 3003):   1 * (3296.7 - 3003)   = +293.7
  //       closes 0.5 of B:       0.5 * (3296.7 - 3303.3) = -3.3
  //       trade pnl = +290.4 (win)
  //  4. sell 0.5 WETH, notional 1500, fee 1.5 -> net 2997/unit
  //       closes 0.5 of B: 0.5 * (2997 - 3303.3) = -153.15 (loss)
  const seq: Trade[] = [
    t({ side: "buy", qty: 1, notionalUsd: 3000, feeUsd: 3, ts: 1 }),
    t({ side: "buy", qty: 1, notionalUsd: 3300, feeUsd: 3.3, ts: 2 }),
    t({ side: "sell", qty: 1.5, notionalUsd: 4950, feeUsd: 4.95, ts: 3 }),
    t({ side: "sell", qty: 0.5, notionalUsd: 1500, feeUsd: 1.5, ts: 4 }),
  ];

  it("computes realized PnL, volume, wins and losses for a handcrafted FIFO sequence", () => {
    const r = computeFifoPnl(seq);
    expect(r.realizedPnlUsd).toBeCloseTo(290.4 - 153.15, 6);
    expect(r.volumeUsd).toBeCloseTo(3000 + 3300 + 4950 + 1500, 6);
    expect(r.trades).toBe(4);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.unmatchedSells).toEqual([]);
  });

  it("reports the remaining lot as the open position at its cost basis", () => {
    const r = computeFifoPnl(seq.slice(0, 3));
    expect(r.openPositions).toHaveLength(1);
    const pos = r.openPositions[0]!;
    expect(pos.asset).toBe("WETH");
    expect(pos.qty).toBeCloseTo(0.5, 9);
    expect(pos.avgCostUsd).toBeCloseTo(3303.3, 6);
    expect(pos.costUsd).toBeCloseTo(0.5 * 3303.3, 6);
  });

  it("drawdown is measured from peak cumulative realized PnL, as a percent of peak open cost by default", () => {
    const r = computeFifoPnl(seq);
    // Peak cumulative realized PnL is 290.4 after trade 3. Trough is 137.25 after trade 4: drawdown 153.15.
    // Peak open cost is 3003 + 3303.3 = 6306.3.
    expect(r.maxDrawdownPct).toBeCloseTo((153.15 / 6306.3) * 100, 6);
  });

  it("drawdown uses startingCapitalUsd when given", () => {
    const r = computeFifoPnl(seq, { startingCapitalUsd: 1000 });
    expect(r.maxDrawdownPct).toBeCloseTo(15.315, 6);
  });

  it("is independent of input order (sorted by ts)", () => {
    const shuffled = [seq[3]!, seq[1]!, seq[0]!, seq[2]!];
    expect(computeFifoPnl(shuffled).realizedPnlUsd).toBeCloseTo(computeFifoPnl(seq).realizedPnlUsd, 9);
  });

  it("sells beyond inventory are excluded from PnL and reported, not counted as profit", () => {
    const r = computeFifoPnl([t({ side: "sell", qty: 2, notionalUsd: 6000, feeUsd: 0, ts: 1 })]);
    expect(r.realizedPnlUsd).toBe(0);
    expect(r.unmatchedSells).toEqual([{ asset: "WETH", qty: 2 }]);
  });

  it("per-asset lots are kept separate", () => {
    const r = computeFifoPnl([
      t({ asset: "WETH", side: "buy", qty: 1, notionalUsd: 3000, ts: 1 }),
      t({ asset: "cbBTC", side: "buy", qty: 0.1, notionalUsd: 10000, ts: 2 }),
      t({ asset: "cbBTC", side: "sell", qty: 0.1, notionalUsd: 11000, ts: 3 }),
    ]);
    expect(r.realizedPnlUsd).toBeCloseTo(1000, 6);
    expect(r.openPositions.map((p) => p.asset)).toEqual(["WETH"]);
  });
});
