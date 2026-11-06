import { describe, expect, test } from "bun:test";
import { parseListOrders, parseOrderFills, toPnlFills } from "./flash.ts";

const listJson = {
  orders: [
    {
      orderId: "ord-1",
      orderType: "market",
      side: "buy",
      status: "ORDER_STATUS_FILLED",
      funderAddress: "0x1111111111111111111111111111111111111111",
      targetAsset: { id: "a", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", ticker: "WETH", chain: { id: "8453", name: "Base", namespace: "eip155" } },
      contraAsset: { id: "b", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ticker: "USDC", chain: { id: "8453", name: "Base", namespace: "eip155" } },
      placedAt: "2026-01-01T00:00:00Z",
    },
  ],
  nextPageToken: null,
};

describe("Flash parsing", () => {
  test("list page parses orders and a null cursor", () => {
    const page = parseListOrders(listJson);
    expect(page.orders).toEqual([
      { orderId: "ord-1", side: "buy", status: "ORDER_STATUS_FILLED", targetTicker: "WETH", contraTicker: "USDC", placedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(page.nextPageToken).toBeNull();
  });

  test("bad shapes throw", () => {
    expect(() => parseListOrders({})).toThrow();
    expect(() => parseListOrders({ orders: [{ ...listJson.orders[0], side: "hold" }], nextPageToken: null })).toThrow();
    expect(() => parseOrderFills({ order: {}, fills: [{ rootOrderId: "x" }] })).toThrow();
  });

  test("fills convert to PnL fills with decimals and USD fees", () => {
    const [order] = parseListOrders(listJson).orders;
    const fills = parseOrderFills({
      order: {},
      fills: [
        {
          rootOrderId: "ord-1",
          orderId: "ord-1",
          filledAt: "2026-01-01T00:00:01Z",
          fillPrice: "3000",
          notional: "300.5",
          targetAmount: "0.1",
          feeNotional: "0.3",
        },
      ],
    });
    const out = toPnlFills(order!, fills);
    expect(out.skippedUnknownAsset).toBe(0);
    expect(out.fills).toEqual([
      {
        orderId: "ord-1",
        filledAt: "2026-01-01T00:00:01Z",
        side: "buy",
        asset: "WETH",
        qtyUnits: 100_000_000_000_000_000n,
        notionalUsd6: 300_500_000n,
        feeUsd6: 300_000n,
      },
    ]);
  });

  test("assets without decimals are skipped and counted", () => {
    const order = { ...parseListOrders(listJson).orders[0]!, targetTicker: "DOGE" };
    const out = toPnlFills(order, [{ rootOrderId: "x", orderId: "x", filledAt: "t", fillPrice: "1", notional: "1", targetAmount: "1", feeNotional: "0" }]);
    expect(out.fills).toEqual([]);
    expect(out.skippedUnknownAsset).toBe(1);
  });
});
