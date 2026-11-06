import { desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { guardrailBlocks } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

export interface GuardrailBlockRecord {
  id: string;
  agentId: string;
  episodeId: string | null;
  reasons: string[];
  ts: number;
}

/** Logs a policy reject (or clamp) so the owner can see it. Returns the id. */
export async function insertGuardrailBlock(
  db: Db,
  input: { id?: string; agentId: string; episodeId?: string | null; reasons: string[]; ts?: number },
): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(guardrailBlocks)
    .values({
      id,
      agentId: input.agentId,
      episodeId: input.episodeId ?? null,
      reasons: input.reasons,
      ts: input.ts ?? Date.now(),
    })
    .onConflictDoNothing({ target: guardrailBlocks.id });
  return id;
}

export async function listGuardrailBlocks(db: Db, agentId: string, limit?: number): Promise<GuardrailBlockRecord[]> {
  const rows = await db
    .select()
    .from(guardrailBlocks)
    .where(eq(guardrailBlocks.agentId, agentId))
    .orderBy(desc(guardrailBlocks.ts))
    .limit(clampLimit(limit, 50, 500));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    episodeId: r.episodeId,
    reasons: r.reasons,
    ts: r.ts,
  }));
}
