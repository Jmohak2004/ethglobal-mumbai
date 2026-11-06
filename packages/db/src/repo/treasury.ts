import { desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { topups, treasuryEvents } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

export interface TopupRecord {
  id: string;
  agentId: string;
  usdcAmount: number;
  baseTx: string | null;
  zgTransferTx: string | null;
  depositTx: string | null;
  firstPaidRequestId: string | null;
  status: string;
  ts: number;
}

export interface TopupPatch {
  status?: string;
  baseTx?: string | null;
  zgTransferTx?: string | null;
  depositTx?: string | null;
  firstPaidRequestId?: string | null;
}

export interface TreasuryEventRecord {
  id: string;
  agentId: string;
  kind: string;
  amountUsd: number;
  txHash: string | null;
  meta: Record<string, unknown>;
  ts: number;
}

export async function createTopup(
  db: Db,
  input: Omit<TopupRecord, "id" | "status" | "ts"> & { id?: string; status?: string; ts?: number },
): Promise<TopupRecord> {
  const [row] = await db
    .insert(topups)
    .values({
      id: input.id ?? newId(),
      agentId: input.agentId,
      usdcAmount: input.usdcAmount,
      baseTx: input.baseTx,
      zgTransferTx: input.zgTransferTx,
      depositTx: input.depositTx,
      firstPaidRequestId: input.firstPaidRequestId,
      status: input.status ?? "pending",
      ts: input.ts ?? Date.now(),
    })
    .returning();
  if (!row) throw new Error("createTopup: insert returned no row");
  return toTopup(row);
}

/** Updates status and tx references as the relayer progresses. Returns null if the top-up is unknown. */
export async function updateTopup(db: Db, id: string, patch: TopupPatch): Promise<TopupRecord | null> {
  const set: Partial<typeof topups.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.baseTx !== undefined) set.baseTx = patch.baseTx;
  if (patch.zgTransferTx !== undefined) set.zgTransferTx = patch.zgTransferTx;
  if (patch.depositTx !== undefined) set.depositTx = patch.depositTx;
  if (patch.firstPaidRequestId !== undefined) set.firstPaidRequestId = patch.firstPaidRequestId;
  if (Object.keys(set).length === 0) {
    const [row] = await db.select().from(topups).where(eq(topups.id, id)).limit(1);
    return row ? toTopup(row) : null;
  }
  const [row] = await db.update(topups).set(set).where(eq(topups.id, id)).returning();
  return row ? toTopup(row) : null;
}

export async function listTopupsByAgent(db: Db, agentId: string, limit?: number): Promise<TopupRecord[]> {
  const rows = await db
    .select()
    .from(topups)
    .where(eq(topups.agentId, agentId))
    .orderBy(desc(topups.ts))
    .limit(clampLimit(limit, 50, 500));
  return rows.map(toTopup);
}

export async function insertTreasuryEvent(
  db: Db,
  input: Omit<TreasuryEventRecord, "id" | "meta" | "ts"> & {
    id?: string;
    meta?: Record<string, unknown>;
    ts?: number;
  },
): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(treasuryEvents)
    .values({
      id,
      agentId: input.agentId,
      kind: input.kind,
      amountUsd: input.amountUsd,
      txHash: input.txHash,
      meta: input.meta ?? {},
      ts: input.ts ?? Date.now(),
    })
    .onConflictDoNothing({ target: treasuryEvents.id });
  return id;
}

export async function listTreasuryEvents(db: Db, agentId: string, limit?: number): Promise<TreasuryEventRecord[]> {
  const rows = await db
    .select()
    .from(treasuryEvents)
    .where(eq(treasuryEvents.agentId, agentId))
    .orderBy(desc(treasuryEvents.ts))
    .limit(clampLimit(limit, 50, 500));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    kind: r.kind,
    amountUsd: r.amountUsd,
    txHash: r.txHash,
    meta: r.meta,
    ts: r.ts,
  }));
}

function toTopup(row: typeof topups.$inferSelect): TopupRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    usdcAmount: row.usdcAmount,
    baseTx: row.baseTx,
    zgTransferTx: row.zgTransferTx,
    depositTx: row.depositTx,
    firstPaidRequestId: row.firstPaidRequestId,
    status: row.status,
    ts: row.ts,
  };
}
