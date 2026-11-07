import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FlashOrderType, OrderIntent } from "@arena/shared";
import type { Db } from "../client.ts";
import { agents, agentStats, fills, orders, users } from "../schema.ts";
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

/** One fill with who made it, for the public trades feed. */
export interface RecentFill extends FillRecord {
  asset: string;
  side: OrderIntent["side"];
  orderType: FlashOrderType;
  funderAddress: string;
  /** Null for a human's manual trade. */
  agentId: string | null;
  agentName: string | null;
  /** A human's display name, only when they opted into the Humans board. Null otherwise (show a short address). */
  humanName: string | null;
  /** True for a simulated fill. Its txId is the TradeJournal tx on Base Sepolia. Live fills carry the settlement tx. */
  paper: boolean;
}

/** Keyset cursor for listRecentFills: the (ts, id) of the last row of the previous page. */
export interface FillCursor {
  ts: number;
  id: string;
}

/**
 * Newest-first fills across every trader (agents and humans), with the order, agent name and, for opted-in humans,
 * their display name. Optionally one agent only. `before` pages past a cursor (strictly older rows).
 */
export async function listRecentFills(
  db: Db,
  opts: { limit?: number; agentId?: string; before?: FillCursor } = {},
): Promise<RecentFill[]> {
  const conds = [];
  if (opts.agentId) conds.push(eq(orders.agentId, opts.agentId));
  if (opts.before) {
    conds.push(or(lt(fills.ts, opts.before.ts), and(eq(fills.ts, opts.before.ts), lt(fills.id, opts.before.id))));
  }
  const rows = await db
    .select({
      fill: fills,
      order: orders,
      agentName: agents.name,
      humanName: agentStats.name,
      optIn: users.humansBoardOptIn,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .leftJoin(agents, eq(agents.id, orders.agentId))
    .leftJoin(users, eq(users.address, orders.funderAddress))
    .leftJoin(agentStats, and(eq(agentStats.entityId, orders.funderAddress), eq(agentStats.kind, "human")))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(fills.ts), desc(fills.id))
    .limit(clampLimit(opts.limit, 100, 200));
  return rows.map((r) => ({
    ...toFill(r.fill),
    asset: r.order.asset,
    side: r.order.side as OrderIntent["side"],
    orderType: r.order.orderType as FlashOrderType,
    funderAddress: r.order.funderAddress,
    agentId: r.order.agentId,
    agentName: r.agentName ?? null,
    humanName: r.order.agentId === null && r.optIn ? (r.humanName ?? null) : null,
    paper: r.order.raw?.paper === true,
  }));
}

/** Totals over every fill (or one agent's): count, USD volume and how many already carry a tx hash. */
export async function fillsSummary(
  db: Db,
  opts: { agentId?: string } = {},
): Promise<{ trades: number; volumeUsd: number; journaled: number }> {
  const [row] = await db
    .select({
      trades: sql<number>`count(*)::int`,
      volumeUsd: sql<number>`coalesce(sum(${fills.notionalUsd}), 0)::float8`,
      journaled: sql<number>`count(${fills.txId})::int`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(opts.agentId ? eq(orders.agentId, opts.agentId) : undefined);
  return { trades: Number(row?.trades ?? 0), volumeUsd: Number(row?.volumeUsd ?? 0), journaled: Number(row?.journaled ?? 0) };
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

/** A paper fill still waiting for its onchain journal tx, with the order fields the journal records. */
export interface UnjournaledPaperFill {
  fill: FillRecord;
  orderId: string;
  /** Null for a human's manual paper fill. */
  agentId: string | null;
  funderAddress: string;
  side: OrderIntent["side"];
  asset: string;
  /** Flash quote id the simulated price came from, when there was one (exits have none). */
  quoteId: string | null;
}

/**
 * Paper fills (agent and human) whose tx_id is still null, oldest first. This is the journal's queue: a fill stays
 * here until setFillTxId stores its tx hash, so fills from before the journal existed and fills from before a
 * restart are picked up without any extra state.
 */
export async function listUnjournaledPaperFills(db: Db, limit?: number): Promise<UnjournaledPaperFill[]> {
  const rows = await db
    .select({ fill: fills, order: orders })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(isNull(fills.txId), sql`${orders.raw}->>'paper' = 'true'`))
    .orderBy(asc(fills.ts), asc(fills.id))
    .limit(clampLimit(limit, 20, 500));
  return rows.map((r) => ({
    fill: toFill(r.fill),
    orderId: r.order.id,
    agentId: r.order.agentId,
    funderAddress: r.order.funderAddress,
    side: r.order.side as OrderIntent["side"],
    asset: r.order.asset,
    quoteId: typeof r.order.raw?.quoteId === "string" ? r.order.raw.quoteId : null,
  }));
}

/**
 * Stores the journal tx hash on the given fills. Fills that already hold a tx hash are left alone, so a
 * re-run never overwrites a settlement or journal tx. Returns the number of fills updated.
 */
export async function setFillTxId(db: Db, fillIds: string[], txId: string): Promise<number> {
  if (fillIds.length === 0) return 0;
  const rows = await db
    .update(fills)
    .set({ txId })
    .where(and(inArray(fills.id, fillIds), isNull(fills.txId)))
    .returning({ id: fills.id });
  return rows.length;
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
