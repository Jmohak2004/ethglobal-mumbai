// Agent runtime status helpers shared by the runtime route (server) and the status strip (client). Client-safe.
import type { AgentRuntimeState, AgentRuntimeView } from "@/lib/types";

export type OutcomeTone = "long" | "short" | "warn" | "muted";

/** Colour for a worker outcome string ("approve", "hold", "reject", "error", "not provisioned", ...). */
export function outcomeTone(outcome: string | null | undefined): OutcomeTone {
  switch (outcome) {
    case "approve":
      return "long";
    case "clamp":
    case "not provisioned":
      return "warn";
    case "reject":
    case "error":
      return "short";
    default:
      return "muted";
  }
}

/** Offline when the worker has never stamped the runtime, or its last write is older than 2 x the tick interval. */
export function isWorkerOffline(updatedAt: number | null | undefined, tickIntervalSec: number, now: number): boolean {
  if (!updatedAt) return true;
  return now - updatedAt > 2 * tickIntervalSec * 1000;
}

/** m:ss for a remaining duration in ms. Negative or zero is 0:00. */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Builds the public or owner projection of the runtime. The public view has no portfolio, error, request id,
 * queue flag or interval keys at all (not null, absent), so a serialization slip cannot leak them.
 */
export function toRuntimeView(input: {
  runtime: AgentRuntimeState;
  walletProvisioned: boolean;
  tickQueued: boolean;
  tickIntervalSec: number;
  viewer: "owner" | "public";
  now: number;
}): AgentRuntimeView {
  const { runtime: r, viewer, now } = input;
  const base: AgentRuntimeView = {
    viewer,
    serverNow: now,
    walletProvisioned: input.walletProvisioned,
    lastTickAt: r.lastTickAt ?? null,
    nextTickAt: r.nextTickAt ?? null,
    lastOutcome: r.lastOutcome ?? null,
    updatedAt: r.updatedAt ?? null,
    workerOffline: isWorkerOffline(r.updatedAt, input.tickIntervalSec, now),
  };
  if (viewer !== "owner") return base;
  return {
    ...base,
    lastError: r.lastError ?? null,
    lastRequestId: r.lastRequestId ?? null,
    portfolio: r.portfolio ?? null,
    tickQueued: input.tickQueued,
    tickIntervalSec: input.tickIntervalSec,
  };
}
