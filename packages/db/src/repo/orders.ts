import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FlashOrderType, OrderIntent } from "@arena/shared";
import type { Db } from "../client.ts";
import { fills, orders } from "../schema.ts";
import { addr, clampLimit, newId } from "./util.ts";

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

// ---- Paper (simulated) manual trades from the web terminal. Human-only: agentId is null and raw.paper is true. ----

/** Paper order ids carry this prefix so they can never collide with a Flash order id (a UUID). */
const PAPER_ORDER_PREFIX = "paper_";

export interface PaperFillInput {
  funderAddress: string;
  side: OrderIntent["side"];
  asset: string;
  orderType: FlashOrderType;
  /** Notional the paper quote was priced for. qty = notionalUsd / priceUsd. */
  notionalUsd: number;
  priceUsd: number;
  /** Total fee from the paper quote (integrator fee plus the Flash fee estimate). */
  feeUsd: number;
  integratorFeeUsd: number;
  /** Flash quote id the paper price came from, when there was one. */
  quoteId?: string | null;
  /** Defaults to now. */
  ts?: number;
}

export interface PaperFillRecord extends FillRecord {
  orderId: string;
  asset: string;
  side: OrderIntent["side"];
  orderType: FlashOrderType;
  funderAddress: string;
}

/**
 * Records one paper fill: an order (status "filled", no agent, raw.paper true) and its single fill, in one
 * transaction. Nothing is sent anywhere. Returns the stored ids.
 */
export async function insertPaperFill(db: Db, input: PaperFillInput): Promise<{ orderId: string; fillId: string }> {
  if (!(input.priceUsd > 0) || !Number.isFinite(input.priceUsd)) throw new Error("insertPaperFill: priceUsd must be positive");
  const now = input.ts ?? Date.now();
  const orderId = `${PAPER_ORDER_PREFIX}${newId()}`;
  const fillId = `${orderId}:fill`;
  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      agentId: null,
      funderAddress: addr(input.funderAddress),
      side: input.side,
      asset: input.asset,
      orderType: input.orderType,
      notionalUsd: input.notionalUsd,
      status: "filled",
      raw: { paper: true, quoteId: input.quoteId ?? null },
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(fills).values({
      id: fillId,
      orderId,
      price: input.priceUsd,
      qty: input.notionalUsd / input.priceUsd,
      notionalUsd: input.notionalUsd,
      feeUsd: input.feeUsd,
      integratorFeeUsd: input.integratorFeeUsd,
      txId: null,
      ts: now,
    });
  });
  return { orderId, fillId };
}

/** Newest-first paper fills for one funder. Human trades only (agentId null). */
export async function listPaperFillsByFunder(db: Db, funderAddress: string, limit?: number): Promise<PaperFillRecord[]> {
  const rows = await db
    .select({ fill: fills, order: orders })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(
        eq(orders.funderAddress, addr(funderAddress)),
        isNull(orders.agentId),
        sql`${orders.raw}->>'paper' = 'true'`,
      ),
    )
    .orderBy(desc(fills.ts))
    .limit(clampLimit(limit, 100, 500));
  return rows.map((r) => ({
    ...toFill(r.fill),
    orderId: r.order.id,
    asset: r.order.asset,
    side: r.order.side as OrderIntent["side"],
    orderType: r.order.orderType as FlashOrderType,
    funderAddress: r.order.funderAddress,
  }));
}

/**
 * Marks the funder's own open paper orders as cancelled. Ids that are not open paper orders of this funder are
 * skipped. Returns the ids that changed. Nothing is sent to Flash.
 */
export async function cancelPaperOrders(db: Db, funderAddress: string, orderIds: string[], now: number = Date.now()): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .update(orders)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(orders.funderAddress, addr(funderAddress)),
        inArray(orders.id, orderIds),
        isNull(orders.agentId),
        inArray(orders.status, ["open", "partially_filled"]),
        sql`${orders.raw}->>'paper' = 'true'`,
      ),
    )
    .returning({ id: orders.id });
  return rows.map((r) => r.id);
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
