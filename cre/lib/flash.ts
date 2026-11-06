// Definitive Flash REST response parsing (read-only). Shapes follow the Flash OpenAPI document
// (GET /orders -> FlashListOrdersResponse, GET /orders/{orderId} -> FlashGetOrderResponse).
// The list endpoint does NOT carry fills; fills come from the per-order detail call.
import type { Fill } from "./pnl.ts";
import { ASSET_DECIMALS } from "./chains.ts";
import { decimalToUnits } from "./units.ts";

export interface FlashOrder {
  orderId: string;
  side: "buy" | "sell";
  status: string;
  targetTicker: string;
  contraTicker: string;
  placedAt: string;
}

export interface FlashFillRaw {
  rootOrderId: string;
  orderId: string;
  filledAt: string;
  fillPrice: string;
  notional: string;
  targetAmount: string;
  feeNotional: string;
}

export interface ListOrdersPage {
  orders: FlashOrder[];
  nextPageToken: string | null;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`Flash field "${field}" missing or not a string`);
  return v;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseListOrders(json: unknown): ListOrdersPage {
  if (!isObj(json) || !Array.isArray(json.orders)) throw new Error("Flash list response has no orders array");
  const orders = json.orders.map((o): FlashOrder => {
    if (!isObj(o)) throw new Error("Flash order is not an object");
    const side = str(o.side, "side");
    if (side !== "buy" && side !== "sell") throw new Error(`unknown Flash side "${side}"`);
    const target = o.targetAsset;
    const contra = o.contraAsset;
    if (!isObj(target) || !isObj(contra)) throw new Error("Flash order missing asset refs");
    return {
      orderId: str(o.orderId, "orderId"),
      side,
      status: str(o.status, "status"),
      targetTicker: str(target.ticker, "targetAsset.ticker"),
      contraTicker: str(contra.ticker, "contraAsset.ticker"),
      placedAt: str(o.placedAt, "placedAt"),
    };
  });
  return { orders, nextPageToken: optStr(json.nextPageToken) };
}

export function parseOrderFills(json: unknown): FlashFillRaw[] {
  if (!isObj(json) || !Array.isArray(json.fills)) throw new Error("Flash order detail has no fills array");
  return json.fills.map((f): FlashFillRaw => {
    if (!isObj(f)) throw new Error("Flash fill is not an object");
    return {
      rootOrderId: str(f.rootOrderId, "rootOrderId"),
      orderId: str(f.orderId, "orderId"),
      filledAt: str(f.filledAt, "filledAt"),
      fillPrice: str(f.fillPrice, "fillPrice"),
      notional: str(f.notional, "notional"),
      targetAmount: str(f.targetAmount, "targetAmount"),
      feeNotional: str(f.feeNotional, "feeNotional"),
    };
  });
}

export interface FillConversion {
  fills: Fill[];
  /** Fills skipped because the traded asset has no decimals entry (not in ASSET_DECIMALS). */
  skippedUnknownAsset: number;
}

/**
 * Converts one order's fills into PnL fills. Assumptions to confirm on day 1 with a live order:
 *  - targetAmount is a human-unit decimal string of the traded (target) asset.
 *  - notional and feeNotional are USD decimal strings.
 * If either is wrong, change only this function.
 */
export function toPnlFills(order: FlashOrder, raw: readonly FlashFillRaw[]): FillConversion {
  const decimals = ASSET_DECIMALS[order.targetTicker];
  if (decimals === undefined) return { fills: [], skippedUnknownAsset: raw.length };
  const fills: Fill[] = raw.map((f) => ({
    orderId: order.orderId,
    filledAt: f.filledAt,
    side: order.side,
    asset: order.targetTicker,
    qtyUnits: decimalToUnits(f.targetAmount, decimals),
    notionalUsd6: decimalToUnits(f.notional, 6),
    feeUsd6: decimalToUnits(f.feeNotional, 6),
  }));
  return { fills, skippedUnknownAsset: 0 };
}
