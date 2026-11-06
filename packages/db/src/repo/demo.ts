import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { agents, paperLedger, tickRequests, type AgentRuntimeState } from "../schema.ts";
import { newId } from "./util.ts";

// ---------------------------------------------------------------------------
// Agent runtime status (written by the worker, read by the web status panel)
// ---------------------------------------------------------------------------

export async function getAgentRuntime(db: Db, agentId: string): Promise<AgentRuntimeState> {
  const row = await db.query.agents.findFirst({ where: eq(agents.id, agentId), columns: { runtime: true } });
  return row?.runtime ?? {};
}

/** Shallow-merges the patch into agents.runtime and stamps updatedAt. */
export async function updateAgentRuntime(db: Db, agentId: string, patch: AgentRuntimeState): Promise<void> {
  const value = JSON.stringify({ ...patch, updatedAt: patch.updatedAt ?? Date.now() });
  await db
    .update(agents)
    .set({ runtime: sql`${agents.runtime} || ${value}::jsonb` })
    .where(eq(agents.id, agentId));
}

// ---------------------------------------------------------------------------
// "Run now" tick requests
// ---------------------------------------------------------------------------

export async function requestTick(db: Db, agentId: string, requestedBy: string | null, now = Date.now()): Promise<string> {
  const id = newId();
  await db.insert(tickRequests).values({ id, agentId, requestedBy, requestedAt: now, handledAt: null });
  return id;
}

/** Marks every pending request handled and returns the distinct agent ids to tick (oldest first). */
export async function claimTickRequests(db: Db, now = Date.now()): Promise<string[]> {
  const pending = await db
    .select({ id: tickRequests.id, agentId: tickRequests.agentId })
    .from(tickRequests)
    .where(isNull(tickRequests.handledAt))
    .orderBy(asc(tickRequests.requestedAt));
  if (pending.length === 0) return [];
  for (const row of pending) {
    await db
      .update(tickRequests)
      .set({ handledAt: now })
      .where(and(eq(tickRequests.id, row.id), isNull(tickRequests.handledAt)));
  }
  return [...new Set(pending.map((r) => r.agentId))];
}

export async function hasPendingTickRequest(db: Db, agentId: string): Promise<boolean> {
  const row = await db.query.tickRequests.findFirst({
    where: and(eq(tickRequests.agentId, agentId), isNull(tickRequests.handledAt)),
  });
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Paper self-funding ledger
// ---------------------------------------------------------------------------

export type PaperLedgerKind = "commission" | "topup";

export interface PaperLedgerEntry {
  id: string;
  agentId: string;
  kind: PaperLedgerKind;
  amountUsd: number;
  amount0g: number | null;
  note: string | null;
  ts: number;
}

export async function insertPaperLedger(db: Db, entry: Omit<PaperLedgerEntry, "id"> & { id?: string }): Promise<string> {
  const id = entry.id ?? newId();
  await db.insert(paperLedger).values({ ...entry, id });
  return id;
}

export async function listPaperLedger(db: Db, agentId: string, limit = 50): Promise<PaperLedgerEntry[]> {
  const rows = await db
    .select()
    .from(paperLedger)
    .where(eq(paperLedger.agentId, agentId))
    .orderBy(desc(paperLedger.ts))
    .limit(limit);
  return rows.map((r) => ({ ...r, kind: r.kind as PaperLedgerKind }));
}

/** Totals: commission earned (USD), USD spent on top-ups, 0G credited by top-ups. */
export async function paperLedgerTotals(
  db: Db,
  agentId: string,
): Promise<{ commissionUsd: number; topupUsd: number; topup0g: number; balanceUsd: number }> {
  const rows = await db
    .select({
      kind: paperLedger.kind,
      usd: sql<number>`coalesce(sum(${paperLedger.amountUsd}), 0)`,
      og: sql<number>`coalesce(sum(${paperLedger.amount0g}), 0)`,
    })
    .from(paperLedger)
    .where(eq(paperLedger.agentId, agentId))
    .groupBy(paperLedger.kind);
  const commissionUsd = Number(rows.find((r) => r.kind === "commission")?.usd ?? 0);
  const topupUsd = Number(rows.find((r) => r.kind === "topup")?.usd ?? 0);
  const topup0g = Number(rows.find((r) => r.kind === "topup")?.og ?? 0);
  return { commissionUsd, topupUsd, topup0g, balanceUsd: commissionUsd - topupUsd };
}
