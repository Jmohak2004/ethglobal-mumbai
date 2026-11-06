// Strategy templates, slider definitions and client-side form pre-checks.
// Client-safe: only `import type` from @arena/shared, no runtime imports.
// Slider keys, bounds, steps and defaults MIRROR packages/policy/src/templates.ts. The server validates
// with @arena/policy validateConfig, which rejects any drift, so keep the two in sync.
import type {
  AgentLimits,
  CrashMode,
  FlashOrderType,
  ModelTier,
  StrategyConfig,
  TemplateId,
} from "@arena/shared";

export interface SliderDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: string;
}

export interface TemplateDef {
  id: TemplateId;
  name: string;
  blurb: string;
  /** One-line description of the decision logic (shown in the builder and on agent pages). */
  logic: string;
  orderTypes: FlashOrderType[];
  sliders: SliderDef[];
}

// Shared protection sliders (bounds from policy PROTECTION_BOUNDS).
const minConfidence: SliderDef = { key: "minConfidence", label: "Min confidence", min: 0, max: 100, step: 1, default: 60, unit: "%" };
const sizePct: SliderDef = { key: "sizePct", label: "Position size", min: 5, max: 100, step: 1, default: 25, unit: "% alloc" };
const takeProfitPct: SliderDef = { key: "takeProfitPct", label: "Take-profit", min: 0.5, max: 20, step: 0.5, default: 4, unit: "%" };
const stopLossPct: SliderDef = { key: "stopLossPct", label: "Stop-loss", min: 0.5, max: 15, step: 0.5, default: 2, unit: "%" };

export const TEMPLATES: TemplateDef[] = [
  {
    id: "momentum",
    name: "Momentum",
    blurb: "Ride trends.",
    logic: "EMA/ROC trend, confirmed by LLM forecast. Entries carry a bracket.",
    orderTypes: ["limit", "market", "trailing-stop", "bracket"],
    sliders: [
      { key: "lookbackBars", label: "Lookback", min: 5, max: 100, step: 1, default: 20, unit: "bars" },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
      { key: "trailPct", label: "Trailing stop", min: 0.5, max: 10, step: 0.5, default: 2, unit: "%" },
    ],
  },
  {
    id: "mean_reversion",
    name: "Mean Reversion",
    blurb: "Buy dips, sell spikes.",
    logic: "RSI / Bollinger extremes, LLM regime check. Limit entry with bracket.",
    orderTypes: ["limit", "bracket"],
    sliders: [
      { key: "rsiLow", label: "RSI oversold", min: 5, max: 45, step: 1, default: 30, unit: "RSI" },
      { key: "rsiHigh", label: "RSI overbought", min: 55, max: 95, step: 1, default: 70, unit: "RSI" },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
      { key: "maxHoldMin", label: "Max hold", min: 15, max: 10080, step: 15, default: 240, unit: "min" },
    ],
  },
  {
    id: "breakout",
    name: "Breakout",
    blurb: "Buy when price breaks a range.",
    logic: "Range high/low with an LLM false-breakout filter. Stop-buy with bracket.",
    orderTypes: ["stop", "bracket"],
    sliders: [
      { key: "rangeBars", label: "Range window", min: 5, max: 200, step: 1, default: 20, unit: "bars" },
      { key: "breakoutPct", label: "Breakout distance", min: 0.1, max: 5, step: 0.1, default: 0.5, unit: "%" },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
    ],
  },
  {
    id: "smart_dca",
    name: "Smart DCA",
    blurb: "Buy slowly over time.",
    logic: "Scheduled TWAP accumulation. The LLM may raise the bucket multiplier on dips, up to the cap.",
    orderTypes: ["twap", "limit"],
    sliders: [
      { key: "budgetUsd", label: "Budget", min: 1, max: 1000, step: 1, default: 5, unit: "USD" },
      { key: "periodMin", label: "Period", min: 5, max: 10080, step: 5, default: 60, unit: "min" },
      { key: "buckets", label: "Buckets", min: 2, max: 2560, step: 1, default: 10, unit: "#" },
      { key: "dipMultiplierMax", label: "Dip multiplier max", min: 1, max: 5, step: 0.1, default: 2, unit: "x" },
      { key: "stopLossFloorPct", label: "Stop-loss floor", min: 0.5, max: 15, step: 0.5, default: 10, unit: "%" },
    ],
  },
  {
    id: "social_sentiment",
    name: "Social Sentiment",
    blurb: "Trade on news and other agents' views.",
    logic: "Insight digest across sources plus LLM forecast. Limit entry with bracket.",
    orderTypes: ["limit", "bracket"],
    sliders: [
      { key: "minSourceAgreement", label: "Min source agreement", min: 0, max: 100, step: 1, default: 60, unit: "%" },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
    ],
  },
];

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

// ---- Platform limits (mirror EnvSchema defaults in @arena/shared config) ----

export const ASSET_ALLOWLIST: string[] = ["WETH", "cbBTC"];

/** Demo caps. Create-form inputs clamp to these; the server enforces the live env values. */
export const DEMO_CAPS = {
  maxTradeUsd: 1,
  maxAllocationUsd: 5,
  maxDailyVolumeUsd: 20,
  maxDailyLossUsd: 1,
  maxOpenPositions: 2,
} as const;

export const COMMISSION_BPS = { min: 0, max: 2000, default: 1000 } as const;
export const FORK_PLATFORM_BPS = 3000;
export const FORK_PRICE_MAX_USD = 50;
export const TICK_SEC = { min: 60, max: 3600, default: 300 } as const;
export const FLASH_INTEGRATOR_FEE_BPS = 10;

/** Demo owner used by `?owner=1` (no wallet needed). Also seeded as a human on the board. Non-production only. */
export const DEMO_OWNER = "0x4e1b0c2a9f3d7b8e5a6c1d0f2e9b3a7c8d5e6f10" as const;

export type Timeframe = "24h" | "7d" | "30d" | "all";
export const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export const MODEL_TIERS: { value: ModelTier; label: string; note: string }[] = [
  { value: "strong", label: "Strong", note: "Best reasoning, highest 0G spend." },
  { value: "balanced", label: "Balanced", note: "Default for most strategies." },
  { value: "economical", label: "Economical", note: "Cheapest. Used automatically in the Low budget tier." },
];

export const CRASH_MODES: { value: CrashMode; label: string; note: string }[] = [
  { value: "tighten_stops", label: "Tighten stops", note: "On HALT: cancel entries and tighten stop-losses." },
  { value: "flatten", label: "Flatten to USDC", note: "On HALT: cancel entries and sell everything to USDC." },
];

/** Template index used by AgentRegistry.Agent.template (uint8). Order matches TEMPLATES. */
export const TEMPLATE_INDEX: Record<TemplateId, number> = {
  momentum: 0,
  mean_reversion: 1,
  breakout: 2,
  smart_dca: 3,
  social_sentiment: 4,
};

// ---- Defaults and builders ----

export function defaultSliders(id: TemplateId): Record<string, number> {
  const t = getTemplate(id);
  if (!t) return {};
  return Object.fromEntries(t.sliders.map((s) => [s.key, s.default]));
}

export function defaultLimits(allocationUsd = DEMO_CAPS.maxAllocationUsd): AgentLimits {
  return {
    maxTradeUsd: DEMO_CAPS.maxTradeUsd,
    maxOpenPositions: 1,
    maxAllocationUsd: allocationUsd,
    maxDailyLossUsd: DEMO_CAPS.maxDailyLossUsd,
    maxDrawdownPct: 20,
    cooldownSec: 600,
  };
}

export function defaultStrategy(id: TemplateId): StrategyConfig {
  return {
    template: id,
    assets: ["WETH"],
    sliders: defaultSliders(id),
    limits: defaultLimits(),
    tickIntervalSec: TICK_SEC.default,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: COMMISSION_BPS.default,
    autoTune: { enabled: false, maxDeltaPct: 10 },
    publicCommentary: "off",
    insightSources: [],
    fork: { forkable: false, priceUsd: 0 },
  };
}

// ---- Client pre-check (fast feedback in the form). The server re-validates with @arena/policy. ----

export interface CreateInput {
  name: string;
  ownerAddress: string;
  config: StrategyConfig;
}

export type ValidationResult = { ok: true; value: CreateInput } | { ok: false; errors: string[] };

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function validateCreateInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  const o = (input ?? {}) as Partial<CreateInput>;
  const c = (o.config ?? {}) as Partial<StrategyConfig>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (name.length < 3 || name.length > 32) errors.push("name must be 3-32 characters");
  if (typeof o.ownerAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.ownerAddress)) {
    errors.push("ownerAddress must be a 0x address");
  }

  const tpl = getTemplate(String(c.template));
  if (!tpl) errors.push("unknown template");

  const assets = Array.isArray(c.assets) ? c.assets : [];
  if (assets.length === 0) errors.push("pick at least one asset");
  for (const a of assets) if (!ASSET_ALLOWLIST.includes(a)) errors.push(`asset ${a} is not allowlisted`);

  if (tpl) {
    const sliders = (c.sliders ?? {}) as Record<string, unknown>;
    for (const s of tpl.sliders) {
      if (!inRange(sliders[s.key], s.min, s.max)) errors.push(`${s.label} must be between ${s.min} and ${s.max}`);
    }
  }

  const l = (c.limits ?? {}) as Partial<AgentLimits>;
  if (!inRange(l.maxTradeUsd, 0, DEMO_CAPS.maxTradeUsd)) errors.push(`maxTradeUsd must be <= ${DEMO_CAPS.maxTradeUsd}`);
  if (!inRange(l.maxAllocationUsd, 0, DEMO_CAPS.maxAllocationUsd)) {
    errors.push(`maxAllocationUsd must be <= ${DEMO_CAPS.maxAllocationUsd}`);
  }
  if (!inRange(l.maxDailyLossUsd, 0, DEMO_CAPS.maxDailyLossUsd)) errors.push(`maxDailyLossUsd must be <= ${DEMO_CAPS.maxDailyLossUsd}`);
  if (!inRange(l.maxOpenPositions, 1, DEMO_CAPS.maxOpenPositions)) {
    errors.push(`maxOpenPositions must be 1-${DEMO_CAPS.maxOpenPositions}`);
  }
  if (!inRange(l.maxDrawdownPct, 1, 100)) errors.push("maxDrawdownPct must be 1-100");
  if (!inRange(l.cooldownSec, 0, 86_400)) errors.push("cooldownSec must be 0-86400");

  if (!inRange(c.tickIntervalSec, TICK_SEC.min, TICK_SEC.max)) errors.push("tickIntervalSec out of range");
  if (!inRange(c.commissionBps, COMMISSION_BPS.min, COMMISSION_BPS.max)) errors.push("commissionBps out of range");
  if (!MODEL_TIERS.some((m) => m.value === c.modelTier)) errors.push("invalid modelTier");
  if (!CRASH_MODES.some((m) => m.value === c.crashMode)) errors.push("invalid crashMode");
  if (!inRange(c.fork?.priceUsd, 0, FORK_PRICE_MAX_USD)) errors.push(`fork price must be 0-${FORK_PRICE_MAX_USD}`);

  if (errors.length > 0 || !tpl || typeof o.ownerAddress !== "string") return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      ownerAddress: o.ownerAddress,
      config: c as StrategyConfig,
    },
  };
}
