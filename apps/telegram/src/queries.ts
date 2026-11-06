// Read helpers for the bot. Prefers @arena/db repo functions. Anything the repo does not expose
// (e.g. "rows since cursor") is queried with db.query, which needs no drizzle-orm import here.

import {
  getAgent,
  leaderboard,
  listEpisodesByAgent,
  listPublic,
  listTelegramSubscriptions,
  type Db,
  type PublicAgent,
} from "@arena/db";
import type { Forecast, PerformanceStats } from "@arena/shared";

export interface Board {
  /** Agent leaderboard rows, best PnL first. Stats only. */
  agents: PerformanceStats[];
  /** agentId -> 1-based rank. */
  rankById: Map<string, number>;
}

export async function loadBoard(db: Db): Promise<Board> {
  const agents = await leaderboard(db, { kind: "agent", limit: 500 });
  return { agents, rankById: new Map(agents.map((r, i) => [r.entityId, i + 1])) };
}

export function loadHumans(db: Db, limit: number): Promise<PerformanceStats[]> {
  return leaderboard(db, { kind: "human", limit });
}

/** Agents a visitor can look up (active or paused). */
export function loadPublicAgents(db: Db): Promise<PublicAgent[]> {
  return listPublic(db, { limit: 500 });
}

export type MatchResult<T> = { kind: "none" } | { kind: "one"; item: T } | { kind: "many"; items: T[] };

const stripTag = (name: string) => name.replace(/^\[[^\]]*\]\s*/, "").toLowerCase();

/**
 * Fuzzy lookup by id or name. Tiers, first non-empty wins:
 *   1. exact id or exact name
 *   2. name prefix (the "[tag] " prefix is ignored)
 *   3. any word of the name starts with the query
 *   4. substring
 * More than one hit in a tier is "many" (capped at 5 candidates).
 */
export function matchAgents<T extends { id: string; name: string }>(candidates: T[], query: string): MatchResult<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const tiers: Array<(c: T) => boolean> = [
    (c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q || stripTag(c.name) === q,
    (c) => stripTag(c.name).startsWith(q),
    (c) => stripTag(c.name).split(/[^a-z0-9]+/).some((w) => w.startsWith(q)),
    (c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
  ];
  for (const hit of tiers) {
    const items = candidates.filter(hit);
    if (items.length === 1) return { kind: "one", item: items[0]! };
    if (items.length > 1) return { kind: "many", items: items.slice(0, 5) };
  }
  return { kind: "none" };
}

/** Agents a chat follows, with names. Stopped agents are still listed so they can be unfollowed. */
export async function followedAgents(db: Db, chatId: string): Promise<{ id: string; name: string; level: string }[]> {
  const subs = await listTelegramSubscriptions(db, chatId);
  const out: { id: string; name: string; level: string }[] = [];
  for (const s of subs) {
    const agent = await getAgent(db, s.agentId);
    if (agent) out.push({ id: agent.id, name: agent.name, level: s.level });
  }
  return out;
}

/**
 * Latest forecast that is at least one hour old. Used for "delayed" public commentary, so the public
 * sees a market view, never a live decision.
 */
export async function delayedForecast(db: Db, agentId: string, now: number): Promise<Forecast | null> {
  const cutoff = now - 3_600_000;
  const episodes = await listEpisodesByAgent(db, agentId, { limit: 20, beforeTs: cutoff });
  for (const e of episodes) {
    if (e.decision?.forecast) return e.decision.forecast;
  }
  return null;
}
