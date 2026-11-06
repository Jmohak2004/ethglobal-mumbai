// Runtime status for the owner UI: what the last tick did, when the next one is due, and the agent's book.
// Written for every agent in every mode. It reads state and writes agents.runtime only, so it never places an order.

import { updateAgentRuntime } from "@arena/db";
import type { Agent } from "@arena/shared";
import type { Deps } from "./deps.ts";
import { snapshotPortfolio } from "./portfolio.ts";
import type { TickResult } from "./tick.ts";

export type RuntimeOutcome = "approve" | "clamp" | "reject" | "hold" | "noop" | "error" | "not provisioned" | "paused";

export interface TickOutcome {
  outcome: RuntimeOutcome;
  /** Why the tick failed or was skipped. Null for a normal decision. */
  lastError: string | null;
  /** The 0G request id of the decision, when one was made. */
  lastRequestId: string | null;
}

/**
 * Maps a tick result to the outcome shown in the UI. A budget-empty tick is a noop, because the list has no
 * budget outcome; its reason is on the episode.
 */
export function outcomeFor(result: TickResult): TickOutcome {
  if (result.skipped === "not provisioned") return { outcome: "not provisioned", lastError: null, lastRequestId: null };
  if (result.skipped) return { outcome: "paused", lastError: result.skipped, lastRequestId: null };

  const requestId = result.episode?.inference?.requestId ?? null;
  if (result.error) return { outcome: "error", lastError: result.error, lastRequestId: requestId };

  const episode = result.episode;
  if (!episode) return { outcome: "noop", lastError: null, lastRequestId: null };
  const kind = episode.verdict.kind;
  if (kind === "approve" || kind === "clamp" || kind === "reject") {
    return { outcome: kind, lastError: episode.error, lastRequestId: requestId };
  }
  if (episode.error) return { outcome: "error", lastError: episode.error, lastRequestId: requestId };
  if (episode.decision?.proposal.action === "hold") return { outcome: "hold", lastError: null, lastRequestId: requestId };
  return { outcome: "noop", lastError: null, lastRequestId: requestId };
}

export type StatusDeps = Pick<Deps, "db" | "clock" | "logger" | "market">;

/** Refreshes only the portfolio snapshot. A failed mark or read is logged and keeps the previous snapshot. */
export async function recordPortfolio(deps: StatusDeps, agent: Agent): Promise<void> {
  const now = deps.clock.now();
  try {
    const portfolio = await snapshotPortfolio(deps, agent, now);
    await updateAgentRuntime(deps.db, agent.id, { portfolio, updatedAt: now });
  } catch (err) {
    deps.logger.warn("portfolio snapshot failed", { agent: agent.id, error: err });
  }
}

/** Writes lastTickAt, lastOutcome, lastError, lastRequestId and the portfolio after a tick, skipped or not. */
export async function recordTickStatus(deps: StatusDeps, agent: Agent, result: TickResult): Promise<void> {
  const now = deps.clock.now();
  const { outcome, lastError, lastRequestId } = outcomeFor(result);
  await updateAgentRuntime(deps.db, agent.id, { lastTickAt: now, lastOutcome: outcome, lastError, lastRequestId, updatedAt: now });
  await recordPortfolio(deps, agent);
}

/** Writes the next scheduled run time, so the UI can show a countdown. */
export async function recordNextTick(deps: Pick<Deps, "db" | "clock">, agentId: string, nextRunAt: number): Promise<void> {
  await updateAgentRuntime(deps.db, agentId, { nextTickAt: nextRunAt, updatedAt: deps.clock.now() });
}
