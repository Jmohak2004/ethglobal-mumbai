import { desc, eq } from "drizzle-orm";
import type { FlashOrderType, OrderIntent } from "@arena/shared";
import type { Db } from "../client.ts";
import { fills, orders } from "../schema.ts";
import { clampLimit } from "./util.ts";

export interface OrderRecord {
  /** Flash order id. */
  id: string;
  /** Null for manual terminal trades. */
  agentId: string | null;
  funderAddress: string;
  side: OrderIntent["side"];
  asset: string;
  orderType: FlashOrderType;
  notionalUsd: number;
  status: string;
  raw?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface FillRecord {
  id: string;
  orderId: string;
  price: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  integratorFeeUsd: number;
  txId: string | null;
  ts: number;
}

/** Inserts or updates an order by Flash id. Updates status, raw and updatedAt only. */
export async function upsertOrder(db: Db, order: OrderRecord): Promise<void> {
  const values = {
    id: order.id,
    agentId: order.agentId,
    funderAddress: order.funderAddress.toLowerCase(),
    side: order.side,
    asset: order.asset,
    orderType: order.orderType,
    notionalUsd: order.notionalUsd,
    status: order.status,
    raw: order.raw ?? {},
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
  await db
    .insert(orders)
    .values(values)
    .onConflictDoUpdate({
      target: orders.id,
      set: {
        status: order.status,
        updatedAt: order.updatedAt,
        ...(order.raw !== undefined ? { raw: order.raw } : {}),
      },
    });
}

/** Inserts fills. Idempotent on fill id, so re-delivered WebSocket events are harmless. */
export async function insertFills(db: Db, rows: FillRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(fills)
    .values(
      rows.map((f) => ({
        id: f.id,
        orderId: f.orderId,
        price: f.price,
        qty: f.qty,
        notionalUsd: f.notionalUsd,
        feeUsd: f.feeUsd,
        integratorFeeUsd: f.integratorFeeUsd,
        txId: f.txId,
        ts: f.ts,
      })),
    )
    .onConflictDoNothing({ target: fills.id });
}

/** Newest-first fills for orders placed by an agent. */
export async function listFillsByAgent(db: Db, agentId: string, limit?: number): Promise<FillRecord[]> {
  const rows = await db
    .select({ fill: fills })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.agentId, agentId))
    .orderBy(desc(fills.ts))
    .limit(clampLimit(limit, 100, 1000));
  return rows.map((r) => toFill(r.fill));
}

/** Newest-first fills for a funder (a human wallet or an agent trading wallet). */
export async function listFillsByFunder(db: Db, funderAddress: string, limit?: number): Promise<FillRecord[]> {
  const rows = await db
    .select({ fill: fills })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.funderAddress, funderAddress.toLowerCase()))
    .orderBy(desc(fills.ts))
    .limit(clampLimit(limit, 100, 1000));
  return rows.map((r) => toFill(r.fill));
}

function toFill(row: typeof fills.$inferSelect): FillRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    price: row.price,
    qty: row.qty,
    notionalUsd: row.notionalUsd,
    feeUsd: row.feeUsd,
    integratorFeeUsd: row.integratorFeeUsd,
    txId: row.txId,
    ts: row.ts,
  };
}
