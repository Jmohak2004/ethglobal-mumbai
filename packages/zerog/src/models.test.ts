import { describe, expect, test } from "bun:test";
import { budgetTierFrom, MODEL_IDS, modelFor } from "./models.ts";

describe("modelFor", () => {
  test("decision tiers map to the registry IDs when the budget is healthy", () => {
    expect(modelFor("decision", "strong", "healthy")).toBe("glm-5.3");
    expect(modelFor("decision", "balanced", "healthy")).toBe("qwen3.8-max");
    expect(modelFor("decision", "economical", "healthy")).toBe("0gm-1.0-35b-a3b");
  });

  test("low and critical budgets force the economical decision model", () => {
    for (const tier of ["strong", "balanced", "economical"] as const) {
      expect(modelFor("decision", tier, "low")).toBe("0gm-1.0-35b-a3b");
      expect(modelFor("decision", tier, "critical")).toBe("0gm-1.0-35b-a3b");
    }
  });

  test("empty budget also uses the economical model", () => {
    expect(modelFor("decision", "strong", "empty")).toBe("0gm-1.0-35b-a3b");
  });

  test("non-decision uses ignore tier and budget", () => {
    expect(modelFor("reflection", "strong", "healthy")).toBe("0gm-1.0-35b-a3b");
    expect(modelFor("reflection", "strong", "critical")).toBe("0gm-1.0-35b-a3b");
    expect(modelFor("vision", "strong", "healthy")).toBe("qwen3-vl-plus");
    expect(modelFor("image", "strong", "healthy")).toBe("z-image-turbo");
    expect(modelFor("digest", "strong", "healthy")).toBe("qwen3.8-max");
  });

  test("registry matches the PRD fallback IDs", () => {
    expect(Object.values(MODEL_IDS.decision)).toEqual(["glm-5.3", "qwen3.8-max", "0gm-1.0-35b-a3b"]);
    expect(MODEL_IDS.vision).toBe("qwen3-vl-plus");
    expect(MODEL_IDS.image).toBe("z-image-turbo");
    expect(MODEL_IDS.digest).toBe("qwen3.8-max");
  });
});

describe("budgetTierFrom", () => {
  test("healthy when runway is at least 3 days", () => {
    expect(budgetTierFrom({ balance: 3, dailyBurn: 1 })).toBe("healthy");
    expect(budgetTierFrom({ balance: 30, dailyBurn: 1 })).toBe("healthy");
  });

  test("low when runway is between 1 and 3 days", () => {
    expect(budgetTierFrom({ balance: 2.99, dailyBurn: 1 })).toBe("low");
    expect(budgetTierFrom({ balance: 1, dailyBurn: 1 })).toBe("low");
  });

  test("critical when runway is under 1 day", () => {
    expect(budgetTierFrom({ balance: 0.99, dailyBurn: 1 })).toBe("critical");
    expect(budgetTierFrom({ balance: 0.01, dailyBurn: 1 })).toBe("critical");
  });

  test("empty when balance is zero or below", () => {
    expect(budgetTierFrom({ balance: 0, dailyBurn: 1 })).toBe("empty");
    expect(budgetTierFrom({ balance: -2, dailyBurn: 1 })).toBe("empty");
    expect(budgetTierFrom({ balance: Number.NaN, dailyBurn: 1 })).toBe("empty");
  });

  test("healthy when there is no burn", () => {
    expect(budgetTierFrom({ balance: 5, dailyBurn: 0 })).toBe("healthy");
  });

  test("custom thresholds override the defaults", () => {
    expect(budgetTierFrom({ balance: 5, dailyBurn: 1, thresholds: { healthyDays: 7 } })).toBe("low");
    expect(budgetTierFrom({ balance: 0.5, dailyBurn: 1, thresholds: { criticalDays: 0.25 } })).toBe("low");
  });
});
