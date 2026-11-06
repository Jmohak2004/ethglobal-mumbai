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
  volumeUsd: number;
  trades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  forecastHitRateBps: number;
  daysActive: number;
  verified: { reportTx: `0x${string}`; asOf: number } | null;
  selfFunded: boolean;
  /** Defaults to now. */
  updatedAt?: number;
}

/** Creates or replaces stats rows by entityId. Idempotent. */
export async function upsertStats(db: Db, rows: StatsInput[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const values = rows.map((r) => ({
    entityId: r.entityId,
    kind: r.kind,
    name: r.name,
    template: r.template,
    mode: r.mode,
    realizedPnlUsd: r.realizedPnlUsd,
    pnlPct: r.realizedPnlPct,
    volumeUsd: r.volumeUsd,
    trades: r.trades,
    winRateBps: r.winRateBps,
    maxDrawdownBps: r.maxDrawdownBps,
    forecastHitRateBps: r.forecastHitRateBps,
    daysActive: r.daysActive,
    verifiedTx: r.verified?.reportTx ?? null,
    verifiedAsOf: r.verified?.asOf ?? null,
    selfFunded: r.selfFunded,
    updatedAt: r.updatedAt ?? now,
  }));
  await db.transaction(async (tx) => {
    for (const v of values) {
      const { entityId, ...set } = v;
      await tx.insert(agentStats).values(v).onConflictDoUpdate({ target: agentStats.entityId, set });
    }
  });
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
 * Leaderboard rows (stats only, no trades or configs), sorted by realized PnL USD descending.
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
    .orderBy(desc(agentStats.realizedPnlUsd), asc(agentStats.entityId))
    .limit(clampLimit(query.limit, 50, 500));

  return rows.map(({ stat: s, forkCount: fc }) => ({
    entityId: s.entityId,
    kind: s.kind as PerformanceStats["kind"],
    name: s.name,
    template: (s.template as TemplateId | null) ?? null,
    realizedPnlUsd: s.realizedPnlUsd,
    realizedPnlPct: s.pnlPct,
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
