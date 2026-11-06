import { count, desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { forks } from "../schema.ts";
import { ensureUser } from "./users.ts";
import { addr, hex, newId } from "./util.ts";

export interface ForkRecord {
  id: string;
  /** Source agent that was forked. */
  agentId: string;
  buyer: string;
  priceUsd: number;
  txHash: `0x${string}`;
  configHash: `0x${string}`;
  newAgentId: string | null;
  createdAt: number;
}

/**
 * Records a fork (from the StrategyMarketplace Forked event). Idempotent on txHash.
 * Returns the stored record, or null if this tx was already recorded.
 */
export async function insertFork(
  db: Db,
  input: Omit<ForkRecord, "id" | "buyer" | "createdAt" | "newAgentId"> & {
    id?: string;
    buyer: string;
    newAgentId?: string | null;
    createdAt?: number;
  },
): Promise<ForkRecord | null> {
  const buyer = addr(input.buyer);
  const createdAt = input.createdAt ?? Date.now();
  return db.transaction(async (tx) => {
    await ensureUser(tx, buyer, createdAt);
    const [row] = await tx
      .insert(forks)
      .values({
        id: input.id ?? newId(),
        agentId: input.agentId,
        buyer,
        priceUsd: input.priceUsd,
        txHash: input.txHash,
        configHash: input.configHash,
        newAgentId: input.newAgentId ?? null,
        createdAt,
      })
      .onConflictDoNothing({ target: forks.txHash })
      .returning();
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agentId,
      buyer: row.buyer,
      priceUsd: row.priceUsd,
      txHash: hex(row.txHash),
      configHash: hex(row.configHash),
      newAgentId: row.newAgentId,
      createdAt: row.createdAt,
    };
  });
}

export async function countForks(db: Db, agentId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(forks).where(eq(forks.agentId, agentId));
  return row ? Number(row.n) : 0;
}

/** Forks a buyer has purchased, newest first. */
export async function listForksByBuyer(db: Db, buyer: string): Promise<ForkRecord[]> {
  const rows = await db
    .select()
    .from(forks)
    .where(eq(forks.buyer, addr(buyer)))
    .orderBy(desc(forks.createdAt));
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    buyer: row.buyer,
    priceUsd: row.priceUsd,
    txHash: hex(row.txHash),
    configHash: hex(row.configHash),
    newAgentId: row.newAgentId,
    createdAt: row.createdAt,
  }));
}
