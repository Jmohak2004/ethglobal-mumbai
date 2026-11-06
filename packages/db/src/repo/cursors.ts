import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { chainCursors } from "../schema.ts";

/** Last fully processed block for a named chain scanner, or null before its first run. */
export async function getChainCursor(db: Db, name: string): Promise<number | null> {
  const [row] = await db.select().from(chainCursors).where(eq(chainCursors.name, name)).limit(1);
  return row ? row.block : null;
}

/** Persists the scanner's position. Only call after the blocks up to `block` are fully processed. */
export async function setChainCursor(db: Db, name: string, block: number, now: number = Date.now()): Promise<void> {
  await db
    .insert(chainCursors)
    .values({ name, block, updatedAt: now })
    .onConflictDoUpdate({ target: chainCursors.name, set: { block, updatedAt: now } });
}
