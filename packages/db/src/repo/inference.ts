import { and, eq, gte, sql } from "drizzle-orm";
import type { InferenceTrace } from "@arena/shared";
import type { Db } from "../client.ts";
import { inferenceCalls, zgKeys } from "../schema.ts";

export interface InferenceContext {
  agentId?: string | null;
  userAddress?: string | null;
  /** decision | digest | reflection | image | share | ... */
  purpose?: string;
  ts?: number;
}

/** Records a 0G call. Idempotent on requestId. */
export async function insertInference(db: Db, trace: InferenceTrace, ctx: InferenceContext = {}): Promise<void> {
  await db
    .insert(inferenceCalls)
    .values({
      requestId: trace.requestId,
      agentId: ctx.agentId ?? null,
      userAddress: ctx.userAddress ?? null,
      model: trace.model,
      provider: trace.provider,
      billing: trace.billing,
      teeVerified: trace.teeVerified,
      latencyMs: trace.latencyMs,
      payer: trace.payer,
      purpose: ctx.purpose ?? "decision",
      ts: ctx.ts ?? Date.now(),
    })
    .onConflictDoNothing({ target: inferenceCalls.requestId });
}

/**
 * Sum of billing for an agent's calls since ts, as a decimal string (no precision loss). Returns "0"
 * when there are none. Used for the AGENT_DAILY_0G_CAP check and budget tiers.
 */
export async function sumBillingSince(db: Db, agentId: string, since: number): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${inferenceCalls.billing}::numeric), 0)::text`,
    })
    .from(inferenceCalls)
    .where(and(eq(inferenceCalls.agentId, agentId), gte(inferenceCalls.ts, since)));
  return row?.total ?? "0";
}

export interface ZgKeyRecord {
  keyId: string;
  agentId: string;
  creditLimit: number;
  resetPeriod: string;
  createdAt: number;
}

/** Stores a minted 0G key's public metadata. The sk- secret must never be passed here. */
export async function insertZgKey(db: Db, key: ZgKeyRecord): Promise<void> {
  await db
    .insert(zgKeys)
    .values({
      keyId: key.keyId,
      agentId: key.agentId,
      creditLimit: key.creditLimit,
      resetPeriod: key.resetPeriod,
      createdAt: key.createdAt,
    })
    .onConflictDoNothing({ target: zgKeys.keyId });
}

export async function listZgKeys(db: Db, agentId: string): Promise<ZgKeyRecord[]> {
  const rows = await db.select().from(zgKeys).where(eq(zgKeys.agentId, agentId));
  return rows.map((r) => ({
    keyId: r.keyId,
    agentId: r.agentId,
    creditLimit: r.creditLimit,
    resetPeriod: r.resetPeriod,
    createdAt: r.createdAt,
  }));
}
