import { agentIdToBytes32 } from "@arena/shared";
import type { GlobalLimits, InsightSource, StrategyConfig, TemplateId } from "@arena/shared";
import { TEMPLATES } from "./templates.ts";

/** Defaults for limits that have no global counterpart in GlobalLimits. */
export const DEFAULT_COOLDOWN_SEC = 60;
export const DEFAULT_MAX_DRAWDOWN_PCT = 20;
export const MIN_TICK_INTERVAL_SEC = 30;

const MODEL_TIERS = ["strong", "balanced", "economical"] as const;
const CRASH_MODES = ["tighten_stops", "flatten"] as const;

export interface DefaultConfigOptions {
  /** Defaults to the first platform-allowed token. */
  assets?: string[];
  commissionBps: number;
  tickIntervalSec?: number;
  global: GlobalLimits;
}

export function defaultConfig(template: TemplateId, opts: DefaultConfigOptions): StrategyConfig {
  const def = TEMPLATES[template];
  const { global } = opts;

  const sliders: Record<string, number> = {};
  for (const s of def.sliders) sliders[s.key] = s.default;

  return {
    template,
    assets: opts.assets ?? global.allowedTokens.slice(0, 1),
    sliders,
    limits: {
      maxTradeUsd: global.maxTradeUsd,
      maxOpenPositions: global.maxOpenPositions,
      maxAllocationUsd: global.maxAgentAllocationUsd,
      maxDailyLossUsd: global.maxDailyLossUsdPerAgent,
      maxDrawdownPct: DEFAULT_MAX_DRAWDOWN_PCT,
      cooldownSec: DEFAULT_COOLDOWN_SEC,
    },
    tickIntervalSec: opts.tickIntervalSec ?? def.defaultTickIntervalSec,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: opts.commissionBps,
    autoTune: { enabled: false, maxDeltaPct: 5 },
    publicCommentary: "delayed",
    insightSources: template === "social_sentiment" ? [{ kind: "web_search" } satisfies InsightSource] : [],
    fork: { forkable: false, priceUsd: 0 },
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateConfig(
  config: StrategyConfig,
  global: GlobalLimits,
  commissionBounds: { min: number; max: number },
): ValidationResult {
  const errors: string[] = [];
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  const def = TEMPLATES[config.template as TemplateId];
  if (!def) {
    errors.push(`unknown template "${config.template}"`);
  } else {
    const known = new Set(def.sliders.map((s) => s.key));
    for (const s of def.sliders) {
      const v = config.sliders[s.key];
      if (!num(v)) {
        errors.push(`slider ${s.key} is missing or not a number`);
        continue;
      }
      if (v < s.min || v > s.max) errors.push(`slider ${s.key}=${v} outside [${s.min}, ${s.max}]`);
      const steps = (v - s.min) / s.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) errors.push(`slider ${s.key}=${v} not on step ${s.step}`);
    }
    for (const key of Object.keys(config.sliders)) {
      if (!known.has(key)) errors.push(`unknown slider ${key} for template ${config.template}`);
    }
  }

  if (config.assets.length === 0) errors.push("assets must not be empty");
  for (const a of config.assets) {
    if (!global.allowedTokens.includes(a)) errors.push(`asset ${a} is not on the platform allowlist`);
  }

  const { limits } = config;
  const cappedLimits: [string, number, number][] = [
    ["maxTradeUsd", limits.maxTradeUsd, global.maxTradeUsd],
    ["maxOpenPositions", limits.maxOpenPositions, global.maxOpenPositions],
    ["maxAllocationUsd", limits.maxAllocationUsd, global.maxAgentAllocationUsd],
    ["maxDailyLossUsd", limits.maxDailyLossUsd, global.maxDailyLossUsdPerAgent],
  ];
  for (const [name, value, cap] of cappedLimits) {
    if (!num(value) || value <= 0) errors.push(`limits.${name} must be > 0`);
    else if (value > cap) errors.push(`limits.${name}=${value} exceeds global cap ${cap}`);
  }
  if (!num(limits.maxDrawdownPct) || limits.maxDrawdownPct <= 0) errors.push("limits.maxDrawdownPct must be > 0");
  if (!num(limits.cooldownSec) || limits.cooldownSec < 0) errors.push("limits.cooldownSec must be >= 0");

  if (!num(config.commissionBps) || config.commissionBps < commissionBounds.min || config.commissionBps > commissionBounds.max) {
    errors.push(`commissionBps=${config.commissionBps} outside [${commissionBounds.min}, ${commissionBounds.max}]`);
  }
  if (!num(config.tickIntervalSec) || config.tickIntervalSec < MIN_TICK_INTERVAL_SEC) {
    errors.push(`tickIntervalSec must be >= ${MIN_TICK_INTERVAL_SEC}`);
  }
  if (!num(config.fork.priceUsd) || config.fork.priceUsd < 0) errors.push("fork.priceUsd must be >= 0");
  if (!(MODEL_TIERS as readonly string[]).includes(config.modelTier)) errors.push(`unknown modelTier ${config.modelTier}`);
  if (!(CRASH_MODES as readonly string[]).includes(config.crashMode)) errors.push(`unknown crashMode ${config.crashMode}`);

  return { ok: errors.length === 0, errors };
}

/** Recursively sorts object keys so that key order never changes the output. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * keccak256 of the canonical JSON of the config, as bytes32 hex.
 * Uses agentIdToBytes32 from @arena/shared, which is keccak256(toBytes(string)).
 * viem is not resolvable from this package (it is only installed under packages/shared),
 * so we reuse the shared helper instead of importing viem directly.
 */
export function configHash(config: StrategyConfig): `0x${string}` {
  return agentIdToBytes32(JSON.stringify(canonicalize(config)));
}
