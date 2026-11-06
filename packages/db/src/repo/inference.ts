import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
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
  /** AES-256-GCM ciphertext of the sk- secret, produced by the worker. Never the plaintext key. */
  encryptedSecret?: string | null;
}

/** Stores a minted 0G key. Pass only the encrypted secret; the plaintext sk- key must never reach the repo. */
export async function insertZgKey(db: Db, key: ZgKeyRecord): Promise<void> {
  await db
    .insert(zgKeys)
    .values({
      keyId: key.keyId,
      agentId: key.agentId,
      creditLimit: key.creditLimit,
      resetPeriod: key.resetPeriod,
      createdAt: key.createdAt,
      encryptedSecret: key.encryptedSecret ?? null,
    })
    .onConflictDoNothing({ target: zgKeys.keyId });
}

/** The agent's most recent key that has a stored secret, or null. */
export async function getZgKeySecret(db: Db, agentId: string): Promise<{ keyId: string; encryptedSecret: string } | null> {
  const [row] = await db
    .select({ keyId: zgKeys.keyId, encryptedSecret: zgKeys.encryptedSecret })
    .from(zgKeys)
    .where(and(eq(zgKeys.agentId, agentId), isNotNull(zgKeys.encryptedSecret)))
    .orderBy(desc(zgKeys.createdAt))
    .limit(1);
  if (!row || row.encryptedSecret === null) return null;
  return { keyId: row.keyId, encryptedSecret: row.encryptedSecret };
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
