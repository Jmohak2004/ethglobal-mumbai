import { describe, expect, test } from "bun:test";
import type { GlobalLimits, PolicyContext, Proposal, StrategyConfig, TemplateId } from "@arena/shared";
import { defaultConfig } from "./config.ts";
import { evaluate } from "./engine.ts";

const GLOBAL: GlobalLimits = {
  maxTradeUsd: 1,
  maxAgentAllocationUsd: 5,
  maxDailyVolumeUsdPerAgent: 20,
  maxDailyLossUsdPerAgent: 1,
  maxOpenPositions: 2,
  allowedTokens: ["WETH", "cbBTC"],
  killSwitch: false,
};

/** Healthy momentum agent on WETH, mark 2000, allocation $5, nothing traded yet. */
function makeCtx(
  template: TemplateId = "momentum",
  patch: Partial<PolicyContext> = {},
  cfg: (c: StrategyConfig) => StrategyConfig = (c) => c,
  global: GlobalLimits = GLOBAL,
): PolicyContext {
  const base = defaultConfig(template, { assets: ["WETH"], commissionBps: 1000, global });
  return {
    config: cfg(base),
    riskLevel: "NORMAL",
    budgetTier: "healthy",
    openPositions: 0,
    dailyPnlUsd: 0,
    dailyVolumeUsd: 0,
    drawdownPct: 0,
    lastTradeAt: null,
    now: 1_000_000_000,
    markPrice: 2000,
    allocationUsd: 5,
    global,
    ...patch,
  };
}

/** Valid momentum market buy: 15% of $5 = $0.75 notional, TP 4%, SL 2%. */
const buy = (over: Partial<Proposal> = {}): Proposal => ({
  action: "buy",
  asset: "WETH",
  orderType: "market",
  sizePct: 0.15,
  takeProfitPct: 4,
  stopLossPct: 2,
  rationale: "test",
  ...over,
});

const sell = (over: Partial<Proposal> = {}): Proposal => ({
  action: "sell",
  asset: "WETH",
  orderType: "market",
  sizePct: 0.5,
  rationale: "test",
  ...over,
});

describe("evaluate: actions and global gates", () => {
  test("clean buy is approved with the exact order and bracket", () => {
    const v = evaluate(buy(), makeCtx());
    expect(v.kind).toBe("approve");
    if (v.kind !== "approve") return;
    expect(v.order.side).toBe("buy");
    expect(v.order.quoteAsset).toBe("USDC");
    expect(v.order.notionalUsd).toBeCloseTo(0.75, 9);
    expect(v.order.attachedBracket?.takeProfitPrice).toBeCloseTo(2080, 6);
    expect(v.order.attachedBracket?.stopLossPrice).toBeCloseTo(1960, 6);
  });

  test("hold is a noop", () => {
    expect(evaluate({ action: "hold", rationale: "" }, makeCtx()).kind).toBe("noop");
  });

  test("cancel and adjust_stops pass through as noop, never as an order", () => {
    for (const action of ["cancel", "adjust_stops"] as const) {
      const v = evaluate({ action, rationale: "" }, makeCtx("momentum", { riskLevel: "HALT" }));
      expect(v.kind).toBe("noop");
    }
  });

  test("kill switch rejects buys", () => {
    const v = evaluate(buy(), makeCtx("momentum", {}, undefined, { ...GLOBAL, killSwitch: true }));
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/kill switch/);
  });

  test("kill switch still lets a sell through", () => {
    const v = evaluate(sell(), makeCtx("momentum", {}, undefined, { ...GLOBAL, killSwitch: true }));
    expect(v.kind === "approve" || v.kind === "clamp").toBe(true);
    if (v.kind === "approve" || v.kind === "clamp") expect(v.order.side).toBe("sell");
  });

  test("HALT rejects buys and allows sells", () => {
    expect(evaluate(buy(), makeCtx("momentum", { riskLevel: "HALT" })).kind).toBe("reject");
    expect(evaluate(sell(), makeCtx("momentum", { riskLevel: "HALT" })).kind).not.toBe("reject");
  });

  test("CAUTION halves the buy notional and records a clamp reason", () => {
    // 20% of $5 = $1.00, halved to $0.50 (exactly the minimum, so it is not rejected).
    const v = evaluate(buy({ sizePct: 0.2 }), makeCtx("momentum", { riskLevel: "CAUTION" }));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.notionalUsd).toBeCloseTo(0.5, 9);
    expect(v.reasons.join(" ")).toMatch(/halved/);
  });

  test("CAUTION rejects breakout (stop) entries", () => {
    const v = evaluate(
      buy({ orderType: "stop", triggerPrice: 2010, takeProfitPct: undefined, stopLossPct: undefined }),
      makeCtx("breakout", { riskLevel: "CAUTION" }),
    );
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/CAUTION/);
  });

  test.each(["critical", "empty"] as const)("budget tier %s rejects buys", (budgetTier) => {
    expect(evaluate(buy(), makeCtx("momentum", { budgetTier })).kind).toBe("reject");
  });

  test("budget tier low does not block buys", () => {
    expect(evaluate(buy(), makeCtx("momentum", { budgetTier: "low" })).kind).not.toBe("reject");
  });
});

describe("evaluate: asset and order type", () => {
  test("asset not enabled for the agent is rejected", () => {
    const v = evaluate(buy({ asset: "cbBTC" }), makeCtx());
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/not enabled/);
  });

  test("asset missing from the platform allowlist is rejected", () => {
    const narrow: GlobalLimits = { ...GLOBAL, allowedTokens: ["WETH"] };
    const v = evaluate(buy({ asset: "cbBTC" }), makeCtx("momentum", {}, (c) => ({ ...c, assets: ["cbBTC"] }), narrow));
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/allowlist/);
  });

  test("order type not in the template's allowed list is rejected", () => {
    const v = evaluate(buy({ orderType: "twap" }), makeCtx("momentum"));
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/twap/);
  });

  test("missing order type defaults to the template entry type as a clamp", () => {
    const v = evaluate(buy({ orderType: undefined, limitPrice: 2000 }), makeCtx("momentum"));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.orderType).toBe("limit");
    expect(v.reasons.join(" ")).toMatch(/defaulted to limit/);
  });
});

describe("evaluate: sizing", () => {
  test("notional is clamped to the agent maxTradeUsd", () => {
    // 20% of $5 = $1.00, agent cap $0.60.
    const v = evaluate(buy({ sizePct: 0.2 }), makeCtx("momentum", {}, (c) => ({ ...c, limits: { ...c.limits, maxTradeUsd: 0.6 } })));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.notionalUsd).toBeCloseTo(0.6, 9);
    expect(v.reasons.join(" ")).toMatch(/agent max trade/);
  });

  test("notional is clamped to the platform maxTradeUsd", () => {
    // 25% of $5 = $1.25, platform cap $1.00 (agent cap left high).
    const v = evaluate(buy({ sizePct: 0.25 }), makeCtx("momentum", {}, (c) => ({ ...c, limits: { ...c.limits, maxTradeUsd: 3 } })));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.notionalUsd).toBeCloseTo(1, 9);
    expect(v.reasons.join(" ")).toMatch(/platform max trade/);
  });

  test("size above the template slider is capped to the slider", () => {
    // Momentum sizePct slider defaults to 25%. Asking for 90% is capped to 25%: $1.25, then $1.00 platform cap.
    const v = evaluate(buy({ sizePct: 0.9 }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.reasons.join(" ")).toMatch(/template maximum 25%/);
    expect(v.order.notionalUsd).toBeCloseTo(1, 9);
  });

  test("notional below the minimum is rejected, and opts can lower the minimum", () => {
    // 5% of $5 = $0.25, below the default $0.50 minimum.
    expect(evaluate(buy({ sizePct: 0.05 }), makeCtx()).kind).toBe("reject");
    expect(evaluate(buy({ sizePct: 0.05 }), makeCtx(), { minNotionalUsd: 0.2 }).kind).not.toBe("reject");
  });

  test("daily volume cap clamps the notional to what remains", () => {
    // $19.50 of $20 used, so $0.50 remains against a $0.75 notional.
    const v = evaluate(buy(), makeCtx("momentum", { dailyVolumeUsd: 19.5 }));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.notionalUsd).toBeCloseTo(0.5, 9);
    expect(v.reasons.join(" ")).toMatch(/daily volume/);
  });

  test("daily volume cap reached rejects", () => {
    const v = evaluate(buy(), makeCtx("momentum", { dailyVolumeUsd: 20 }));
    expect(v.kind).toBe("reject");
  });

  test("smart_dca has no size slider, so budgetUsd caps the notional", () => {
    // Full-allocation request is capped to the $1 platform max, then to the $0.60 budget.
    const v = evaluate(
      buy({ sizePct: 0.5, orderType: "twap", twapDurationSec: 3600, twapBuckets: 4 }),
      makeCtx("smart_dca", {}, (c) => ({ ...c, sliders: { ...c.sliders, budgetUsd: 0.6 } })),
    );
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.notionalUsd).toBeCloseTo(0.6, 9);
    expect(v.reasons.join(" ")).toMatch(/template budget/);
  });

  test("smart_dca buy with a proposed take-profit is not rejected", () => {
    const v = evaluate(
      buy({ orderType: "twap", twapDurationSec: 3600, twapBuckets: 4, takeProfitPct: 4, stopLossPct: undefined }),
      makeCtx("smart_dca"),
    );
    expect(v.kind).not.toBe("reject");
  });
});

describe("evaluate: brackets and protection", () => {
  test("missing TP and SL fall back to template slider values as a clamp", () => {
    // Momentum defaults: TP 4%, SL 2%.
    const v = evaluate(buy({ takeProfitPct: undefined, stopLossPct: undefined }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.attachedBracket?.takeProfitPrice).toBeCloseTo(2080, 6);
    expect(v.order.attachedBracket?.stopLossPrice).toBeCloseTo(1960, 6);
    expect(v.reasons.join(" ")).toMatch(/take-profit missing/);
    expect(v.reasons.join(" ")).toMatch(/stop-loss missing/);
  });

  test("take-profit above the platform bound is clamped to 20%", () => {
    const v = evaluate(buy({ takeProfitPct: 35 }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.attachedBracket?.takeProfitPrice).toBeCloseTo(2400, 6);
  });

  test("stop-loss below the platform bound is clamped to 0.5%", () => {
    const v = evaluate(buy({ stopLossPct: 0.1 }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.attachedBracket?.stopLossPrice).toBeCloseTo(1990, 6);
  });

  test("smart_dca buy without a take-profit is rejected (no TP slider on that template)", () => {
    const v = evaluate(
      buy({ orderType: "twap", twapDurationSec: 3600, twapBuckets: 4, takeProfitPct: undefined }),
      makeCtx("smart_dca"),
    );
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.join(" ")).toMatch(/take-profit/);
  });

  test("sells carry side sell and no bracket", () => {
    const v = evaluate(sell(), makeCtx());
    expect(v.kind === "approve" || v.kind === "clamp").toBe(true);
    if (v.kind === "approve" || v.kind === "clamp") {
      expect(v.order.side).toBe("sell");
      expect(v.order.attachedBracket).toBeUndefined();
    }
  });
});

describe("evaluate: price bands, TWAP and trailing stops", () => {
  test("limit price above +5% of mark is clamped to the band", () => {
    const v = evaluate(buy({ orderType: "limit", limitPrice: 2300 }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.limitPrice).toBeCloseTo(2100, 6);
  });

  test("limit price below -5% of mark is clamped to the band", () => {
    const v = evaluate(buy({ orderType: "limit", limitPrice: 1000 }), makeCtx());
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.limitPrice).toBeCloseTo(1900, 6);
  });

  test("limit order without a limit price is rejected", () => {
    expect(evaluate(buy({ orderType: "limit" }), makeCtx()).kind).toBe("reject");
  });

  test("stop trigger price outside the band is clamped", () => {
    const v = evaluate(buy({ orderType: "stop", triggerPrice: 1000, takeProfitPct: undefined, stopLossPct: undefined }), makeCtx("breakout"));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.triggerPrice).toBeCloseTo(1900, 6);
  });

  test("twap duration and buckets are clamped to Flash ranges", () => {
    const v = evaluate(
      buy({ orderType: "twap", twapDurationSec: 100, twapBuckets: 5000, takeProfitPct: 4, stopLossPct: 2 }),
      makeCtx("smart_dca"),
    );
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.twap).toEqual({ durationSeconds: 600, bucketCount: 2560 });
  });

  test("twap without duration derives it from periodMin x buckets", () => {
    // smart_dca defaults: periodMin 60, buckets 10, so 36000 seconds.
    const v = evaluate(buy({ orderType: "twap", takeProfitPct: 4, stopLossPct: 2 }), makeCtx("smart_dca"));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.twap).toEqual({ durationSeconds: 36_000, bucketCount: 10 });
  });

  test("trailPct is converted to a Flash trail fraction", () => {
    const v = evaluate(sell({ orderType: "trailing-stop", trailPct: 2 }), makeCtx("momentum"));
    expect(v.kind === "approve" || v.kind === "clamp").toBe(true);
    if (v.kind === "approve" || v.kind === "clamp") expect(v.order.trailPercent).toBeCloseTo(0.02, 9);
  });

  test("trailPct above the platform bound is clamped to 10% (0.1 fraction)", () => {
    const v = evaluate(sell({ orderType: "trailing-stop", trailPct: 50 }), makeCtx("momentum"));
    expect(v.kind).toBe("clamp");
    if (v.kind !== "clamp") return;
    expect(v.order.trailPercent).toBeCloseTo(0.1, 9);
  });
});

describe("evaluate: account limits", () => {
  test("cooldown rejects buys until cooldownSec has passed", () => {
    // Default cooldown is 60 seconds.
    const now = 1_000_000_000;
    expect(evaluate(buy(), makeCtx("momentum", { lastTradeAt: now - 30_000, now })).kind).toBe("reject");
    expect(evaluate(buy(), makeCtx("momentum", { lastTradeAt: now - 61_000, now })).kind).not.toBe("reject");
  });

  test("open positions at the cap rejects buys", () => {
    expect(evaluate(buy(), makeCtx("momentum", { openPositions: 2 })).kind).toBe("reject");
    expect(evaluate(buy(), makeCtx("momentum", { openPositions: 1 })).kind).not.toBe("reject");
  });

  test("daily loss at the cap rejects buys", () => {
    expect(evaluate(buy(), makeCtx("momentum", { dailyPnlUsd: -1 })).kind).toBe("reject");
    expect(evaluate(buy(), makeCtx("momentum", { dailyPnlUsd: -0.5 })).kind).not.toBe("reject");
  });

  test("drawdown at or above the agent limit rejects buys", () => {
    // Default drawdown limit is 20%.
    expect(evaluate(buy(), makeCtx("momentum", { drawdownPct: 20 })).kind).toBe("reject");
    expect(evaluate(buy(), makeCtx("momentum", { drawdownPct: 19.9 })).kind).not.toBe("reject");
  });

  test("several failing rules report every reason", () => {
    const v = evaluate(buy(), makeCtx("momentum", { openPositions: 2, dailyPnlUsd: -1, drawdownPct: 25 }));
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reasons.length).toBeGreaterThanOrEqual(3);
  });

  test("invalid mark price rejects", () => {
    expect(evaluate(buy(), makeCtx("momentum", { markPrice: 0 })).kind).toBe("reject");
  });
});
