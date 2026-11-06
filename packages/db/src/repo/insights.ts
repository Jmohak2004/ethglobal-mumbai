import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { InsightSource } from "@arena/shared";
import type { Db } from "../client.ts";
import { insightDigests, insightItems } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

export type InsightStance = "bullish" | "bearish" | "neutral";

export interface InsightItemInput {
  id?: string;
  sourceKind: InsightSource["kind"];
  /** Agent id for agent sources, feed url for RSS. */
  sourceRef?: string | null;
  asset?: string | null;
  body: string;
  url?: string | null;
  /** Unix ms. Defaults to now. */
  ts?: number | null;
  raw?: Record<string, unknown>;
}

export interface InsightItemRecord {
  id: string;
  sourceKind: InsightSource["kind"];
  sourceRef: string | null;
  asset: string | null;
  body: string;
  url: string | null;
  ts: number | null;
  raw: Record<string, unknown>;
}

export interface RecentInsightQuery {
  /** Items an agent published (sourceKind "agent", sourceRef = agent id). */
  agentId?: string;
  /** Items tagged with any of these assets. */
  assets?: string[];
  /** Unix ms. Only items with ts >= since. */
  since: number;
  /** Default 100, max 500. */
  limit?: number;
}

/** Inserts raw insight items. Idempotent on id. Returns the ids in input order. */
export async function insertInsightItems(db: Db, items: InsightItemInput[]): Promise<string[]> {
  if (items.length === 0) return [];
  const now = Date.now();
  const ids = items.map((item) => item.id ?? newId());
  await db
    .insert(insightItems)
    .values(
      items.map((item, i) => ({
        id: ids[i] ?? newId(),
        sourceKind: item.sourceKind,
        sourceRef: item.sourceRef ?? null,
        asset: item.asset ?? null,
        body: item.body,
        url: item.url ?? null,
        ts: item.ts === undefined ? now : item.ts,
        raw: item.raw ?? {},
      })),
    )
    .onConflictDoNothing({ target: insightItems.id });
  return ids;
}

/**
 * Newest-first items since a time, matching any of the given assets and/or the given agent's own posts.
 * Returns an empty list when neither assets nor agentId is given.
 */
export async function listRecentInsightItems(db: Db, query: RecentInsightQuery): Promise<InsightItemRecord[]> {
  const byAsset = query.assets && query.assets.length > 0 ? inArray(insightItems.asset, query.assets) : undefined;
  const byAgent = query.agentId
    ? and(eq(insightItems.sourceKind, "agent"), eq(insightItems.sourceRef, query.agentId))
    : undefined;
  const scope = or(byAsset, byAgent);
  if (!scope) return [];

  const rows = await db
    .select()
    .from(insightItems)
    .where(and(gte(insightItems.ts, query.since), scope))
    .orderBy(desc(insightItems.ts), asc(insightItems.id))
    .limit(clampLimit(query.limit, 100, 500));
  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.sourceKind as InsightSource["kind"],
    sourceRef: r.sourceRef,
    asset: r.asset,
    body: r.body,
    url: r.url,
    ts: r.ts,
    raw: r.raw,
  }));
}

export interface InsightDigestInput {
  id?: string;
  /** The agent the digest is for. Null for platform-wide digests. */
  agentId?: string | null;
  asset: string;
  stance: InsightStance;
  confidence: number;
  sourceIds?: string[];
  zgRequestId?: string | null;
  /** Unix ms. Defaults to now. */
  ts?: number;
}

export interface InsightDigestRecord {
  id: string;
  agentId: string | null;
  asset: string;
  stance: InsightStance;
  confidence: number;
  sourceIds: string[];
  zgRequestId: string | null;
  ts: number;
}

/** Stores one digest (one asset). Idempotent on id. Returns the id. */
export async function insertInsightDigest(db: Db, input: InsightDigestInput): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(insightDigests)
    .values({
      id,
      agentId: input.agentId ?? null,
      asset: input.asset,
      stance: input.stance,
      confidence: input.confidence,
      sourceIds: input.sourceIds ?? [],
      zgRequestId: input.zgRequestId ?? null,
      ts: input.ts ?? Date.now(),
    })
    .onConflictDoNothing({ target: insightDigests.id });
  return id;
}

/**
 * The newest digest for an agent, optionally for one asset. Null when the agent has none.
 * The decision loop calls this once per configured asset.
 */
export async function latestInsightDigest(
  db: Db,
  agentId: string,
  opts: { asset?: string } = {},
): Promise<InsightDigestRecord | null> {
  const conditions = [eq(insightDigests.agentId, agentId)];
  if (opts.asset !== undefined) conditions.push(eq(insightDigests.asset, opts.asset));
  const [row] = await db
    .select()
    .from(insightDigests)
    .where(and(...conditions))
    .orderBy(desc(insightDigests.ts), desc(insightDigests.id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agentId,
    asset: row.asset,
    stance: row.stance as InsightStance,
    confidence: row.confidence,
    sourceIds: row.sourceIds,
    zgRequestId: row.zgRequestId,
    ts: row.ts,
  };
}
