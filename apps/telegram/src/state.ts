// Bot-local persisted state. The db package has no tables for chat-to-wallet links, notifier cursors
// or digest bookkeeping, so the bot keeps them in a small JSON file (atomic write via rename).
// Tests pass path = null for an in-memory store.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RiskLevel } from "@arena/shared";

/** Per-source "last seen" unix ms. Each source advances independently. */
export interface Cursors {
  orders: number;
  fills: number;
  guardrails: number;
  episodes: number;
  topups: number;
  attestations: number;
}

export interface BotState {
  /** null until the first notifier tick, which starts every cursor at "now" (no history replay). */
  cursors: Cursors | null;
  /** chatId -> wallet (lowercase). Demo-grade: linking is not verified. */
  links: Record<string, string>;
  /** `${chatId}|${agentId}` -> UTC day key of the last digest for that follow. */
  digestDays: Record<string, string>;
  /** UTC day key of the last digest batch. */
  lastDigestDay: string | null;
  /** agentId -> rank as of the last digest batch, used for rank deltas. */
  rankSnapshot: Record<string, number>;
  /** Last platform risk level broadcast or observed. */
  riskLevel: RiskLevel | null;
}

export interface StateStore {
  readonly state: BotState;
  save(): void;
}

export function emptyState(): BotState {
  return { cursors: null, links: {}, digestDays: {}, lastDigestDay: null, rankSnapshot: {}, riskLevel: null };
}

export function digestKey(chatId: string, agentId: string): string {
  return `${chatId}|${agentId}`;
}

export function createStateStore(path: string | null): StateStore {
  const state = emptyState();
  if (path && existsSync(path)) {
    try {
      Object.assign(state, { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<BotState>) });
    } catch (err) {
      console.warn(`[telegram] could not read state file, starting fresh: ${(err as Error).message}`);
    }
  }
  return {
    state,
    save() {
      if (!path) return;
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, path);
    },
  };
}
