import { and, desc, eq, lt } from "drizzle-orm";
import type { Episode, RiskLevel, BudgetTier } from "@arena/shared";
import type { Db } from "../client.ts";
import { episodes } from "../schema.ts";
import { clampLimit } from "./util.ts";

type EpisodeRow = typeof episodes.$inferSelect;

/** Inserts an episode. Idempotent on id (a retried tick does not duplicate it). */
export async function insertEpisode(db: Db, ep: Episode): Promise<void> {
  await db
    .insert(episodes)
    .values({
      id: ep.id,
      agentId: ep.agentId,
      ts: ep.ts,
      riskLevel: ep.riskLevel,
      budgetTier: ep.budgetTier,
      market: ep.market,
      decision: ep.decision,
      inference: ep.inference,
      zgRequestId: ep.inference?.requestId ?? null,
      verdict: ep.verdict,
      flashOrderIds: ep.flashOrderIds,
      zgStorageRoot: ep.zgStorageRoot,
      error: ep.error,
    })
    .onConflictDoNothing({ target: episodes.id });
}

export async function getEpisode(db: Db, id: string): Promise<Episode | null> {
  const [row] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  return row ? toEpisode(row) : null;
}

/**
 * Newest-first page of an agent's episodes. Pass the ts of the last item from the previous page as
 * beforeTs to get the next page (keyset pagination, strictly older).
 */
export async function listEpisodesByAgent(
  db: Db,
  agentId: string,
  opts: { limit?: number; beforeTs?: number } = {},
): Promise<Episode[]> {
  const conditions = [eq(episodes.agentId, agentId)];
  if (opts.beforeTs !== undefined) conditions.push(lt(episodes.ts, opts.beforeTs));
  const rows = await db
    .select()
    .from(episodes)
    .where(and(...conditions))
    .orderBy(desc(episodes.ts))
    .limit(clampLimit(opts.limit, 50, 200));
  return rows.map(toEpisode);
}

/** Records the 0G Storage root once an episode batch has been uploaded. */
export async function setEpisodeStorageRoot(db: Db, id: string, root: string): Promise<void> {
  await db.update(episodes).set({ zgStorageRoot: root }).where(eq(episodes.id, id));
}

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    agentId: row.agentId,
    ts: row.ts,
    riskLevel: row.riskLevel as RiskLevel,
    budgetTier: row.budgetTier as BudgetTier,
    market: row.market,
    decision: row.decision,
    inference: row.inference,
    verdict: row.verdict,
    flashOrderIds: row.flashOrderIds,
    zgStorageRoot: row.zgStorageRoot,
    error: row.error,
  };
}
