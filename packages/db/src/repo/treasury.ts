import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { topups, treasuryEvents } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

export interface TopupRecord {
  id: string;
  agentId: string;
  /** TopUpRequested nonce as decimal text. Null for top-ups recorded before the nonce is known. */
  nonce: string | null;
  usdcAmount: number;
  baseTx: string | null;
  zgTransferTx: string | null;
  depositTx: string | null;
  firstPaidRequestId: string | null;
  status: string;
  ts: number;
  updatedAt: number;
}

export interface TopupPatch {
  status?: string;
  baseTx?: string | null;
  zgTransferTx?: string | null;
  depositTx?: string | null;
  firstPaidRequestId?: string | null;
}

export interface CreateTopupInput {
  id?: string;
  agentId: string;
  /** The TopUpRequested nonce. Unique per agent when set, which makes creation idempotent. */
  nonce?: bigint | number | string | null;
  usdcAmount: number;
  baseTx?: string | null;
  zgTransferTx?: string | null;
  depositTx?: string | null;
  firstPaidRequestId?: string | null;
  status?: string;
  ts?: number;
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

const normalizeNonce = (nonce: CreateTopupInput["nonce"]): string | null => {
  if (nonce === undefined || nonce === null) return null;
  const text = String(nonce);
  if (!/^\d+$/.test(text)) throw new Error(`topup nonce must be a non-negative integer, got ${text}`);
  return text;
};

export async function createTopup(db: Db, input: CreateTopupInput): Promise<TopupRecord> {
  const ts = input.ts ?? Date.now();
  const [row] = await db
    .insert(topups)
    .values({
      id: input.id ?? newId(),
      agentId: input.agentId,
      nonce: normalizeNonce(input.nonce),
      usdcAmount: input.usdcAmount,
      baseTx: input.baseTx ?? null,
      zgTransferTx: input.zgTransferTx ?? null,
      depositTx: input.depositTx ?? null,
      firstPaidRequestId: input.firstPaidRequestId ?? null,
      status: input.status ?? "pending",
      ts,
      updatedAt: ts,
    })
    .returning();
  if (!row) throw new Error("createTopup: insert returned no row");
  return toTopup(row);
}

/**
 * Inserts a top-up unless one already exists for the same (agent, nonce) or the same id. Returns the
 * stored row and whether this call created it. Safe to repeat: a replayed TopUpRequested log maps to the
 * existing row, so it is never recorded or relayed twice.
 */
export async function createTopupIfAbsent(
  db: Db,
  input: CreateTopupInput,
): Promise<{ topup: TopupRecord; created: boolean }> {
  const nonce = normalizeNonce(input.nonce);
  const id = input.id ?? newId();
  const ts = input.ts ?? Date.now();
  const [row] = await db
    .insert(topups)
    .values({
      id,
      agentId: input.agentId,
      nonce,
      usdcAmount: input.usdcAmount,
      baseTx: input.baseTx ?? null,
      zgTransferTx: input.zgTransferTx ?? null,
      depositTx: input.depositTx ?? null,
      firstPaidRequestId: input.firstPaidRequestId ?? null,
      status: input.status ?? "pending",
      ts,
      updatedAt: ts,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { topup: toTopup(row), created: true };

  const existing =
    (nonce !== null ? await getTopupByNonce(db, input.agentId, nonce) : null) ?? (await getTopupById(db, id));
  if (!existing) throw new Error("createTopupIfAbsent: insert conflicted but no matching top-up exists");
  return { topup: existing, created: false };
}

/** The top-up for a TopUpRequested nonce, or null. */
export async function getTopupByNonce(
  db: Db,
  agentId: string,
  nonce: bigint | number | string,
): Promise<TopupRecord | null> {
  const [row] = await db
    .select()
    .from(topups)
    .where(and(eq(topups.agentId, agentId), eq(topups.nonce, normalizeNonce(nonce) ?? "")))
    .limit(1);
  return row ? toTopup(row) : null;
}

async function getTopupById(db: Db, id: string): Promise<TopupRecord | null> {
  const [row] = await db.select().from(topups).where(eq(topups.id, id)).limit(1);
  return row ? toTopup(row) : null;
}

/** Updates status and tx references as the relayer progresses. Returns null if the top-up is unknown. */
export async function updateTopup(db: Db, id: string, patch: TopupPatch): Promise<TopupRecord | null> {
  const set: Partial<typeof topups.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.baseTx !== undefined) set.baseTx = patch.baseTx;
  if (patch.zgTransferTx !== undefined) set.zgTransferTx = patch.zgTransferTx;
  if (patch.depositTx !== undefined) set.depositTx = patch.depositTx;
  if (patch.firstPaidRequestId !== undefined) set.firstPaidRequestId = patch.firstPaidRequestId;
  if (Object.keys(set).length === 0) return getTopupById(db, id);
  set.updatedAt = Date.now();
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
    nonce: row.nonce,
    usdcAmount: row.usdcAmount,
    baseTx: row.baseTx,
    zgTransferTx: row.zgTransferTx,
    depositTx: row.depositTx,
    firstPaidRequestId: row.firstPaidRequestId,
    status: row.status,
    ts: row.ts,
    updatedAt: row.updatedAt,
  };
}
