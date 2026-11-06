// Builds and validates a StrategyConfig from a create request. Server-only.
// Base = @arena/policy defaultConfig(template, global limits from env). User overrides are whitelisted and
// type-checked, then the merged config goes through @arena/policy validateConfig against the env caps.
import { defaultConfig, validateConfig } from "@arena/policy";
import { globalLimitsFromEnv, type Env, type InsightSource, type StrategyConfig, type TemplateId } from "@arena/shared";

import { TEMPLATE_INDEX } from "@/lib/templates";
import { ApiError } from "@/lib/server/errors";

const CRASH_MODES = ["tighten_stops", "flatten"] as const;
const MODEL_TIERS = ["strong", "balanced", "economical"] as const;
const COMMENTARY = ["off", "delayed"] as const;

export interface BuiltAgentConfig {
  name: string;
  template: TemplateId;
  live: boolean;
  config: StrategyConfig;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function buildAgentConfig(body: unknown, e: Env): BuiltAgentConfig {
  if (!isRec(body)) throw new ApiError(400, "BAD_REQUEST", "Body must be a JSON object");
  const errors: string[] = [];

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 3 || name.length > 32) errors.push("name must be 3-32 characters");

  const c: Rec = isRec(body.config) ? body.config : {};
  const template = c.template;
  if (typeof template !== "string" || !(template in TEMPLATE_INDEX)) errors.push("unknown template");
  if (errors.length > 0 || typeof template !== "string") throw new ApiError(422, "VALIDATION", "Invalid agent", errors);
  const tpl = template as TemplateId;

  const global = globalLimitsFromEnv(e);
  const assets = Array.isArray(c.assets) && c.assets.every((a) => typeof a === "string") ? (c.assets as string[]) : undefined;
  const commissionBps = num(c.commissionBps) ? c.commissionBps : e.COMMISSION_BPS_DEFAULT;
  const tickIntervalSec = num(c.tickIntervalSec) ? c.tickIntervalSec : undefined;
  const base = defaultConfig(tpl, { assets, commissionBps, tickIntervalSec, global });

  const sliders: Record<string, number> = { ...base.sliders };
  if (c.sliders !== undefined) {
    if (!isRec(c.sliders)) errors.push("sliders must be an object");
    else for (const [k, v] of Object.entries(c.sliders)) {
      if (!num(v)) errors.push(`slider ${k} must be a number`);
      else sliders[k] = v;
    }
  }

  const limits = { ...base.limits };
  if (c.limits !== undefined) {
    if (!isRec(c.limits)) errors.push("limits must be an object");
    else for (const k of Object.keys(limits) as (keyof typeof limits)[]) {
      const v = c.limits[k];
      if (v === undefined) continue;
      if (!num(v)) errors.push(`limits.${k} must be a number`);
      else limits[k] = v;
    }
  }

  const modelTier = pickOne(c.modelTier, MODEL_TIERS, "modelTier", errors) ?? base.modelTier;
  const crashMode = pickOne(c.crashMode, CRASH_MODES, "crashMode", errors) ?? base.crashMode;
  const publicCommentary = pickOne(c.publicCommentary, COMMENTARY, "publicCommentary", errors) ?? base.publicCommentary;

  const autoTune = isRec(c.autoTune)
    ? {
        enabled: typeof c.autoTune.enabled === "boolean" ? c.autoTune.enabled : base.autoTune.enabled,
        maxDeltaPct: num(c.autoTune.maxDeltaPct) ? c.autoTune.maxDeltaPct : base.autoTune.maxDeltaPct,
      }
    : base.autoTune;

  const fork = isRec(c.fork)
    ? {
        forkable: typeof c.fork.forkable === "boolean" ? c.fork.forkable : false,
        priceUsd: num(c.fork.priceUsd) ? c.fork.priceUsd : 0,
      }
    : base.fork;

  const insightSources = parseSources(c.insightSources, errors);

  if (errors.length > 0) throw new ApiError(422, "VALIDATION", "Invalid agent config", errors);

  const config: StrategyConfig = {
    ...base,
    assets: assets ?? base.assets,
    sliders,
    limits,
    tickIntervalSec: tickIntervalSec ?? base.tickIntervalSec,
    modelTier,
    crashMode,
    commissionBps,
    autoTune,
    publicCommentary,
    insightSources: insightSources ?? base.insightSources,
    fork,
  };

  const result = validateConfig(config, global, { min: e.COMMISSION_BPS_MIN, max: e.COMMISSION_BPS_MAX });
  if (!result.ok) throw new ApiError(422, "VALIDATION", "Config is outside platform limits", result.errors);

  return { name, template: tpl, live: body.live === true, config };
}

function pickOne<T extends string>(v: unknown, allowed: readonly T[], field: string, errors: string[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  errors.push(`${field} must be one of ${allowed.join(", ")}`);
  return undefined;
}

function parseSources(v: unknown, errors: string[]): InsightSource[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push("insightSources must be an array");
    return undefined;
  }
  const out: InsightSource[] = [];
  for (const s of v) {
    if (!isRec(s)) {
      errors.push("insight source must be an object");
      continue;
    }
    if (s.kind === "web_search") out.push({ kind: "web_search" });
    else if (s.kind === "rss" && typeof s.url === "string" && /^https:\/\/.+/.test(s.url)) out.push({ kind: "rss", url: s.url });
    else if (s.kind === "agent" && typeof s.agentId === "string") out.push({ kind: "agent", agentId: s.agentId });
    else errors.push("insight source is not allowed");
  }
  return out;
}
