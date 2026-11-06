import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { tgSubscriptions } from "../schema.ts";

/** Subscribes a Telegram chat to an agent at a level. Re-subscribing updates the level. */
export async function subscribeTelegram(
  db: Db,
  input: { chatId: string; agentId: string; level: string; createdAt?: number },
): Promise<void> {
  await db
    .insert(tgSubscriptions)
    .values({
      chatId: input.chatId,
      agentId: input.agentId,
      level: input.level,
      createdAt: input.createdAt ?? Date.now(),
    })
    .onConflictDoUpdate({
      target: [tgSubscriptions.chatId, tgSubscriptions.agentId],
      set: { level: input.level },
    });
}

/** Returns true if a subscription was removed. */
export async function unsubscribeTelegram(db: Db, chatId: string, agentId: string): Promise<boolean> {
  const removed = await db
    .delete(tgSubscriptions)
    .where(and(eq(tgSubscriptions.chatId, chatId), eq(tgSubscriptions.agentId, agentId)))
    .returning({ chatId: tgSubscriptions.chatId });
  return removed.length > 0;
}

/** Chat ids subscribed to an agent, optionally filtered to one level. */
export async function listTelegramSubscribers(db: Db, agentId: string, level?: string): Promise<string[]> {
  const conditions = [eq(tgSubscriptions.agentId, agentId)];
  if (level !== undefined) conditions.push(eq(tgSubscriptions.level, level));
  const rows = await db
    .select({ chatId: tgSubscriptions.chatId })
    .from(tgSubscriptions)
    .where(and(...conditions));
  return rows.map((r) => r.chatId);
}

/** Subscriptions for one chat. */
export async function listTelegramSubscriptions(
  db: Db,
  chatId: string,
): Promise<{ agentId: string; level: string }[]> {
  return db
    .select({ agentId: tgSubscriptions.agentId, level: tgSubscriptions.level })
    .from(tgSubscriptions)
    .where(eq(tgSubscriptions.chatId, chatId));
}
