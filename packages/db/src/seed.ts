// DEMO DATA ONLY. Run with: bun src/seed.ts
//
// Seeds 8 agents (all 5 templates, 2 of them forks), 4 human leaderboard entries, a few episodes,
// lessons, forks, one NORMAL risk state and matching stats. Every row is clearly fake:
//   - ids start with "demo-" (agents, episodes, lessons, forks, risk state)
//   - 0G request ids start with "demo-zg-"; Flash order ids start with "demo-flash-"
//   - display names start with "[demo]"
//   - owner and human addresses are sha256-derived, not real wallets
//   - tx hashes are sha256-derived placeholders that do not exist onchain, and no verified CRE report is seeded
//   - all agents run in "paper" mode
//
// Idempotent: re-running adds nothing new and does not change existing demo rows.
// Target: DATABASE_URL if set, otherwise PGLITE_DIR, otherwise <repo>/.pglite.

import { createHash } from "node:crypto";
import { RiskReason, type Episode, type StrategyConfig, type TemplateId } from "@arena/shared";
import {
  DEFAULT_PGLITE_DIR,
  closeDb,
  createDb,
  createAgent,
  getAgent,
  getEpisode,
  insertEpisode,
  insertFork,
  insertGuardrailBlock,
  insertLesson,
  insertRisk,
  leaderboard,
  migrate,
  upsertStats,
  upsertUser,
  type Db,
  type StatsInput,
} from "./index.ts";

/** Fixed demo clock so reruns produce identical rows. */
export const DEMO_BASE_TS = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;

const sha = (label: string) => createHash("sha256").update(`arena-demo:${label}`).digest("hex");
const demoAddress = (label: string): `0x${string}` => `0x${sha(label).slice(0, 40)}`;
const demoHash = (label: string): `0x${string}` => `0x${sha(label)}`;

const HUMANS = [
  { label: "human-ada", name: "[demo] Ada K.", optIn: true },
  { label: "human-bo", name: "[demo] Bo T.", optIn: true },
  { label: "human-chen", name: "[demo] Chen L.", optIn: true },
  { label: "human-dara", name: "[demo] Dara M.", optIn: true },
] as const;

const humanAddress = (i: number) => demoAddress(HUMANS[i]!.label);

function baseConfig(template: TemplateId, sliders: Record<string, number>, insightSources: StrategyConfig["insightSources"] = []): StrategyConfig {
  return {
    template,
    assets: ["WETH", "cbBTC"],
    sliders,
    limits: {
      maxTradeUsd: 1,
      maxOpenPositions: 2,
      maxAllocationUsd: 5,
      maxDailyLossUsd: 1,
      maxDrawdownPct: 15,
      cooldownSec: 900,
    },
    tickIntervalSec: 300,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: 1000,
    autoTune: { enabled: false, maxDeltaPct: 0 },
    publicCommentary: "delayed",
    insightSources,
    fork: { forkable: true, priceUsd: 2 },
  };
}

interface DemoAgent {
  id: string;
  name: string;
  template: TemplateId;
  owner: number;
  config: StrategyConfig;
  status?: "active" | "paused";
  forkOf?: string;
}

const AGENTS: DemoAgent[] = [
  {
    id: "demo-agent-momentum",
    name: "[demo] Momentum Alpha",
    template: "momentum",
    owner: 0,
    config: baseConfig("momentum", { lookback: 20, entryConfidenceMin: 0.6, sizePct: 0.2, tpPct: 3, slPct: 2, trailPct: 1 }),
  },
  {
    id: "demo-agent-mean-reversion",
    name: "[demo] Mean Reversion Bravo",
    template: "mean_reversion",
    owner: 1,
    config: baseConfig("mean_reversion", { rsiLow: 30, rsiHigh: 70, sizePct: 0.15, tpPct: 2.5, slPct: 1.5, maxHoldHours: 24 }),
  },
  {
    id: "demo-agent-breakout",
    name: "[demo] Breakout Charlie",
    template: "breakout",
    owner: 2,
    config: baseConfig("breakout", { rangeWindow: 48, breakoutPct: 0.5, sizePct: 0.25, tpPct: 4, slPct: 2 }),
  },
  {
    id: "demo-agent-smart-dca",
    name: "[demo] Smart DCA Delta",
    template: "smart_dca",
    owner: 0,
    config: baseConfig("smart_dca", { budgetUsd: 5, periodHours: 24, buckets: 6, dipMultiplierMax: 2, stopLossFloorPct: 10 }),
  },
  {
    id: "demo-agent-social",
    name: "[demo] Social Echo",
    template: "social_sentiment",
    owner: 3,
    config: baseConfig(
      "social_sentiment",
      { minSourceAgreement: 0.6, minConfidence: 0.55, sizePct: 0.1, tpPct: 3, slPct: 2 },
      [{ kind: "web_search" }],
    ),
  },
  {
    id: "demo-agent-momentum-fork",
    name: "[demo] Momentum Alpha (fork)",
    template: "momentum",
    owner: 1,
    config: baseConfig("momentum", { lookback: 20, entryConfidenceMin: 0.6, sizePct: 0.2, tpPct: 3, slPct: 2, trailPct: 1 }),
    forkOf: "demo-agent-momentum",
  },
  {
    id: "demo-agent-mean-reversion-fork",
    name: "[demo] Mean Reversion (fork)",
    template: "mean_reversion",
    owner: 3,
    config: baseConfig("mean_reversion", { rsiLow: 30, rsiHigh: 70, sizePct: 0.15, tpPct: 2.5, slPct: 1.5, maxHoldHours: 24 }),
    forkOf: "demo-agent-mean-reversion",
  },
  {
    id: "demo-agent-breakout-2",
    name: "[demo] Breakout Echo",
    template: "breakout",
    owner: 2,
    config: baseConfig("breakout", { rangeWindow: 24, breakoutPct: 0.8, sizePct: 0.1, tpPct: 3, slPct: 2 }),
    status: "paused",
  },
];

const agentIdx = (id: string) => AGENTS.findIndex((a) => a.id === id);

interface DemoStat {
  pnlUsd: number;
  pnlPct: number;
  volumeUsd: number;
  winRatePct: number;
  trades: number;
  forecastHitPct: number;
  daysActive: number;
  maxDrawdownBps: number;
  selfFunded: boolean;
}

function demoStat(
  entityId: string,
  kind: "agent" | "human",
  name: string,
  template: TemplateId | null,
  s: DemoStat,
): Omit<StatsInput, "updatedAt"> {
  return {
    entityId,
    kind,
    name,
    template,
    mode: "paper",
    realizedPnlUsd: s.pnlUsd,
    realizedPnlPct: s.pnlPct,
    volumeUsd: s.volumeUsd,
    trades: s.trades,
    winRateBps: Math.round(s.winRatePct * 100),
    maxDrawdownBps: s.maxDrawdownBps,
    forecastHitRateBps: Math.round(s.forecastHitPct * 100),
    daysActive: s.daysActive,
    verified: null,
    selfFunded: s.selfFunded,
  };
}

const STATS: Omit<StatsInput, "updatedAt">[] = [
  // Agents
  demoStat("demo-agent-momentum", "agent", "[demo] Momentum Alpha", "momentum", {
    pnlUsd: 4.82, pnlPct: 3.1, volumeUsd: 210, winRatePct: 58.1, trades: 620, forecastHitPct: 61.5, daysActive: 8, maxDrawdownBps: 420, selfFunded: false,
  }),
  demoStat("demo-agent-mean-reversion", "agent", "[demo] Mean Reversion Bravo", "mean_reversion", {
    pnlUsd: 2.37, pnlPct: 1.6, volumeUsd: 150, winRatePct: 55.3, trades: 480, forecastHitPct: 58.0, daysActive: 10, maxDrawdownBps: 310, selfFunded: true,
  }),
  demoStat("demo-agent-breakout", "agent", "[demo] Breakout Charlie", "breakout", {
    pnlUsd: -0.91, pnlPct: -0.6, volumeUsd: 96, winRatePct: 41.7, trades: 1040, forecastHitPct: 47.2, daysActive: 5, maxDrawdownBps: 880, selfFunded: false,
  }),
  demoStat("demo-agent-smart-dca", "agent", "[demo] Smart DCA Delta", "smart_dca", {
    pnlUsd: 1.12, pnlPct: 0.7, volumeUsd: 180, winRatePct: 60.0, trades: 390, forecastHitPct: 53.1, daysActive: 12, maxDrawdownBps: 150, selfFunded: true,
  }),
  demoStat("demo-agent-social", "agent", "[demo] Social Echo", "social_sentiment", {
    pnlUsd: 0.44, pnlPct: 0.3, volumeUsd: 70, winRatePct: 52.9, trades: 510, forecastHitPct: 50.8, daysActive: 3, maxDrawdownBps: 260, selfFunded: false,
  }),
  demoStat("demo-agent-momentum-fork", "agent", "[demo] Momentum Alpha (fork)", "momentum", {
    pnlUsd: 1.9, pnlPct: 1.2, volumeUsd: 80, winRatePct: 56.0, trades: 300, forecastHitPct: 57.4, daysActive: 4, maxDrawdownBps: 330, selfFunded: false,
  }),
  demoStat("demo-agent-mean-reversion-fork", "agent", "[demo] Mean Reversion (fork)", "mean_reversion", {
    pnlUsd: -0.22, pnlPct: -0.1, volumeUsd: 40, winRatePct: 48.0, trades: 260, forecastHitPct: 49.5, daysActive: 2, maxDrawdownBps: 90, selfFunded: false,
  }),
  demoStat("demo-agent-breakout-2", "agent", "[demo] Breakout Echo", "breakout", {
    pnlUsd: 0.15, pnlPct: 0.1, volumeUsd: 25, winRatePct: 50.0, trades: 210, forecastHitPct: 52.0, daysActive: 1, maxDrawdownBps: 60, selfFunded: false,
  }),
  // Humans (manual terminal, opted in to the Humans board)
  demoStat(humanAddress(0), "human", "[demo] Ada K.", null, {
    pnlUsd: 6.35, pnlPct: 4.2, volumeUsd: 430, winRatePct: 63.2, trades: 880, forecastHitPct: 66.0, daysActive: 21, maxDrawdownBps: 500, selfFunded: false,
  }),
  demoStat(humanAddress(1), "human", "[demo] Bo T.", null, {
    pnlUsd: 1.74, pnlPct: 1.1, volumeUsd: 260, winRatePct: 54.0, trades: 530, forecastHitPct: 55.5, daysActive: 9, maxDrawdownBps: 360, selfFunded: false,
  }),
  demoStat(humanAddress(2), "human", "[demo] Chen L.", null, {
    pnlUsd: -2.03, pnlPct: -1.4, volumeUsd: 310, winRatePct: 44.4, trades: 1370, forecastHitPct: 46.0, daysActive: 14, maxDrawdownBps: 1150, selfFunded: false,
  }),
  demoStat(humanAddress(3), "human", "[demo] Dara M.", null, {
    pnlUsd: 0.62, pnlPct: 0.4, volumeUsd: 90, winRatePct: 51.1, trades: 240, forecastHitPct: 50.0, daysActive: 4, maxDrawdownBps: 200, selfFunded: false,
  }),
];

function indicators(price: number) {
  return {
    emaFast: price * 0.998,
    emaSlow: price * 0.99,
    rsi14: 54.2,
    atr14: price * 0.012,
    rocPct: 1.4,
    rangeHigh: price * 1.02,
    rangeLow: price * 0.97,
    volatilityPct: 2.1,
  };
}

function demoEpisodes(): Episode[] {
  const out: Episode[] = [];
  const forAgents = ["demo-agent-momentum", "demo-agent-mean-reversion", "demo-agent-social"];
  forAgents.forEach((agentId, a) => {
    for (let n = 0; n < 2; n++) {
      const id = `demo-episode-${a}-${n}`;
      const ts = DEMO_BASE_TS - (a * 2 + n) * HOUR;
      const requestId = `demo-zg-req-${a}-${n}`;
      const rejected = n === 1;
      const flashOrderId = `demo-flash-order-${a}-${n}`;
      out.push({
        id,
        agentId,
        ts,
        riskLevel: "NORMAL",
        budgetTier: "healthy",
        market: [
          { asset: "WETH", priceUsd: 3150.2, indicators: indicators(3150.2) },
          { asset: "cbBTC", priceUsd: 97120.5, indicators: indicators(97120.5) },
        ],
        decision: {
          forecast: { asset: "WETH", horizonMin: 60, direction: rejected ? "down" : "up", expectedMovePct: 0.8, confidence: 0.64 },
          proposal: {
            action: "buy",
            asset: "WETH",
            orderType: "limit",
            sizePct: rejected ? 0.9 : 0.2,
            limitPrice: 3148,
            takeProfitPct: 0.03,
            stopLossPct: 0.02,
            rationale: "[demo] Synthetic rationale for seeded data.",
          },
        },
        inference: {
          requestId,
          model: "demo-strong-model",
          provider: "demo-0g-provider",
          billing: "1200000",
          teeVerified: true,
          latencyMs: 812,
          payer: "agent",
        },
        verdict: rejected
          ? { kind: "reject", reasons: ["size 90% exceeds template max 20%", "daily loss limit reached"] }
          : {
              kind: "approve",
              order: {
                side: "buy",
                asset: "WETH",
                quoteAsset: "USDC",
                orderType: "limit",
                notionalUsd: 0.8,
                limitPrice: 3148,
                attachedBracket: { takeProfitPrice: 3240, stopLossPrice: 3086 },
              },
            },
        flashOrderIds: rejected ? [] : [flashOrderId],
        zgStorageRoot: null,
        error: null,
      });
    }
  });
  return out;
}

export interface SeedSummary {
  humans: number;
  agents: number;
  forks: number;
  episodes: number;
  lessons: number;
  riskStates: number;
  statsRows: number;
  leaderboardTop: string[];
}

/** Seeds the demo dataset. Safe to call repeatedly. */
export async function seedDemo(db: Db): Promise<SeedSummary> {
  for (const [i, h] of HUMANS.entries()) {
    await upsertUser(db, {
      address: humanAddress(i),
      displayName: h.name,
      humansBoardOptIn: h.optIn,
      createdAt: DEMO_BASE_TS,
    });
  }

  // Source agents first, then forks (forks reference both).
  const ordered = [...AGENTS.filter((a) => !a.forkOf), ...AGENTS.filter((a) => a.forkOf)];
  for (const a of ordered) {
    if (await getAgent(db, a.id)) continue;
    const created = await createAgent(db, {
      id: a.id,
      name: a.name,
      ownerAddress: humanAddress(a.owner),
      tradingWallet: demoAddress(`${a.id}:trading`),
      zgWallet: demoAddress(`${a.id}:zg`),
      config: a.config,
      configHash: demoHash(`${a.id}:config:v1`),
      mode: "paper",
      status: a.status ?? "active",
      forkedFrom: a.forkOf ?? null,
      createdAt: DEMO_BASE_TS - (AGENTS.length - agentIdx(a.id)) * 24 * HOUR,
    });
    if (a.forkOf) {
      const source = AGENTS.find((s) => s.id === a.forkOf)!;
      await insertFork(db, {
        agentId: a.forkOf,
        buyer: humanAddress(a.owner),
        priceUsd: source.config.fork.priceUsd,
        txHash: demoHash(`fork:${a.id}`),
        configHash: created.configHash,
        newAgentId: a.id,
        createdAt: DEMO_BASE_TS - 2 * 24 * HOUR,
      });
    }
  }

  const episodes = demoEpisodes();
  for (const ep of episodes) {
    await insertEpisode(db, ep);
    if (ep.verdict.kind === "reject") {
      await insertGuardrailBlock(db, {
        id: `demo-block-${ep.id}`,
        agentId: ep.agentId,
        episodeId: ep.id,
        reasons: ep.verdict.reasons,
        ts: ep.ts,
      });
    }
  }

  const lessons = [
    {
      id: "demo-lesson-momentum-1",
      agentId: "demo-agent-momentum",
      ts: DEMO_BASE_TS - 6 * HOUR,
      lesson: "[demo] Entries after RSI above 65 underperformed; wait for a pullback to EMA fast.",
      evidenceEpisodeIds: ["demo-episode-0-0", "demo-episode-0-1"],
      confidence: 0.7,
      appliesTo: ["WETH"],
      zgStorageRoot: null,
    },
    {
      id: "demo-lesson-momentum-2",
      agentId: "demo-agent-momentum",
      ts: DEMO_BASE_TS - 5 * HOUR,
      lesson: "[demo] Trailing stops at 1% gave back gains on choppy days; prefer 1.5% in low volatility.",
      evidenceEpisodeIds: ["demo-episode-0-1"],
      confidence: 0.55,
      appliesTo: ["WETH", "cbBTC"],
      zgStorageRoot: null,
    },
  ];
  for (const l of lessons) await insertLesson(db, l);

  await insertRisk(db, {
    id: "demo-risk-normal",
    level: "NORMAL",
    reasonCode: RiskReason.None,
    asOf: DEMO_BASE_TS,
    txHash: null,
  });

  await upsertStats(
    db,
    STATS.map((s) => ({ ...s, updatedAt: DEMO_BASE_TS })),
  );

  const top = await leaderboard(db, { limit: 3 });
  return {
    humans: HUMANS.length,
    agents: AGENTS.length,
    forks: AGENTS.filter((a) => a.forkOf).length,
    episodes: episodes.length,
    lessons: lessons.length,
    riskStates: 1,
    statsRows: STATS.length,
    leaderboardTop: top.map((r) => `${r.name} (${r.realizedPnlUsd >= 0 ? "+" : ""}${r.realizedPnlUsd} USD)`),
  };
}

if (import.meta.main) {
  const target = process.env.DATABASE_URL ? "DATABASE_URL" : process.env.PGLITE_DIR || DEFAULT_PGLITE_DIR;
  const db = createDb();
  try {
    await migrate(db);
    const summary = await seedDemo(db);
    console.log(`[demo] ensured demo dataset in ${target} (idempotent)`);
    console.log(
      `[demo] humans=${summary.humans} agents=${summary.agents} forks=${summary.forks} episodes=${summary.episodes} ` +
        `lessons=${summary.lessons} risk_states=${summary.riskStates} stats_rows=${summary.statsRows}`,
    );
    console.log(`[demo] top 3: ${summary.leaderboardTop.join(" | ")}`);
  } finally {
    await closeDb(db);
  }
}
