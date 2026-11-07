import type { BudgetTier, ModelTier } from "@arena/shared";

export type ModelUse = "decision" | "reflection" | "vision" | "image" | "digest";

/** Model IDs confirmed against https://pc.0g.ai/models (PRD §7.2). */
export const MODEL_IDS = {
  decision: {
    strong: "glm-5.3",
    balanced: "qwen3.8-max",
    economical: "0gm-1.0-35b-a3b",
  },
  reflection: "0gm-1.0-35b-a3b",
  vision: "qwen3-vl-plus",
  image: "z-image-turbo",
  // Digests need JSON mode plus the Router's web plugin. glm-5.3-flash rejects JSON mode (model_not_capable),
  // and 0gm-1.0 is always end-to-end encrypted, which rules out plugins. qwen3.8-max supports both.
  digest: "qwen3.8-max",
} as const;

/** Budget tiers that force the cheap decision model (PRD §6.11.6). "empty" is included so a paused agent never bills the strong model. */
const CHEAP_DECISION_BUDGETS: ReadonlySet<BudgetTier> = new Set<BudgetTier>(["low", "critical", "empty"]);

export function modelFor(use: ModelUse, tier: ModelTier = "balanced", budget: BudgetTier = "healthy"): string {
  switch (use) {
    case "decision":
      return CHEAP_DECISION_BUDGETS.has(budget) ? MODEL_IDS.decision.economical : MODEL_IDS.decision[tier];
    case "reflection":
      return MODEL_IDS.reflection;
    case "vision":
      return MODEL_IDS.vision;
    case "image":
      return MODEL_IDS.image;
    case "digest":
      return MODEL_IDS.digest;
  }
}

export interface BudgetThresholds {
  /** Runway (days) at or above which the tier is "healthy". */
  healthyDays: number;
  /** Runway (days) at or above which the tier is "low"; below it is "critical". */
  criticalDays: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = { healthyDays: 3, criticalDays: 1 };

/**
 * Maps a 0G balance and its recent daily burn to a budget tier.
 * Units only need to match between `balance` and `dailyBurn` (e.g. both in USD or both in 0G).
 */
export function budgetTierFrom(input: {
  balance: number;
  dailyBurn: number;
  thresholds?: Partial<BudgetThresholds>;
}): BudgetTier {
  const { healthyDays, criticalDays } = { ...DEFAULT_BUDGET_THRESHOLDS, ...input.thresholds };
  if (!(input.balance > 0)) return "empty";
  if (!(input.dailyBurn > 0)) return "healthy";
  const runwayDays = input.balance / input.dailyBurn;
  if (runwayDays >= healthyDays) return "healthy";
  if (runwayDays >= criticalDays) return "low";
  return "critical";
}
