import type { FlashOrderType, OrderIntent, PolicyContext, PolicyVerdict, Proposal, StrategyConfig } from "@arena/shared";
import { PROTECTION_BOUNDS, TEMPLATES, type SliderDef, type TemplateDef } from "./templates.ts";

export interface EvaluateOptions {
  /** Orders below this USD notional are rejected. Default 0.5. */
  minNotionalUsd?: number;
  /** Limit and trigger prices are clamped to mark * (1 ± this %). Default 5. */
  maxLimitDeviationPct?: number;
}

const DEFAULT_MIN_NOTIONAL_USD = 0.5;
const DEFAULT_MAX_LIMIT_DEVIATION_PCT = 5;
const TWAP_DURATION_SEC = { min: 600, max: 2_592_000 };
const TWAP_BUCKETS = { min: 2, max: 2560 };
/** Flash trailPercent is a fraction. Templates store percent. */
const TRAIL_FRACTION = { min: 0.005, max: 0.5 };
/** Slider keys that can supply a stop-loss default, in priority order. */
const TP_SLIDERS = ["takeProfitPct"];
const SL_SLIDERS = ["stopLossPct", "stopLossFloorPct"];

type Bounds = { min: number; max: number };
const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : String(n));

function sliderSpec(def: TemplateDef, key: string): SliderDef | undefined {
  return def.sliders.find((s) => s.key === key);
}

/** Configured slider value, falling back to the template default. Undefined if the template has no such slider. */
function sliderValue(config: StrategyConfig, def: TemplateDef, key: string): number | undefined {
  const spec = sliderSpec(def, key);
  if (!spec) return undefined;
  return config.sliders[key] ?? spec.default;
}

/** Clamps into [min, max] and records a reason when it changes the value. */
function clampInto(value: number, bounds: Bounds, label: string, clamps: string[]): number {
  const shown = Number(value.toFixed(4));
  if (value < bounds.min) {
    clamps.push(`${label} ${shown} below minimum ${bounds.min}; clamped`);
    return bounds.min;
  }
  if (value > bounds.max) {
    clamps.push(`${label} ${shown} above maximum ${bounds.max}; clamped`);
    return bounds.max;
  }
  return value;
}

/** Take-profit or stop-loss percent for a buy. Missing values come from the template slider. */
function resolveProtectionPct(
  label: string,
  proposed: number | undefined,
  def: TemplateDef,
  config: StrategyConfig,
  sliderKeys: string[],
  platformBounds: Bounds,
  rejects: string[],
  clamps: string[],
): number | undefined {
  const key = sliderKeys.find((k) => sliderSpec(def, k) !== undefined);
  const spec = key === undefined ? undefined : sliderSpec(def, key);

  let value = proposed;
  if (value === undefined) {
    const fallback = key === undefined ? undefined : sliderValue(config, def, key);
    if (fallback === undefined) {
      rejects.push(`buy needs a ${label}: none proposed and ${def.name} has no ${label} slider`);
      return undefined;
    }
    clamps.push(`${label} missing; using template value ${fallback}%`);
    value = fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    rejects.push(`${label} must be a positive percentage`);
    return undefined;
  }
  return clampInto(value, spec ?? platformBounds, `${label} %`, clamps);
}

/** Limit and trigger prices must stay within mark * (1 ± devPct). */
function clampToBand(label: string, price: number, mark: number, devPct: number, clamps: string[]): number {
  const hi = mark * (1 + devPct / 100);
  const lo = mark * (1 - devPct / 100);
  if (price > hi) {
    clamps.push(`${label} ${fmt(price)} above +${devPct}% of mark; clamped to ${fmt(hi)}`);
    return hi;
  }
  if (price < lo) {
    clamps.push(`${label} ${fmt(price)} below -${devPct}% of mark; clamped to ${fmt(lo)}`);
    return lo;
  }
  return price;
}

function resolvePrice(
  label: string,
  value: number | undefined,
  mark: number,
  devPct: number,
  rejects: string[],
  clamps: string[],
): number | undefined {
  if (value === undefined) {
    rejects.push(`${label} is required for this order type`);
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    rejects.push(`${label} must be > 0`);
    return undefined;
  }
  if (!(Number.isFinite(mark) && mark > 0)) return value; // invalid mark is already rejected by the caller
  return clampToBand(label, value, mark, devPct, clamps);
}

function resolveTwap(
  proposal: Proposal,
  def: TemplateDef,
  config: StrategyConfig,
  rejects: string[],
  clamps: string[],
): { durationSeconds: number; bucketCount: number } | undefined {
  let buckets = proposal.twapBuckets;
  if (buckets === undefined) {
    const fallback = sliderValue(config, def, "buckets");
    if (fallback === undefined) {
      rejects.push("twap order needs twapBuckets");
      return undefined;
    }
    clamps.push(`twap buckets missing; using ${fallback}`);
    buckets = fallback;
  }

  let duration = proposal.twapDurationSec;
  if (duration === undefined) {
    const period = sliderValue(config, def, "periodMin");
    if (period === undefined) {
      rejects.push("twap order needs twapDurationSec");
      return undefined;
    }
    duration = period * 60 * buckets;
    clamps.push(`twap duration missing; using ${period} min per bucket x ${buckets} buckets`);
  }

  if (!Number.isFinite(buckets) || !Number.isFinite(duration)) {
    rejects.push("twap buckets and duration must be finite numbers");
    return undefined;
  }
  return {
    durationSeconds: Math.round(clampInto(duration, TWAP_DURATION_SEC, "twap duration (s)", clamps)),
    bucketCount: Math.round(clampInto(Math.round(buckets), TWAP_BUCKETS, "twap buckets", clamps)),
  };
}

function resolveTrailFraction(
  proposal: Proposal,
  def: TemplateDef,
  config: StrategyConfig,
  rejects: string[],
  clamps: string[],
): number | undefined {
  let trail = proposal.trailPct;
  if (trail === undefined) {
    const fallback = sliderValue(config, def, "trailPct");
    if (fallback === undefined) {
      rejects.push("trailing-stop order needs trailPct");
      return undefined;
    }
    clamps.push(`trailPct missing; using template value ${fallback}%`);
    trail = fallback;
  }
  if (!Number.isFinite(trail) || trail <= 0) {
    rejects.push("trailPct must be a positive percentage");
    return undefined;
  }
  const pct = clampInto(trail, sliderSpec(def, "trailPct") ?? PROTECTION_BOUNDS.trailPct, "trailPct %", clamps);
  return clampInto(pct / 100, TRAIL_FRACTION, "trail fraction", clamps);
}

/**
 * Deterministic policy wall. The LLM proposal is only executed if this returns approve or clamp.
 * Every failed rule adds a reason. Any rejection makes the verdict reject, with the blocking reasons.
 * Times (now, lastTradeAt) are unix ms. cooldownSec is seconds.
 */
const SELL_ONLY_ORDER_TYPES: FlashOrderType[] = ["bracket", "stop-loss", "take-profit", "trailing-stop", "trailing-stop-limit"];

export function evaluate(proposal: Proposal, ctx: PolicyContext, opts: EvaluateOptions = {}): PolicyVerdict {
  const minNotional = opts.minNotionalUsd ?? DEFAULT_MIN_NOTIONAL_USD;
  const maxDev = opts.maxLimitDeviationPct ?? DEFAULT_MAX_LIMIT_DEVIATION_PCT;
  const { config, global } = ctx;

  if (proposal.action === "hold") return { kind: "noop", reasons: ["hold: no order proposed"] };
  if (proposal.action === "cancel" || proposal.action === "adjust_stops") {
    return {
      kind: "noop",
      reasons: [`${proposal.action} passes policy; it is order management and creates no new OrderIntent`],
    };
  }

  const side: "buy" | "sell" = proposal.action === "buy" ? "buy" : "sell";
  const isBuy = side === "buy";
  const rejects: string[] = [];
  const clamps: string[] = [];

  const def = TEMPLATES[config.template];
  if (!def) return { kind: "reject", reasons: [`unknown template ${config.template}`] };

  // Global and risk gates. Sells are always allowed through these.
  if (global.killSwitch && isBuy) rejects.push("platform kill switch is on: buys blocked");
  if (ctx.riskLevel === "HALT" && isBuy) rejects.push("RiskOracle HALT: buys blocked");
  if (isBuy && (ctx.budgetTier === "critical" || ctx.budgetTier === "empty")) {
    rejects.push(`budget tier ${ctx.budgetTier}: buys blocked`);
  }

  // Asset must be enabled for the agent and on the platform allowlist.
  const asset = proposal.asset;
  if (!asset) {
    rejects.push("proposal has no asset");
  } else {
    if (!config.assets.includes(asset)) rejects.push(`${asset} is not enabled for this agent`);
    if (!global.allowedTokens.includes(asset)) rejects.push(`${asset} is not on the platform allowlist`);
  }

  // Order type must be permitted by the template.
  let orderType: FlashOrderType;
  if (proposal.orderType === undefined) {
    orderType = isBuy ? def.defaultEntryOrderType : "market";
    clamps.push(`no order type given; defaulted to ${orderType}`);
  } else {
    orderType = proposal.orderType;
  }
  // Flash order types are directional: exit types (bracket, stop-loss, take-profit, trailing stops) only sell,
  // and "stop" is a stop-buy. A buy that names an exit type becomes the template's entry type (its TP/SL is
  // attached below); a sell that names "stop" becomes a market sell.
  if (isBuy && SELL_ONLY_ORDER_TYPES.includes(orderType)) {
    // Use the template's entry type when the proposal carries the price it needs; otherwise enter at market.
    const entry = def.defaultEntryOrderType;
    const missingPrice =
      (entry === "limit" && proposal.limitPrice === undefined) || (entry === "stop" && proposal.triggerPrice === undefined);
    const replacement: FlashOrderType = missingPrice ? "market" : entry;
    clamps.push(`${orderType} only applies to sells; entering with ${replacement} and an attached TP/SL instead`);
    orderType = replacement;
  } else if (!isBuy && orderType === "stop") {
    clamps.push("stop is a stop-buy; selling with market instead");
    orderType = "market";
  }
  if (!def.allowedOrderTypes.includes(orderType)) {
    rejects.push(`order type ${orderType} is not allowed for ${def.name}`);
  }
  if (isBuy && ctx.riskLevel === "CAUTION" && orderType === "stop") {
    rejects.push("RiskOracle CAUTION: breakout (stop) entries blocked");
  }

  // Sizing: buys use sizePct x effective allocation. Sells use sizePct x current position when it is known.
  const allocation = Math.min(ctx.allocationUsd, config.limits.maxAllocationUsd, global.maxAgentAllocationUsd);
  if (allocation < ctx.allocationUsd) {
    clamps.push(`allocation $${fmt(ctx.allocationUsd)} capped to $${fmt(allocation)}`);
  }

  const position = isBuy ? undefined : ctx.positionUsd;
  if (position !== undefined && !(position > 0)) rejects.push("no position to sell");
  const sizeBase = position ?? allocation;
  const sizeLabel = position !== undefined ? "position" : "allocation";

  // Templates without a sizePct slider (smart_dca) are capped at the full base; budgetUsd caps below.
  const templateSizePct = sliderValue(config, def, "sizePct") ?? PROTECTION_BOUNDS.sizePct.max;
  let sizeFrac: number;
  if (proposal.sizePct === undefined) {
    sizeFrac = isBuy ? templateSizePct / 100 : 1;
    clamps.push(isBuy ? `no size given; using template size ${templateSizePct}%` : `no size given; sell defaults to full ${sizeLabel}`);
  } else {
    sizeFrac = proposal.sizePct;
  }
  if (!Number.isFinite(sizeFrac) || sizeFrac <= 0) {
    rejects.push("sizePct must be > 0");
    sizeFrac = 0;
  } else if (isBuy && sizeFrac > templateSizePct / 100) {
    clamps.push(`size ${Math.round(sizeFrac * 100)}% capped to template maximum ${templateSizePct}%`);
    sizeFrac = templateSizePct / 100;
  } else if (sizeFrac > 1) {
    clamps.push(`size capped to 100% of ${sizeLabel}`);
    sizeFrac = 1;
  }

  // sizeFrac is at most 1 here, so a sell never exceeds positionUsd.
  let notional = sizeFrac * sizeBase;
  if (isBuy && ctx.riskLevel === "CAUTION") {
    notional /= 2;
    clamps.push("RiskOracle CAUTION: notional halved");
  }
  if (notional > config.limits.maxTradeUsd) {
    clamps.push(`notional $${fmt(notional)} capped to agent max trade $${fmt(config.limits.maxTradeUsd)}`);
    notional = config.limits.maxTradeUsd;
  }
  if (notional > global.maxTradeUsd) {
    clamps.push(`notional $${fmt(notional)} capped to platform max trade $${fmt(global.maxTradeUsd)}`);
    notional = global.maxTradeUsd;
  }
  const budgetUsd = sliderValue(config, def, "budgetUsd");
  if (isBuy && budgetUsd !== undefined && notional > budgetUsd) {
    clamps.push(`notional $${fmt(notional)} capped to template budget $${fmt(budgetUsd)}`);
    notional = budgetUsd;
  }

  // Protection: every buy carries a take-profit and stop-loss bracket, priced from the mark.
  const mark = ctx.markPrice;
  const markOk = Number.isFinite(mark) && mark > 0;
  if (!markOk) rejects.push("invalid mark price");

  let attachedBracket: OrderIntent["attachedBracket"];
  if (isBuy) {
    const tp = resolveProtectionPct(
      "take-profit",
      proposal.takeProfitPct,
      def,
      config,
      TP_SLIDERS,
      PROTECTION_BOUNDS.takeProfitPct,
      rejects,
      clamps,
    );
    const sl = resolveProtectionPct(
      "stop-loss",
      proposal.stopLossPct,
      def,
      config,
      SL_SLIDERS,
      PROTECTION_BOUNDS.stopLossPct,
      rejects,
      clamps,
    );
    if (tp !== undefined && sl !== undefined && markOk) {
      attachedBracket = {
        takeProfitPrice: mark * (1 + tp / 100),
        stopLossPrice: mark * (1 - sl / 100),
      };
    }
  }

  // Price-bearing order types.
  let limitPrice: number | undefined;
  let triggerPrice: number | undefined;
  if (orderType === "limit") {
    limitPrice = resolvePrice("limitPrice", proposal.limitPrice, mark, maxDev, rejects, clamps);
  }
  if (orderType === "stop" || orderType === "stop-loss" || orderType === "take-profit") {
    triggerPrice = resolvePrice("triggerPrice", proposal.triggerPrice, mark, maxDev, rejects, clamps);
  }

  let trailPercent: number | undefined;
  if (orderType === "trailing-stop") {
    trailPercent = resolveTrailFraction(proposal, def, config, rejects, clamps);
  }

  let twap: { durationSeconds: number; bucketCount: number } | undefined;
  if (orderType === "twap") {
    twap = resolveTwap(proposal, def, config, rejects, clamps);
  }

  // Buy-only account limits.
  if (isBuy) {
    const cooldownMs = config.limits.cooldownSec * 1000;
    if (ctx.lastTradeAt !== null && ctx.lastTradeAt + cooldownMs > ctx.now) {
      const secLeft = Math.ceil((ctx.lastTradeAt + cooldownMs - ctx.now) / 1000);
      rejects.push(`cooldown: ${secLeft}s left before the next trade`);
    }

    const maxPositions = Math.min(config.limits.maxOpenPositions, global.maxOpenPositions);
    if (ctx.openPositions >= maxPositions) {
      rejects.push(`open positions ${ctx.openPositions} at cap ${maxPositions}`);
    }

    const maxDailyLoss = Math.min(config.limits.maxDailyLossUsd, global.maxDailyLossUsdPerAgent);
    if (ctx.dailyPnlUsd <= -maxDailyLoss) {
      rejects.push(`daily loss limit $${fmt(maxDailyLoss)} reached: agent paused for the day`);
    }

    if (ctx.drawdownPct >= config.limits.maxDrawdownPct) {
      rejects.push(`drawdown ${fmt(ctx.drawdownPct)}% at or above limit ${config.limits.maxDrawdownPct}%: agent paused`);
    }

    // The slider is in percent (0..100) and forecast.confidence is a fraction (0..1). Divide the slider to compare.
    // Missing forecast: this rule does not apply.
    const minConfidence = sliderValue(config, def, "minConfidence");
    if (ctx.forecast && minConfidence !== undefined && ctx.forecast.confidence < minConfidence / 100) {
      rejects.push(`forecast confidence ${fmt(ctx.forecast.confidence * 100)}% below minimum ${minConfidence}%`);
    }
  }

  // Daily volume cap applies to buys and sells. Clamp to what remains, or reject if nothing remains.
  const remainingVolume = global.maxDailyVolumeUsdPerAgent - ctx.dailyVolumeUsd;
  if (notional > remainingVolume) {
    if (remainingVolume <= 0) {
      rejects.push("daily volume cap reached");
    } else {
      clamps.push(`notional capped to $${fmt(remainingVolume)} left under daily volume cap`);
      notional = remainingVolume;
    }
  }

  if (notional < minNotional) {
    rejects.push(`notional $${fmt(notional)} is below minimum $${fmt(minNotional)}`);
  }

  if (!asset || rejects.length > 0) return { kind: "reject", reasons: rejects };

  const order: OrderIntent = {
    side,
    asset,
    quoteAsset: "USDC",
    orderType,
    notionalUsd: notional,
  };
  if (limitPrice !== undefined) order.limitPrice = limitPrice;
  if (triggerPrice !== undefined) order.triggerPrice = triggerPrice;
  if (trailPercent !== undefined) order.trailPercent = trailPercent;
  if (twap) order.twap = twap;
  if (attachedBracket) order.attachedBracket = attachedBracket;

  return clamps.length > 0 ? { kind: "clamp", order, reasons: clamps } : { kind: "approve", order };
}
