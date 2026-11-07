import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ExecutionMode, PerformanceStats, TemplateId } from "@arena/shared";
import type { Db } from "../client.ts";
import { agentStats, forks } from "../schema.ts";
import { clampLimit, hex } from "./util.ts";

/** One leaderboard entity's all-time stats. Written by the stats job (CRE WF1 output or local computation). */
export interface StatsInput {
  entityId: string;
  kind: "agent" | "human";
  name: string;
  template: TemplateId | null;
  mode: ExecutionMode;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  /** Open lots marked to the live price. Default 0. */
  unrealizedPnlUsd?: number;
  /** Realized + unrealized, the number the leaderboard ranks by. Defaults to realizedPnlUsd + unrealizedPnlUsd. */
  totalPnlUsd?: number;
  /** Defaults to realizedPnlPct. */
  totalPnlPct?: number;
  volumeUsd: number;
  trades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  forecastHitRateBps: number;
  daysActive: number;
  /**
   * CRE verification. undefined keeps the stored verification, null clears it, and an object sets it.
   * Use markStatsVerified to change only the verification.
   */
  verified?: { reportTx: `0x${string}`; asOf: number } | null;
  /** undefined keeps the stored flag. */
  selfFunded?: boolean;
  /** Defaults to now. */
  updatedAt?: number;
}

/**
 * Creates or updates stats rows by entityId. Idempotent. Fields that are not provided (undefined) keep
 * their stored value, so a recompute does not drop a CRE verification.
 */
export async function upsertStats(db: Db, rows: StatsInput[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const base = {
        kind: r.kind,
        name: r.name,
        template: r.template,
        mode: r.mode,
        realizedPnlUsd: r.realizedPnlUsd,
        pnlPct: r.realizedPnlPct,
        unrealizedPnlUsd: r.unrealizedPnlUsd ?? 0,
        totalPnlUsd: r.totalPnlUsd ?? r.realizedPnlUsd + (r.unrealizedPnlUsd ?? 0),
        totalPnlPct: r.totalPnlPct ?? r.realizedPnlPct,
        volumeUsd: r.volumeUsd,
        trades: r.trades,
        winRateBps: r.winRateBps,
        maxDrawdownBps: r.maxDrawdownBps,
        forecastHitRateBps: r.forecastHitRateBps,
        daysActive: r.daysActive,
        updatedAt: r.updatedAt ?? now,
      };
      const set: Partial<typeof agentStats.$inferInsert> = { ...base };
      if (r.verified !== undefined) {
        set.verifiedTx = r.verified?.reportTx ?? null;
        set.verifiedAsOf = r.verified?.asOf ?? null;
      }
      if (r.selfFunded !== undefined) set.selfFunded = r.selfFunded;

      await tx
        .insert(agentStats)
        .values({
          entityId: r.entityId,
          ...base,
          verifiedTx: r.verified?.reportTx ?? null,
          verifiedAsOf: r.verified?.asOf ?? null,
          selfFunded: r.selfFunded ?? false,
        })
        .onConflictDoUpdate({ target: agentStats.entityId, set });
    }
  });
}

/**
 * Records a CRE verification on an existing stats row and leaves every other field alone.
 * Returns false when the entity has no stats row yet.
 */
export async function markStatsVerified(
  db: Db,
  entityId: string,
  verified: { reportTx: `0x${string}`; asOf: number },
): Promise<boolean> {
  const rows = await db
    .update(agentStats)
    .set({ verifiedTx: verified.reportTx, verifiedAsOf: verified.asOf, updatedAt: Date.now() })
    .where(eq(agentStats.entityId, entityId))
    .returning({ entityId: agentStats.entityId });
  return rows.length > 0;
}

export interface LeaderboardQuery {
  /** "all" or omitted returns agents and humans. */
  kind?: "agent" | "human" | "all";
  template?: TemplateId;
  mode?: ExecutionMode;
  /** Default 50, max 500. */
  limit?: number;
}

/**
 * Leaderboard rows (stats only, no trades or configs), sorted by total PnL USD (realized + unrealized) descending.
 * forkCount is computed live from the forks table.
 */
export async function leaderboard(db: Db, query: LeaderboardQuery = {}): Promise<PerformanceStats[]> {
  const conditions = [];
  if (query.kind && query.kind !== "all") conditions.push(eq(agentStats.kind, query.kind));
  if (query.template) conditions.push(eq(agentStats.template, query.template));
  if (query.mode) conditions.push(eq(agentStats.mode, query.mode));

  const forkCount = sql<number>`(select count(*)::int from ${forks} where ${forks.agentId} = ${agentStats.entityId})`;

  const rows = await db
    .select({ stat: agentStats, forkCount })
    .from(agentStats)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentStats.totalPnlUsd), desc(agentStats.realizedPnlUsd), asc(agentStats.entityId))
    .limit(clampLimit(query.limit, 50, 500));

  return rows.map(({ stat: s, forkCount: fc }) => ({
    entityId: s.entityId,
    kind: s.kind as PerformanceStats["kind"],
    name: s.name,
    template: (s.template as TemplateId | null) ?? null,
    realizedPnlUsd: s.realizedPnlUsd,
    realizedPnlPct: s.pnlPct,
    unrealizedPnlUsd: s.unrealizedPnlUsd,
    totalPnlUsd: s.totalPnlUsd,
    totalPnlPct: s.totalPnlPct,
    volumeUsd: s.volumeUsd,
    trades: s.trades,
    winRateBps: s.winRateBps,
    maxDrawdownBps: s.maxDrawdownBps,
    forecastHitRateBps: s.forecastHitRateBps,
    forkCount: Number(fc ?? 0),
    daysActive: s.daysActive,
    mode: s.mode as ExecutionMode,
    verified: s.verifiedTx && s.verifiedAsOf !== null ? { reportTx: hex(s.verifiedTx), asOf: s.verifiedAsOf } : null,
    selfFunded: s.selfFunded,
  }));
}
