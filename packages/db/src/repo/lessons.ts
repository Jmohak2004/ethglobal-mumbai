import { and, desc, eq, lte } from "drizzle-orm";
import type { Lesson } from "@arena/shared";
import type { Db } from "../client.ts";
import { lessons } from "../schema.ts";
import { clampLimit } from "./util.ts";

/** Inserts a lesson. Idempotent on id. */
export async function insertLesson(db: Db, lesson: Lesson): Promise<void> {
  await db
    .insert(lessons)
    .values({
      id: lesson.id,
      agentId: lesson.agentId,
      ts: lesson.ts,
      lesson: lesson.lesson,
      evidenceEpisodeIds: lesson.evidenceEpisodeIds,
      confidence: lesson.confidence,
      appliesTo: lesson.appliesTo,
      zgStorageRoot: lesson.zgStorageRoot,
    })
    .onConflictDoNothing({ target: lessons.id });
}

/**
 * The k most confident lessons for an agent, for injection into future ticks. Pass asOf to get the
 * set as of a point in time (e.g. a forker's fork time, PRD 6.6).
 */
export async function topForAgent(
  db: Db,
  agentId: string,
  opts: { k?: number; asOf?: number } = {},
): Promise<Lesson[]> {
  const conditions = [eq(lessons.agentId, agentId)];
  if (opts.asOf !== undefined) conditions.push(lte(lessons.ts, opts.asOf));
  const rows = await db
    .select()
    .from(lessons)
    .where(and(...conditions))
    .orderBy(desc(lessons.confidence), desc(lessons.ts))
    .limit(clampLimit(opts.k, 5, 50));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    ts: r.ts,
    lesson: r.lesson,
    evidenceEpisodeIds: r.evidenceEpisodeIds,
    confidence: r.confidence,
    appliesTo: r.appliesTo,
    zgStorageRoot: r.zgStorageRoot,
  }));
}
