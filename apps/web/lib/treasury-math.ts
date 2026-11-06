// Pure treasury and budget helpers. Client-safe.
import type { BudgetTier } from "@arena/shared";

/** Reserve days when AgentTreasury settings are not available. Mirrors EnvSchema RESERVE_DAYS. */
export const RESERVE_DAYS_FALLBACK = 3;

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Budget tier from runway (PRD 6.11.6). */
export function tierFor(runwayDays: number, balanceUsd: number): BudgetTier {
  if (balanceUsd <= 0) return "empty";
  if (runwayDays >= 3) return "healthy";
  if (runwayDays >= 1) return "low";
  return "critical";
}
