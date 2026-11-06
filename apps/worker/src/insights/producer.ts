// Insight producer (PRD 6.8). For each agent with insight sources it collects items (RSS, delayed commentary),
// keeps those that mention the agent's assets, stores them, and digests them into a stance per asset.
//   - runCycle: every 15 min, for every active agent. The RSS feeds are fetched once for the whole cycle.
//   - refreshIfStale: called by the tick. Refreshes the digest when it is older than 30 min.
// Agents with a low, critical or empty budget tier are skipped (PRD 6.11.6). The digest uses the agent's own 0G
// key when it has one (payer "agent"), and the platform key otherwise.

import {
  insertInference,
  insertInsightDigest,
  insertInsightItems,
  latestInsightDigest,
  type Db,
  type InsightItemInput,
} from "@arena/db";
import type { Agent, BudgetTier } from "@arena/shared";
import { digestInsights, InsufficientBalanceError, type AssetInsight, type ZeroGRouter } from "@arena/zerog";
import type { BudgetSource, Clock, InsightRefresher } from "../deps.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { assetsMentioned, collectAgentCommentary, RssCollector, stableId, type CollectedItem, type FeedEntry } from "./sources.ts";

export const DIGEST_MAX_AGE_MS = 30 * 60_000;
export const INSIGHT_CYCLE_MS = 15 * 60_000;
/** The most items sent to one digest. The newest matching items are kept. */
export const MAX_DIGEST_ITEMS = 25;
/** Budget tiers that do not buy digests. A healthy agent is the only one that spends on insights (PRD 6.11.6). */
const PAUSED_TIERS: ReadonlySet<BudgetTier> = new Set<BudgetTier>(["low", "critical", "empty"]);

export type DigestFn = typeof digestInsights;

export interface InsightProducerOptions {
  db: Db;
  clock: Clock;
  logger?: Logger;
  budget: BudgetSource;
  /** The agent's router: its own 0G key when one is stored (payer "agent"), else the platform router. */
  agentRouterFor(agent: Agent): Promise<ZeroGRouter>;
  rss: RssCollector;
  /** Defaults to digestInsights. Tests inject a fake. */
  digest?: DigestFn;
}

export type InsightOutcome = "stored" | "no_sources" | "no_items" | "budget_skipped" | "failed";

export interface InsightRun {
  agentId: string;
  outcome: InsightOutcome;
  reason: string | null;
  /** Item rows stored for this agent (one per item and matched asset). */
  itemsStored: number;
  /**
   * The digest when outcome is "stored". sourceIds are the stored item ids (without the asset suffix).
   * perAsset is empty when the model named no known asset.
   */
  digest: { perAsset: Record<string, AssetInsight>; summary: string; zgRequestId: string | null; ts: number } | null;
}

export interface InsightProducer extends InsightRefresher {
  /** One cycle for one agent, ignoring the digest's age. Never throws. */
  produce(agent: Agent, opts?: { feeds?: Map<string, FeedEntry[]> }): Promise<InsightRun>;
  /** One cycle for every active agent with insight sources. Each RSS feed is fetched once. Never throws. */
  runCycle(agents: Agent[]): Promise<InsightRun[]>;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function rssUrlsOf(agent: Agent): string[] {
  return agent.config.insightSources.flatMap((s) => (s.kind === "rss" ? [s.url] : []));
}

export function createInsightProducer(opts: InsightProducerOptions): InsightProducer {
  const logger = opts.logger ?? silentLogger;
  const digestFn: DigestFn = opts.digest ?? digestInsights;
  const { db, clock } = opts;
  /** Last digest attempt per agent (unix ms). Stops a failing agent from calling 0G on every tick. */
  const lastAttempt = new Map<string, number>();

  /** Items from every source of this agent that mention one of its assets. Newest first, at most MAX_DIGEST_ITEMS. */
  async function collectItems(agent: Agent, feeds?: Map<string, FeedEntry[]>): Promise<CollectedItem[]> {
    const urls = rssUrlsOf(agent);
    const feedMap = feeds ?? (urls.length > 0 ? await opts.rss.collect(urls) : new Map<string, FeedEntry[]>());
    const candidates: CollectedItem[] = [];
    for (const url of new Set(urls)) {
      for (const entry of feedMap.get(url) ?? []) {
        candidates.push({
          id: `rss:${stableId(url, entry.key)}`,
          source: hostOf(url),
          title: entry.title,
          text: entry.text,
          url: entry.url,
          ts: entry.ts,
          sourceKind: "rss",
          sourceRef: url,
        });
      }
    }
    const agentSourceIds = agent.config.insightSources.flatMap((s) => (s.kind === "agent" ? [s.agentId] : []));
    candidates.push(...(await collectAgentCommentary({ db, clock, logger }, agentSourceIds, agent.id)));

    const byId = new Map<string, CollectedItem>();
    for (const c of candidates) {
      if (!byId.has(c.id) && assetsMentioned(`${c.title} ${c.text}`, agent.config.assets).length > 0) byId.set(c.id, c);
    }
    return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_DIGEST_ITEMS);
  }

  /** One row per item and matched asset. The row id is the item id plus the asset, so re-running is idempotent. */
  function itemRows(items: CollectedItem[], assets: string[]): InsightItemInput[] {
    return items.flatMap((item) =>
      assetsMentioned(`${item.title} ${item.text}`, assets).map((asset) => ({
        id: `${item.id}:${asset}`,
        sourceKind: item.sourceKind,
        sourceRef: item.sourceRef,
        asset,
        body: `${item.title}. ${item.text}`.slice(0, 2000),
        url: item.url ?? null,
        ts: item.ts,
        raw: { source: item.source, title: item.title },
      })),
    );
  }

  async function produce(agent: Agent, produceOpts: { feeds?: Map<string, FeedEntry[]> } = {}): Promise<InsightRun> {
    const run = (outcome: InsightOutcome, reason: string | null, itemsStored = 0, digest: InsightRun["digest"] = null): InsightRun => ({
      agentId: agent.id,
      outcome,
      reason,
      itemsStored,
      digest,
    });
    if (agent.config.insightSources.length === 0) return run("no_sources", "no insight sources configured");

    const log = logger.child({ agent: agent.id });
    lastAttempt.set(agent.id, clock.now());
    try {
      const budget = await opts.budget.forAgent(agent);
      if (PAUSED_TIERS.has(budget.tier)) {
        log.info("insight digest skipped: budget tier", { tier: budget.tier, source: budget.source });
        return run("budget_skipped", `budget tier ${budget.tier}`);
      }

      const items = await collectItems(agent, produceOpts.feeds);
      const useWebSearch = agent.config.insightSources.some((s) => s.kind === "web_search");
      if (items.length === 0 && !useWebSearch) {
        log.info("insight digest skipped: no items mention the agent's assets");
        return run("no_items", "no items mention this agent's assets");
      }

      const rows = itemRows(items, agent.config.assets);
      await insertInsightItems(db, rows);

      const router = await opts.agentRouterFor(agent);
      const now = clock.now();
      const res = await digestFn(router, { assets: agent.config.assets, items, useWebSearch });

      const traces = res.traces.length > 0 ? res.traces : [res.trace];
      for (const trace of traces) {
        await insertInference(db, trace, { agentId: agent.id, purpose: "digest", ts: now });
      }
      if (res.error) {
        log.warn("insight digest rejected", { error: res.error, zgRequestId: res.trace.requestId });
        return run("failed", res.error, rows.length);
      }

      // digestInsights names items "item-N" by their position in `items`. Map them back to stored item ids.
      const itemIdFor = new Map(items.map((item, i) => [`item-${i + 1}`, item.id]));
      const zgRequestId = res.trace.requestId || null;
      const perAsset: Record<string, AssetInsight> = {};
      for (const [asset, insight] of Object.entries(res.perAsset)) {
        const sourceIds = insight.sourceIds.map((id) => itemIdFor.get(id) ?? id);
        perAsset[asset] = { stance: insight.stance, confidence: insight.confidence, sourceIds };
        await insertInsightDigest(db, {
          agentId: agent.id,
          asset,
          stance: insight.stance,
          confidence: insight.confidence,
          sourceIds,
          zgRequestId,
          ts: now,
        });
      }
      log.info("insight digest stored", { items: items.length, assets: Object.keys(perAsset), zgRequestId });
      return run("stored", null, rows.length, { perAsset, summary: res.summary, zgRequestId, ts: now });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        opts.budget.markCritical(agent.id, "0G 402 (insights)");
        log.warn("0G insufficient balance during insight digest: budget set to critical", { requestId: err.requestId ?? undefined });
      } else {
        log.error("insight cycle failed", { error: err });
      }
      return run("failed", msg(err));
    }
  }

  return {
    produce,

    async runCycle(agents: Agent[]): Promise<InsightRun[]> {
      const eligible = agents.filter((a) => a.status === "active" && a.config.insightSources.length > 0);
      const urls = [...new Set(eligible.flatMap(rssUrlsOf))];
      const feeds = urls.length > 0 ? await opts.rss.collect(urls) : new Map<string, FeedEntry[]>();
      const runs: InsightRun[] = [];
      for (const agent of eligible) runs.push(await produce(agent, { feeds }));
      return runs;
    },

    async refreshIfStale(agent: Agent): Promise<void> {
      if (agent.config.insightSources.length === 0) return;
      const latest = await latestInsightDigest(db, agent.id);
      const last = Math.max(lastAttempt.get(agent.id) ?? 0, latest?.ts ?? 0);
      if (clock.now() - last < DIGEST_MAX_AGE_MS) return;
      await produce(agent);
    },
  };
}
