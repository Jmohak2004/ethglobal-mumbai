import { describe, expect, test } from "bun:test";
import type { GlobalLimits, StrategyConfig, TemplateId } from "@arena/shared";
import { TEMPLATES } from "./templates.ts";
import { configHash, defaultConfig, validateConfig } from "./config.ts";

const GLOBAL: GlobalLimits = {
  maxTradeUsd: 1,
  maxAgentAllocationUsd: 5,
  maxDailyVolumeUsdPerAgent: 20,
  maxDailyLossUsdPerAgent: 1,
  maxOpenPositions: 2,
  allowedTokens: ["WETH", "cbBTC"],
  killSwitch: false,
};
const COMMISSION = { min: 0, max: 2000 };

const make = (template: TemplateId = "momentum"): StrategyConfig =>
  defaultConfig(template, { assets: ["WETH"], commissionBps: 1000, global: GLOBAL });

/** Recursively reverses object key order, to check hash stability. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v).reverse().map(([k, val]) => [k, reverseKeys(val)] as const);
    return Object.fromEntries(entries);
  }
  return v;
}

describe("defaultConfig", () => {
  test("limits default to the global caps and the config validates", () => {
    const c = make();
    expect(c.limits.maxTradeUsd).toBe(GLOBAL.maxTradeUsd);
    expect(c.limits.maxOpenPositions).toBe(GLOBAL.maxOpenPositions);
    expect(c.limits.maxAllocationUsd).toBe(GLOBAL.maxAgentAllocationUsd);
    expect(c.limits.maxDailyLossUsd).toBe(GLOBAL.maxDailyLossUsdPerAgent);
    expect(validateConfig(c, GLOBAL, COMMISSION)).toEqual({ ok: true, errors: [] });
  });

  test("sliders start at template defaults, fork is disabled, autoTune is off", () => {
    const c = make("momentum");
    for (const s of TEMPLATES.momentum.sliders) expect(c.sliders[s.key]).toBe(s.default);
    expect(c.fork).toEqual({ forkable: false, priceUsd: 0 });
    expect(c.autoTune.enabled).toBe(false);
    expect(c.publicCommentary).toBe("delayed");
  });

  test("only social_sentiment gets the web_search insight source", () => {
    expect(make("social_sentiment").insightSources).toEqual([{ kind: "web_search" }]);
    expect(make("momentum").insightSources).toEqual([]);
  });
});

describe("validateConfig", () => {
  test("every template's defaults are valid", () => {
    for (const id of Object.keys(TEMPLATES) as TemplateId[]) {
      expect(validateConfig(make(id), GLOBAL, COMMISSION).errors).toEqual([]);
    }
  });

  test("slider above its max is an error", () => {
    const c = make();
    c.sliders.sizePct = 150;
    expect(validateConfig(c, GLOBAL, COMMISSION).errors.join(" ")).toMatch(/sizePct=150/);
  });

  test("slider off its step grid is an error", () => {
    const c = make();
    c.sliders.takeProfitPct = 4.3; // step 0.5
    expect(validateConfig(c, GLOBAL, COMMISSION).errors.join(" ")).toMatch(/not on step/);
  });

  test("missing slider and unknown slider are both errors", () => {
    const c = make();
    delete c.sliders.trailPct;
    c.sliders.bogus = 1;
    const errors = validateConfig(c, GLOBAL, COMMISSION).errors.join(" ");
    expect(errors).toMatch(/trailPct is missing/);
    expect(errors).toMatch(/unknown slider bogus/);
  });

  test("unknown template is an error", () => {
    const c = { ...make(), template: "scalper" } as unknown as StrategyConfig;
    expect(validateConfig(c, GLOBAL, COMMISSION).errors.join(" ")).toMatch(/unknown template/);
  });

  test("empty assets and assets outside the allowlist are errors", () => {
    expect(validateConfig({ ...make(), assets: [] }, GLOBAL, COMMISSION).errors).toContain("assets must not be empty");
    const bad = validateConfig({ ...make(), assets: ["DOGE"] }, GLOBAL, COMMISSION);
    expect(bad.errors.join(" ")).toMatch(/DOGE is not on the platform allowlist/);
  });

  test("limits above a global cap or at zero are errors", () => {
    const c = make();
    c.limits.maxTradeUsd = 2;
    c.limits.maxOpenPositions = 0;
    const errors = validateConfig(c, GLOBAL, COMMISSION).errors.join(" ");
    expect(errors).toMatch(/maxTradeUsd=2 exceeds global cap 1/);
    expect(errors).toMatch(/maxOpenPositions must be > 0/);
  });

  test("commission outside bounds is an error", () => {
    expect(validateConfig({ ...make(), commissionBps: 2500 }, GLOBAL, COMMISSION).ok).toBe(false);
  });

  test("tick interval below 30 seconds and negative fork price are errors", () => {
    const errors = validateConfig(
      { ...make(), tickIntervalSec: 10, fork: { forkable: true, priceUsd: -1 } },
      GLOBAL,
      COMMISSION,
    ).errors.join(" ");
    expect(errors).toMatch(/tickIntervalSec must be >= 30/);
    expect(errors).toMatch(/fork.priceUsd must be >= 0/);
  });
});

describe("configHash", () => {
  test("is a bytes32 hex string", () => {
    expect(configHash(make())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("is stable across object key order, including nested objects", () => {
    const c = make("social_sentiment");
    const reordered = reverseKeys(c) as StrategyConfig;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(c));
    expect(configHash(reordered)).toBe(configHash(c));
  });

  test("changes when any value changes", () => {
    const c = make();
    const changed = { ...c, sliders: { ...c.sliders, sizePct: c.sliders.sizePct! + 1 } };
    expect(configHash(changed)).not.toBe(configHash(c));
  });
});
