import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { users } from "../schema.ts";
import { addr } from "./util.ts";

export interface UserRecord {
  address: string;
  displayName: string | null;
  tgHandle: string | null;
  humansBoardOptIn: boolean;
  createdAt: number;
}

export interface UpsertUserInput {
  address: string;
  displayName?: string | null;
  tgHandle?: string | null;
  humansBoardOptIn?: boolean;
  createdAt?: number;
}

/** Inserts the user if missing. Never overwrites existing profile fields. */
export async function ensureUser(db: Db, address: string, createdAt: number = Date.now()): Promise<void> {
  await db
    .insert(users)
    .values({ address: addr(address), createdAt })
    .onConflictDoNothing({ target: users.address });
}

/** Creates or updates a user. Only fields that are provided (not undefined) are changed. */
export async function upsertUser(db: Db, input: UpsertUserInput): Promise<UserRecord> {
  const address = addr(input.address);
  const createdAt = input.createdAt ?? Date.now();
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.tgHandle !== undefined) patch.tgHandle = input.tgHandle;
  if (input.humansBoardOptIn !== undefined) patch.humansBoardOptIn = input.humansBoardOptIn;

  const [row] = await db
    .insert(users)
    .values({ address, createdAt, ...patch })
    .onConflictDoUpdate({
      target: users.address,
      set: Object.keys(patch).length > 0 ? patch : { address },
    })
    .returning();
  if (!row) throw new Error(`upsertUser: no row returned for ${address}`);
  return toUser(row);
}

export async function getUser(db: Db, address: string): Promise<UserRecord | null> {
  const [row] = await db.select().from(users).where(eq(users.address, addr(address))).limit(1);
  return row ? toUser(row) : null;
}

function toUser(row: typeof users.$inferSelect): UserRecord {
  return {
    address: row.address,
    displayName: row.displayName,
    tgHandle: row.tgHandle,
    humansBoardOptIn: row.humansBoardOptIn,
    createdAt: row.createdAt,
  };
}
