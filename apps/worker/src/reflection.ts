// Reflection and self-improvement (PRD 6.6). Over recent episodes and closed trades, the decision model
// writes lessons. The lessons and the episodes are uploaded as one JSON batch to the memory store, and the
// root hash is stored on each. With auto-tune enabled, suggested slider changes are applied only within the
// owner's ±maxDeltaPct window and the template bounds, after the config is re-validated. Each change is a
// new config version. Hard limits are never touched.

import {
  insertLesson,
  listEpisodesByAgent,
  newId,
  setEpisodeStorageRoot,
  topForAgent,
  updateConfig,
  type Db,
} from "@arena/db";
import { computeFifoPnl, type Trade } from "@arena/flash";
import { configHash, TEMPLATES, validateConfig, type SliderDef } from "@arena/policy";
import type { Agent, BudgetTier, GlobalLimits, Lesson, StrategyConfig } from "@arena/shared";
import { reflect, type ClosedTrade, type MemoryStore, type SliderSuggestion, type ZeroGRouter } from "@arena/zerog";
import type { Clock } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { loadAgentState } from "./tick.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRADES_FOR_REFLECTION = 200;

export interface ReflectionDeps {
  db: Db;
  clock: Clock;
  logger?: Logger;
  memory: MemoryStore;
  routerFor: (agent: Agent) => ZeroGRouter;
  globalLimits: GlobalLimits;
  commissionBounds: { min: number; max: number };
}

export interface ReflectionSummary {
  lessons: number;
  storageRoot: string | null;
  autoTuned: string[];
  error: string | null;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One ClosedTrade per sell, with the PnL it realized under FIFO. Entry is the FIFO average cost before the sell. */
export function closedTradesFrom(trades: Trade[]): ClosedTrade[] {
  const ordered = [...trades].sort((a, b) => a.ts - b.ts);
  const out: ClosedTrade[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (!t || t.side !== "sell") continue;
    const before = computeFifoPnl(ordered.slice(0, i));
    const after = computeFifoPnl(ordered.slice(0, i + 1));
    const entryPrice = before.openPositions.find((p) => p.asset === t.asset)?.avgCostUsd ?? 0;
    out.push({
      asset: t.asset,
      side: "sell",
      entryPrice,
      exitPrice: t.price,
      pnlUsd: after.realizedPnlUsd - before.realizedPnlUsd,
      pnlPct: entryPrice > 0 ? ((t.price - entryPrice) / entryPrice) * 100 : 0,
      // Lots are not tracked with their open time, so openedAt is the close time.
      openedAt: t.ts,
      closedAt: t.ts,
    });
  }
  return out;
}

/**
 * Applies model suggestions to the sliders. Each change is clamped to ±maxDeltaPct of the current value,
 * snapped to the slider step, and kept within the template bounds. A snapped value that leaves the window is
 * dropped. Unknown keys are ignored. Returns the new sliders and a description of each change.
 */
export function applySliderSuggestions(
  current: Record<string, number>,
  suggestions: SliderSuggestion[],
  specs: SliderDef[],
  maxDeltaPct: number,
): { sliders: Record<string, number>; applied: string[] } {
  const sliders = { ...current };
  const applied: string[] = [];
  const seen = new Set<string>();

  for (const s of suggestions) {
    const spec = specs.find((x) => x.key === s.key);
    if (!spec || seen.has(s.key)) continue;
    seen.add(s.key);
    const from = sliders[s.key];
    if (typeof from !== "number" || !Number.isFinite(from) || !Number.isFinite(s.to)) continue;

    const delta = (Math.abs(from) * maxDeltaPct) / 100;
    let target = Math.min(Math.max(s.to, from - delta), from + delta);
    target = Math.min(Math.max(target, spec.min), spec.max);
    target = spec.min + Math.round((target - spec.min) / spec.step) * spec.step;
    target = Number(target.toFixed(6));
    if (target === from || Math.abs(target - from) > delta + 1e-9) continue;

    sliders[s.key] = target;
    applied.push(`${s.key} ${from}->${target}`);
  }
  return { sliders, applied };
}

/** Writes at most one auto-tune version per 24 h. Returns the changes applied (empty when none). */
async function applyAutoTune(
  deps: ReflectionDeps,
  agent: Agent,
  suggestions: SliderSuggestion[],
  now: number,
  log: Logger,
): Promise<string[]> {
  if (!agent.config.autoTune.enabled || suggestions.length === 0) return [];
  const recent = await deps.db.query.agentConfigVersions.findFirst({
    where: (v, { and, eq, gte, like }) =>
      and(eq(v.agentId, agent.id), like(v.changelog, "auto-tune%"), gte(v.createdAt, now - DAY_MS)),
  });
  if (recent) {
    log.info("auto-tune skipped: already changed in the last 24 h", { version: recent.version });
    return [];
  }

  const { sliders, applied } = applySliderSuggestions(
    agent.config.sliders,
    suggestions,
    TEMPLATES[agent.config.template].sliders,
    agent.config.autoTune.maxDeltaPct,
  );
  if (applied.length === 0) return [];

  const next: StrategyConfig = { ...agent.config, sliders };
  const check = validateConfig(next, deps.globalLimits, deps.commissionBounds);
  if (!check.ok) {
    log.warn("auto-tune rejected by validation", { errors: check.errors });
    return [];
  }
  await updateConfig(deps.db, agent.id, {
    config: next,
    configHash: configHash(next),
    changelog: `auto-tune: ${applied.join("; ")}`,
    expectedVersion: agent.configVersion,
    createdAt: now,
  });
  log.info("auto-tune applied", { changes: applied });
  return applied;
}

/** Runs one reflection for an agent. Never throws. Errors are reported in the summary. */
export async function reflectAgent(deps: ReflectionDeps, agent: Agent, budget: BudgetTier = "healthy"): Promise<ReflectionSummary> {
  const log = (deps.logger ?? silentLogger).child({ agent: agent.id });
  const summary: ReflectionSummary = { lessons: 0, storageRoot: null, autoTuned: [], error: null };
  try {
    const now = deps.clock.now();
    const episodes = await listEpisodesByAgent(deps.db, agent.id, { limit: 50 });
    if (episodes.length === 0) return summary;

    const state = await loadAgentState(deps.db, agent, now);
    const closedTrades = closedTradesFrom(state.trades.slice(-MAX_TRADES_FOR_REFLECTION));
    const existingLessons = await topForAgent(deps.db, agent.id, { k: 10 });

    const res = await reflect(deps.routerFor(agent), {
      agentId: agent.id,
      agentName: agent.name,
      episodes,
      closedTrades,
      existingLessons,
      sliders: agent.config.sliders,
      modelTier: agent.config.modelTier,
      budget,
    });
    if (res.error) {
      log.warn("reflection produced no usable output", { error: res.error });
      return { ...summary, error: res.error };
    }

    const lessons: Lesson[] = res.lessons.map((l) => ({ ...l, id: newId(), zgStorageRoot: null }));
    const unrooted = episodes.filter((e) => e.zgStorageRoot === null);
    if (lessons.length > 0 || unrooted.length > 0) {
      try {
        const put = await deps.memory.putJson({
          kind: "arena.memory.batch.v1",
          agentId: agent.id,
          ts: now,
          episodes: unrooted,
          lessons,
        });
        summary.storageRoot = put.rootHash;
      } catch (err) {
        log.error("memory upload failed; lessons stored without a root", { error: err });
      }
    }

    for (const lesson of lessons) {
      await insertLesson(deps.db, { ...lesson, zgStorageRoot: summary.storageRoot });
    }
    if (summary.storageRoot) {
      for (const e of unrooted) await setEpisodeStorageRoot(deps.db, e.id, summary.storageRoot);
    }
    summary.lessons = lessons.length;
    summary.autoTuned = await applyAutoTune(deps, agent, res.sliderSuggestions, now, log);
    log.info("reflection complete", { lessons: summary.lessons, storageRoot: summary.storageRoot, autoTuned: summary.autoTuned.length });
    return summary;
  } catch (err) {
    log.error("reflection failed", { error: err });
    return { ...summary, error: msg(err) };
  }
}
