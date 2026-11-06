// Mock data for local development and demos without DATABASE_URL. Deterministic and shaped like the
// @arena/shared types. Server-only. Used as the fallback inside lib/data.ts; pages never import this file.
import { RiskReason } from "@arena/shared";
import type {
  Agent,
  AgentStatus,
  BudgetTier,
  DecisionOutput,
  Episode,
  ExecutionMode,
  FlashOrderType,
  Forecast,
  Indicators,
  InferenceTrace,
  InsightSource,
  Lesson,
  OrderIntent,
  PerformanceStats,
  PolicyVerdict,
  Proposal,
  StrategyConfig,
  TemplateId,
} from "@arena/shared";
import { DEMO_OWNER, TEMPLATES, defaultStrategy, type TemplateDef, type Timeframe } from "@/lib/templates";
import type {
  AgentRuntimeState,
  AgentTreasury,
  EquityPoint,
  Fill,
  HumansPrefs,
  LeaderboardQuery,
  OwnedAgent,
  PaperLedgerEntry,
  PaperLedgerView,
  RiskStatus,
  TopUp,
  TradingActivity,
  ZgBudget,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Deterministic mock helpers.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESERVE_DAYS = 3;
const DAILY_0G_CAP_USD = 1;
const AVG_TRADE_USD = 0.9;
const ZG_PRICE_MOCK_USD = 0.42;
const EPISODE_COUNT = 24;

const ASSET_BASE: Record<string, { price: number; volume: number }> = {
  WETH: { price: 3412.8, volume: 900 },
  cbBTC: { price: 104_250, volume: 40 },
};

const TF: Record<Timeframe, { pnl: number; vol: number; trades: number; days: number }> = {
  "24h": { pnl: 0.07, vol: 0.05, trades: 0.12, days: 1 },
  "7d": { pnl: 0.3, vol: 0.22, trades: 0.4, days: 7 },
  "30d": { pnl: 0.75, vol: 0.7, trades: 0.75, days: 30 },
  all: { pnl: 1, vol: 1, trades: 1, days: Number.POSITIVE_INFINITY },
};

const ENTRY_TYPE: Record<TemplateId, FlashOrderType> = {
  momentum: "limit",
  mean_reversion: "limit",
  breakout: "stop",
  smart_dca: "twap",
  social_sentiment: "limit",
};

const MODEL_BY_TIER = {
  strong: "0g-strong-json",
  balanced: "0g-balanced-json",
  economical: "0gm-1.0",
} as const;

const RATIONALES = [
  "EMA fast above slow with RSI 58; momentum confirmed by forecast.",
  "Price tagged lower band with RSI 29; regime check passed.",
  "Close above 48-bar range high with volume expansion.",
  "Scheduled tranche; dip multiplier 1.3x after -1.8% move.",
  "Insight digest 4/5 sources bullish, confidence 0.71.",
  "Trail stop tightened after forecast weakened to flat.",
  "No edge: forecast confidence 0.52 below template minimum.",
];

const REJECT_REASONS = [
  "RiskOracle CAUTION: breakout entries blocked",
  "cooldown active: 212s since last trade, need 600s",
  "daily loss cap reached for today",
  "stop-loss missing or outside bounds",
  "asset not allowed by template",
];

const LESSON_POOL = [
  "Breakouts on low volume failed 3 times; require higher volume before entry.",
  "Take-profit at +3% hit more often than +5% in the last 48h; keep TP tighter.",
  "Forecasts with confidence below 0.6 were wrong 7 of 9 times; skip them.",
  "Stop-losses at -2% fired on wicks; widen to ATR-based stops.",
  "Trend entries after RSI above 70 underperformed; wait for a pullback.",
  "Mark price diverged from Flash quote on thin books; use limit entries.",
  "A 10-minute cooldown cut churn without hurting hit rate.",
];
const LESSON_APPLIES: string[][] = [["entry", "volume"], ["stops"], ["forecast", "cooldown"], ["entry"]];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexOf(r: () => number, bytes: number): `0x${string}` {
  let out = "";
  for (let i = 0; i < bytes; i++) out += Math.floor(r() * 256).toString(16).padStart(2, "0");
  return `0x${out}`;
}

function addrOf(seed: string): `0x${string}` {
  return hexOf(rng(hashStr(seed)), 20);
}

function hashOf(seed: string): `0x${string}` {
  return hexOf(rng(hashStr(seed)), 32);
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(r() * xs.length)];
  if (x === undefined) throw new Error("pick() from empty list");
  return x;
}

function round(n: number, digits = 2): number {
  return Math.round(n * 10 ** digits) / 10 ** digits;
}

// ---------------------------------------------------------------------------
// Seeds: the "world". Stats are all-time; timeframes scale them.
// ---------------------------------------------------------------------------

interface Seed {
  id: string;
  kind: "agent" | "human";
  name: string;
  template: TemplateId | null;
  mode: ExecutionMode;
  allocationUsd: number;
  /** All-time realized PnL, percent points. */
  pnlPct: number;
  winRateBps: number;
  /** All-time max drawdown, percent points. */
  ddPct: number;
  hitBps: number;
  trades: number;
  daysActive: number;
  forks: number;
  verified: boolean;
  selfFunded: boolean;
}

interface AgentSeed extends Seed {
  kind: "agent";
  template: TemplateId;
  status: AgentStatus;
  owner: "demo" | "other";
  assets: string[];
  forkable: boolean;
  forkPriceUsd: number;
  forkedFrom?: string;
}

const AGENT_SEEDS: AgentSeed[] = [
  { id: "ag_momentum_mike", kind: "agent", name: "Momentum Mike", template: "momentum", status: "active", mode: "live", allocationUsd: 5, pnlPct: 6.4, winRateBps: 5800, ddPct: 3.1, hitBps: 6100, trades: 58, daysActive: 21, forks: 14, verified: true, selfFunded: true, owner: "demo", assets: ["WETH"], forkable: true, forkPriceUsd: 4 },
  { id: "ag_reversion_rae", kind: "agent", name: "Reversion Rae", template: "mean_reversion", status: "active", mode: "live", allocationUsd: 5, pnlPct: 4.1, winRateBps: 6200, ddPct: 2.4, hitBps: 5600, trades: 34, daysActive: 18, forks: 6, verified: true, selfFunded: false, owner: "other", assets: ["WETH", "cbBTC"], forkable: true, forkPriceUsd: 3 },
  { id: "ag_breakout_bea", kind: "agent", name: "Breakout Bea", template: "breakout", status: "active", mode: "live", allocationUsd: 5, pnlPct: -1.2, winRateBps: 4100, ddPct: 6.8, hitBps: 4800, trades: 22, daysActive: 12, forks: 1, verified: true, selfFunded: false, owner: "demo", assets: ["cbBTC"], forkable: false, forkPriceUsd: 0 },
  { id: "ag_dca_dan", kind: "agent", name: "DCA Dan", template: "smart_dca", status: "active", mode: "live", allocationUsd: 5, pnlPct: 2.7, winRateBps: 6800, ddPct: 1.2, hitBps: 6400, trades: 40, daysActive: 25, forks: 9, verified: true, selfFunded: true, owner: "demo", assets: ["WETH", "cbBTC"], forkable: true, forkPriceUsd: 2 },
  { id: "ag_sentiment_sam", kind: "agent", name: "Sentiment Sam", template: "social_sentiment", status: "paused", mode: "paper", allocationUsd: 3, pnlPct: 0.9, winRateBps: 5300, ddPct: 4.4, hitBps: 5100, trades: 19, daysActive: 7, forks: 0, verified: false, selfFunded: false, owner: "demo", assets: ["WETH"], forkable: false, forkPriceUsd: 0 },
  { id: "ag_trend_tara", kind: "agent", name: "Trend Tara", template: "momentum", status: "active", mode: "live", allocationUsd: 5, pnlPct: 9.8, winRateBps: 6000, ddPct: 5.2, hitBps: 5900, trades: 71, daysActive: 27, forks: 22, verified: true, selfFunded: true, owner: "other", assets: ["WETH"], forkable: true, forkPriceUsd: 6 },
  { id: "ag_band_bender", kind: "agent", name: "Band Bender", template: "mean_reversion", status: "stopped", mode: "paper", allocationUsd: 4, pnlPct: -0.6, winRateBps: 4700, ddPct: 3.6, hitBps: 4900, trades: 16, daysActive: 9, forks: 0, verified: false, selfFunded: false, owner: "other", assets: ["WETH"], forkable: false, forkPriceUsd: 0 },
  { id: "ag_range_riot", kind: "agent", name: "Range Riot", template: "breakout", status: "active", mode: "live", allocationUsd: 5, pnlPct: 3.3, winRateBps: 5500, ddPct: 2.9, hitBps: 5300, trades: 29, daysActive: 15, forks: 3, verified: true, selfFunded: false, owner: "other", assets: ["WETH", "cbBTC"], forkable: true, forkPriceUsd: 3, forkedFrom: "ag_breakout_bea" },
  { id: "ag_steady_stacker", kind: "agent", name: "Steady Stacker", template: "smart_dca", status: "active", mode: "live", allocationUsd: 5, pnlPct: 5.5, winRateBps: 7100, ddPct: 1.8, hitBps: 6700, trades: 48, daysActive: 30, forks: 11, verified: true, selfFunded: true, owner: "other", assets: ["cbBTC"], forkable: true, forkPriceUsd: 2.5 },
  { id: "ag_news_nose", kind: "agent", name: "News Nose", template: "social_sentiment", status: "active", mode: "paper", allocationUsd: 3, pnlPct: 1.4, winRateBps: 5000, ddPct: 3.9, hitBps: 5600, trades: 26, daysActive: 10, forks: 1, verified: false, selfFunded: false, owner: "other", assets: ["WETH", "cbBTC"], forkable: true, forkPriceUsd: 1 },
  { id: "ag_ema_ember", kind: "agent", name: "Ema Ember", template: "momentum", status: "active", mode: "paper", allocationUsd: 3, pnlPct: -2.1, winRateBps: 4300, ddPct: 7.4, hitBps: 4400, trades: 44, daysActive: 14, forks: 0, verified: false, selfFunded: false, owner: "other", assets: ["WETH"], forkable: false, forkPriceUsd: 0, forkedFrom: "ag_momentum_mike" },
  { id: "ag_rsi_ryder", kind: "agent", name: "RSI Ryder", template: "mean_reversion", status: "active", mode: "live", allocationUsd: 5, pnlPct: 7.6, winRateBps: 6300, ddPct: 2.2, hitBps: 5800, trades: 38, daysActive: 20, forks: 5, verified: true, selfFunded: false, owner: "other", assets: ["cbBTC"], forkable: true, forkPriceUsd: 4 },
  { id: "ag_wick_hunter", kind: "agent", name: "Wick Hunter", template: "breakout", status: "active", mode: "live", allocationUsd: 4, pnlPct: 1.8, winRateBps: 5200, ddPct: 5.9, hitBps: 5000, trades: 31, daysActive: 11, forks: 2, verified: true, selfFunded: false, owner: "other", assets: ["WETH"], forkable: true, forkPriceUsd: 2 },
  { id: "ag_cost_averager", kind: "agent", name: "Cost Averager", template: "smart_dca", status: "paused", mode: "live", allocationUsd: 5, pnlPct: 0.4, winRateBps: 6500, ddPct: 0.9, hitBps: 6000, trades: 52, daysActive: 28, forks: 4, verified: true, selfFunded: true, owner: "other", assets: ["WETH", "cbBTC"], forkable: true, forkPriceUsd: 1.5, forkedFrom: "ag_dca_dan" },
  { id: "ag_feed_whisperer", kind: "agent", name: "Feed Whisperer", template: "social_sentiment", status: "active", mode: "live", allocationUsd: 5, pnlPct: 4.9, winRateBps: 5600, ddPct: 3, hitBps: 5500, trades: 33, daysActive: 17, forks: 8, verified: true, selfFunded: false, owner: "other", assets: ["cbBTC"], forkable: true, forkPriceUsd: 5 },
];

interface HumanSeedInput {
  handle: string;
  address?: `0x${string}`;
  allocationUsd: number;
  pnlPct: number;
  winRateBps: number;
  ddPct: number;
  trades: number;
  daysActive: number;
  mode: ExecutionMode;
  verified: boolean;
}

function humanSeed(h: HumanSeedInput): Seed {
  return {
    id: h.address ?? addrOf(`human:${h.handle}`),
    kind: "human",
    name: h.handle,
    template: null,
    mode: h.mode,
    allocationUsd: h.allocationUsd,
    pnlPct: h.pnlPct,
    winRateBps: h.winRateBps,
    ddPct: h.ddPct,
    hitBps: 0,
    trades: h.trades,
    daysActive: h.daysActive,
    forks: 0,
    verified: h.verified,
    selfFunded: false,
  };
}

const HUMAN_SEEDS: Seed[] = [
  humanSeed({ handle: "wolf_desk", allocationUsd: 5, pnlPct: 8.2, winRateBps: 6100, ddPct: 4, trades: 41, daysActive: 30, mode: "live", verified: true }),
  humanSeed({ handle: "candle_kai", allocationUsd: 5, pnlPct: 3.4, winRateBps: 5400, ddPct: 2.2, trades: 22, daysActive: 14, mode: "live", verified: true }),
  humanSeed({ handle: "lp_lars", allocationUsd: 4, pnlPct: -1.9, winRateBps: 4700, ddPct: 6.1, trades: 15, daysActive: 9, mode: "paper", verified: false }),
  humanSeed({ handle: "mara_t", allocationUsd: 5, pnlPct: 11.2, winRateBps: 6400, ddPct: 3.3, trades: 37, daysActive: 26, mode: "live", verified: true }),
  humanSeed({ handle: "nightfill", allocationUsd: 3, pnlPct: 0.6, winRateBps: 5000, ddPct: 1, trades: 9, daysActive: 5, mode: "paper", verified: false }),
  humanSeed({ handle: "tapewatch", allocationUsd: 5, pnlPct: 5.8, winRateBps: 5800, ddPct: 2.6, trades: 28, daysActive: 19, mode: "live", verified: true }),
  humanSeed({ handle: "basebro", allocationUsd: 4, pnlPct: -0.8, winRateBps: 4600, ddPct: 5.5, trades: 12, daysActive: 6, mode: "live", verified: false }),
  humanSeed({ handle: "arena_demo", address: DEMO_OWNER, allocationUsd: 5, pnlPct: 2.2, winRateBps: 5500, ddPct: 1.8, trades: 14, daysActive: 12, mode: "live", verified: false }),
];

const ENTITY_SEEDS: Seed[] = [...AGENT_SEEDS, ...HUMAN_SEEDS];

/** Agents created through POST /api/agents this process lifetime. */
const CREATED = new Map<string, { agent: Agent; allocationUsd: number }>();

/** Owner status changes (pause/resume) made this process lifetime, keyed by agent id. */
const STATUS_OVERRIDE = new Map<string, AgentStatus>();

/** Mock users' Humans-board opt-in, keyed by lowercase address. */
const HUMANS_OPT_IN = new Map<string, boolean>();

function insightSourcesFor(s: AgentSeed): InsightSource[] {
  if (s.template === "social_sentiment") {
    return [{ kind: "web_search" }, { kind: "rss", url: "https://example.com/crypto-news.xml" }];
  }
  if (s.id === "ag_steady_stacker") return [{ kind: "agent", agentId: "ag_trend_tara" }];
  return [];
}

function agentFromSeed(s: AgentSeed, now: number): Agent {
  const r = rng(hashStr(`${s.id}:agent`));
  const config: StrategyConfig = {
    ...defaultStrategy(s.template),
    assets: s.assets,
    limits: {
      maxTradeUsd: 1,
      maxOpenPositions: 2,
      maxAllocationUsd: s.allocationUsd,
      maxDailyLossUsd: 1,
      maxDrawdownPct: 20,
      cooldownSec: 600,
    },
    modelTier: pick(r, ["strong", "balanced", "balanced", "economical"] as const),
    crashMode: pick(r, ["tighten_stops", "flatten"] as const),
    autoTune: { enabled: r() > 0.5, maxDeltaPct: 10 },
    publicCommentary: r() > 0.5 ? "delayed" : "off",
    insightSources: insightSourcesFor(s),
    fork: { forkable: s.forkable, priceUsd: s.forkPriceUsd },
  };
  return {
    id: s.id,
    name: s.name,
    ownerAddress: s.owner === "demo" ? DEMO_OWNER : addrOf(`${s.id}:owner`),
    tradingWallet: addrOf(`${s.id}:wallet`),
    zgWallet: s.selfFunded || r() > 0.4 ? addrOf(`${s.id}:zg-wallet`) : null,
    config,
    configVersion: 1 + Math.floor(r() * 3),
    configHash: hashOf(`${s.id}:config`),
    status: STATUS_OVERRIDE.get(s.id) ?? s.status,
    mode: s.mode,
    forkedFrom: s.forkedFrom ?? null,
    createdAt: now - s.daysActive * DAY,
  };
}

function statsFor(s: Seed, tf: Timeframe, now: number): PerformanceStats {
  const f = TF[tf];
  const trades = Math.round(s.trades * f.trades);
  const pnlPct = s.pnlPct * f.pnl;
  return {
    entityId: s.id,
    kind: s.kind,
    name: s.name,
    template: s.template,
    realizedPnlUsd: round((s.allocationUsd * pnlPct) / 100, 2),
    realizedPnlPct: round(pnlPct, 2),
    volumeUsd: round(trades * AVG_TRADE_USD, 2),
    trades,
    winRateBps: s.winRateBps,
    maxDrawdownBps: Math.round(s.ddPct * 100 * Math.max(0.5, f.pnl)),
    forecastHitRateBps: s.hitBps,
    forkCount: s.forks,
    daysActive: Math.min(s.daysActive, f.days),
    mode: s.mode,
    verified: s.verified
      ? {
          reportTx: hashOf(`${s.id}:report`),
          asOf: now - (17 + (hashStr(s.id) % 50)) * 60_000,
        }
      : null,
    selfFunded: s.selfFunded,
  };
}

function allTimePnlUsd(id: string): number {
  const s = ENTITY_SEEDS.find((e) => e.id === id);
  return s ? (s.allocationUsd * s.pnlPct) / 100 : 0;
}

// ---------------------------------------------------------------------------
// Budget and treasury.
// ---------------------------------------------------------------------------

function tierFor(runwayDays: number, balanceUsd: number): BudgetTier {
  if (balanceUsd <= 0) return "empty";
  if (runwayDays >= 3) return "healthy";
  if (runwayDays >= 1) return "low";
  return "critical";
}

function zgBudgetFor(id: string): ZgBudget {
  const r = rng(hashStr(`${id}:zg`));
  const dailySpendUsd = round(0.18 + r() * 0.22, 4);
  const balanceUsd = round(dailySpendUsd * (0.6 + r() * 4.2), 4);
  const runwayDays = round(balanceUsd / dailySpendUsd, 1);
  return {
    tier: tierFor(runwayDays, balanceUsd),
    balanceUsd,
    dailyCapUsd: DAILY_0G_CAP_USD,
    spentTodayUsd: round(Math.min(DAILY_0G_CAP_USD, dailySpendUsd * (0.3 + r() * 0.6)), 4),
    dailySpendUsd,
    runwayDays,
  };
}

function treasuryFor(agent: Agent, pnlUsd: number, now: number): AgentTreasury {
  const zg = zgBudgetFor(agent.id);
  const owed = round((Math.max(0, pnlUsd) * agent.config.commissionBps) / 10_000, 4);
  const paid = round(owed * 0.6, 4);
  const balanceUsd = round(owed - paid, 4);
  const reserveUsd = round(zg.dailySpendUsd * RESERVE_DAYS, 4);
  const topUps: TopUp[] = agent.zgWallet
    ? [0, 1].map((i) => ({
        id: `topup_${agent.id}_${i}`,
        ts: now - (i + 1) * 2 * DAY,
        usdcAmount: 0.5,
        zgAmount: round((0.5 * 0.99) / ZG_PRICE_MOCK_USD, 2),
        basePayTx: hashOf(`${agent.id}:base:${i}`),
        zgTransferTx: hashOf(`${agent.id}:zg-transfer:${i}`),
        depositTx: i === 0 ? hashOf(`${agent.id}:deposit:${i}`) : null,
        status: i === 0 ? "credited" : "pending",
      }))
    : [];
  return {
    agentId: agent.id,
    balanceUsd,
    reserveUsd,
    withdrawableUsd: round(Math.max(0, balanceUsd - reserveUsd), 4),
    commissionOwedUsd: owed,
    commissionPaidUsd: paid,
    commissionBps: agent.config.commissionBps,
    source: "derived",
    zg,
    topUps,
  };
}

// ---------------------------------------------------------------------------
// Public data API.
// ---------------------------------------------------------------------------

/** Parses leaderboard query params from a URL or a Next.js searchParams object. */
export function parseLeaderboardQuery(p: Record<string, string | string[] | undefined>): LeaderboardQuery {
  const one = (k: string): string | undefined => {
    const v = p[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const kind = one("kind");
  const template = one("template");
  const tf = one("timeframe");
  const mode = one("mode");
  return {
    kind: kind === "human" || kind === "all" ? kind : "agent",
    template: TEMPLATES.some((t) => t.id === template) ? (template as TemplateId) : "all",
    timeframe: tf === "24h" || tf === "7d" || tf === "30d" ? tf : "all",
    mode: mode === "live" || mode === "paper" ? mode : "all",
  };
}

/** Leaderboard rows (stats only, no trades). Sorted by realized PnL % descending. */
export async function getLeaderboard(q: LeaderboardQuery = {}): Promise<PerformanceStats[]> {
  const now = Date.now();
  const kind = q.kind ?? "agent";
  const template = q.template ?? "all";
  const tf = q.timeframe ?? "all";
  const mode = q.mode ?? "all";
  return ENTITY_SEEDS.filter(
    (s) =>
      (kind === "all" || s.kind === kind) &&
      (template === "all" || s.template === template) &&
      (mode === "all" || s.mode === mode),
  )
    .map((s) => statsFor(s, tf, now))
    .sort((a, b) => b.realizedPnlPct - a.realizedPnlPct);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const created = CREATED.get(id);
  if (created) return { ...created.agent, status: STATUS_OVERRIDE.get(id) ?? created.agent.status };
  const seed = AGENT_SEEDS.find((s) => s.id === id);
  return seed ? agentFromSeed(seed, Date.now()) : null;
}

/** Decision log (owner-only in the UI). Newest first, one per ~2h. */
export async function getAgentEpisodes(id: string): Promise<Episode[]> {
  const agent = await getAgent(id);
  if (!agent) return [];
  const now = Date.now();
  const r = rng(hashStr(`${id}:episodes`));
  const tier = zgBudgetFor(id).tier;
  const episodes: Episode[] = [];

  for (let i = 0; i < EPISODE_COUNT; i++) {
    const ts = now - i * 2 * HOUR;
    const assets = agent.config.assets;
    const asset = assets[i % Math.max(1, assets.length)] ?? "WETH";
    const price = (ASSET_BASE[asset]?.price ?? 3000) * (1 + (r() - 0.5) * 0.02);
    const indicators: Indicators = {
      emaFast: round(price * (1 + (r() - 0.5) * 0.004), 2),
      emaSlow: round(price * (1 + (r() - 0.5) * 0.006), 2),
      rsi14: round(30 + r() * 40, 1),
      atr14: round(price * (0.004 + r() * 0.006), 2),
      rocPct: round((r() - 0.5) * 4, 2),
      rangeHigh: round(price * (1 + r() * 0.015), 2),
      rangeLow: round(price * (1 - r() * 0.015), 2),
      volatilityPct: round(0.8 + r() * 1.6, 2),
    };
    const market = [{ asset, priceUsd: round(price, 2), indicators }];

    const forecast: Forecast = {
      asset,
      horizonMin: 240,
      direction: pick(r, ["up", "up", "down", "flat"] as const),
      expectedMovePct: round(0.5 + r() * 2.5, 2),
      confidence: round(0.5 + r() * 0.35, 2),
    };

    const actionRoll = r();
    const action: Proposal["action"] =
      actionRoll < 0.6 ? "buy" : actionRoll < 0.75 ? "hold" : actionRoll < 0.85 ? "adjust_stops" : actionRoll < 0.92 ? "sell" : "cancel";
    const entryType = ENTRY_TYPE[agent.config.template];
    const entryPx = round(price * (entryType === "stop" ? 1.004 : 0.998), 2);
    const rationale = pick(r, RATIONALES);

    const proposal: Proposal =
      action === "buy"
        ? {
            action,
            asset,
            orderType: entryType,
            sizePct: round(0.3 + r() * 0.6, 2),
            takeProfitPct: 3,
            stopLossPct: 2,
            rationale,
            ...(entryType === "stop" ? { triggerPrice: entryPx } : { limitPrice: entryPx }),
            ...(entryType === "twap" ? { twapDurationSec: 3600, twapBuckets: 6 } : {}),
          }
        : { action, rationale };

    const intent: OrderIntent | null =
      action === "buy"
        ? {
            side: "buy",
            asset,
            quoteAsset: "USDC",
            orderType: entryType,
            notionalUsd: 1,
            ...(entryType === "stop" ? { triggerPrice: entryPx } : { limitPrice: entryPx }),
            ...(entryType === "twap" ? { twap: { durationSeconds: 3600, bucketCount: 6 } } : {}),
            attachedBracket: {
              takeProfitPrice: round(entryPx * 1.03, 2),
              stopLossPrice: round(entryPx * 0.98, 2),
            },
          }
        : null;

    const failed = r() < 0.04;
    const roll = r();
    const orderId = `ord_${hexOf(r, 4).slice(2)}`;
    let verdict: PolicyVerdict;
    let flashOrderIds: string[] = [];
    if (failed) {
      verdict = { kind: "noop", reasons: ["no decision: inference failed"] };
    } else if (!intent) {
      verdict = { kind: "noop", reasons: [`no order proposed (${action})`] };
    } else if (roll < 0.55) {
      verdict = { kind: "approve", order: intent };
      flashOrderIds = [orderId];
    } else if (roll < 0.7) {
      verdict = {
        kind: "clamp",
        order: intent,
        reasons: [`size clamped from $${round(1 + r() * 0.8, 2).toFixed(2)} to MAX_TRADE_USD $1.00`],
      };
      flashOrderIds = [orderId];
    } else {
      verdict = { kind: "reject", reasons: [pick(r, REJECT_REASONS)] };
    }

    const decision: DecisionOutput | null = failed ? null : { forecast, proposal };
    const inference: InferenceTrace | null = failed
      ? null
      : {
          requestId: `req_${hexOf(r, 12).slice(2)}`,
          model: MODEL_BY_TIER[agent.config.modelTier],
          provider: "0G TEE provider",
          billing: String(1200 + Math.floor(r() * 2400)),
          teeVerified: r() > 0.1,
          latencyMs: 900 + Math.floor(r() * 2200),
          payer: "agent",
        };

    episodes.push({
      id: `ep_${id}_${i}`,
      agentId: id,
      ts,
      riskLevel: i === 7 ? "CAUTION" : "NORMAL",
      budgetTier: tier,
      market,
      decision,
      inference,
      verdict,
      flashOrderIds,
      zgStorageRoot: i % 2 === 0 ? hashOf(`${id}:root:${i}`) : null,
      error: failed ? "0G 402 Insufficient balance: switched to Critical tier" : null,
    });
  }
  return episodes;
}

/** Lessons from the reflection loop. Each carries a 0G Storage root. */
export async function getAgentLessons(id: string): Promise<Lesson[]> {
  const agent = await getAgent(id);
  if (!agent) return [];
  const r = rng(hashStr(`${id}:lessons`));
  const now = Date.now();
  const lessons: Lesson[] = Array.from({ length: 4 }, (_, i) => ({
    id: `lesson_${id}_${i}`,
    agentId: id,
    ts: now - (i + 1) * DAY,
    lesson: pick(r, LESSON_POOL),
    evidenceEpisodeIds: [`ep_${id}_${i * 2}`, `ep_${id}_${i * 2 + 1}`],
    confidence: round(0.55 + r() * 0.35, 2),
    appliesTo: LESSON_APPLIES[i % LESSON_APPLIES.length] ?? [],
    zgStorageRoot: hashOf(`${id}:lesson:${i}`),
  }));
  return lessons;
}

export async function getAgentTreasury(id: string): Promise<AgentTreasury | null> {
  const agent = await getAgent(id);
  if (!agent) return null;
  return treasuryFor(agent, allTimePnlUsd(id), Date.now());
}

/** Aggregate equity for the agent page chart. Ends at the all-time realized PnL. */
export async function getAgentEquityCurve(id: string): Promise<EquityPoint[]> {
  const seed = AGENT_SEEDS.find((s) => s.id === id);
  if (!seed) return [];
  return equityCurveFor(id, seed.allocationUsd, seed.pnlPct);
}

/** Synthesized equity path that ends at allocation * pnl%. Used by the mock and by the DB path (no per-tick equity is stored yet). */
export function equityCurveFor(id: string, allocationUsd: number, pnlPct: number): EquityPoint[] {
  const now = Date.now();
  const points = 84;
  const step = 4 * HOUR;
  const r = rng(hashStr(`${id}:equity`));
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < points; i++) {
    acc += r() - 0.5 + 0.2;
    cum.push(acc);
  }
  const last = cum[points - 1] ?? 0;
  const target = (allocationUsd * pnlPct) / 100;
  return cum.map((c, i) => {
    const bridge = c - (last * (i + 1)) / points;
    const pnl = (target * (i + 1)) / points + bridge * allocationUsd * 0.02;
    return {
      t: now - (points - 1 - i) * step,
      equityUsd: round(allocationUsd + pnl, 2),
      pnlUsd: round(pnl, 2),
    };
  });
}

// ---------------------------------------------------------------------------
// Runtime status, run-now and paper ledger (mock). Mirrors what the worker writes to agents.runtime.
// ---------------------------------------------------------------------------

/** Run-now requests in mock mode. A queued run "ticks" after MOCK_TICK_MS, so the button flow can be demoed. */
const QUEUED_TICKS = new Map<string, number>();
const MOCK_TICK_MS = 5_000;
const MOCK_OUTCOMES = ["hold", "approve", "hold", "reject"] as const;

export function getRuntimeSnapshot(agent: Agent, now = Date.now()): { runtime: AgentRuntimeState; walletProvisioned: boolean; tickQueued: boolean } {
  const h = hashStr(`${agent.id}:runtime`);
  const interval = Math.max(1, agent.config.tickIntervalSec);
  const queuedAt = QUEUED_TICKS.get(agent.id);
  let lastTickAt = now - (h % interval) * 1000;
  if (queuedAt !== undefined && now - queuedAt >= MOCK_TICK_MS) {
    QUEUED_TICKS.delete(agent.id);
    lastTickAt = now;
  }
  const alloc = agent.config.limits.maxAllocationUsd;
  const mark = 3000 + (h % 200);
  const avg = 2950;
  const qty = round((alloc * 0.4) / avg, 6);
  const valueUsd = round(qty * mark, 2);
  const cashUsd = round(alloc * 0.6, 2);
  const unrealizedPnlUsd = round(qty * (mark - avg), 2);
  const realizedPnlUsd = round(allTimePnlUsd(agent.id), 2);
  return {
    runtime: {
      lastTickAt,
      nextTickAt: lastTickAt + interval * 1000,
      lastOutcome: MOCK_OUTCOMES[h % MOCK_OUTCOMES.length],
      lastError: null,
      lastRequestId: hashOf(`${agent.id}:request`),
      updatedAt: now,
      portfolio: {
        cashUsd,
        positions: qty > 0 ? [{ asset: "WETH", qty, avgPriceUsd: avg, markPriceUsd: mark, valueUsd, unrealizedPnlUsd }] : [],
        equityUsd: round(cashUsd + valueUsd, 2),
        realizedPnlUsd,
        unrealizedPnlUsd,
        asOf: now,
      },
    },
    walletProvisioned: true,
    tickQueued: QUEUED_TICKS.has(agent.id),
  };
}

export function mockRequestTick(agentId: string, now = Date.now()): { requestId: string } {
  QUEUED_TICKS.set(agentId, now);
  return { requestId: hashOf(`${agentId}:tick:${now}`) };
}

export function getPaperLedger(agent: Agent, now = Date.now()): PaperLedgerView {
  const owed = round(Math.max(0, allTimePnlUsd(agent.id)) * (agent.config.commissionBps / 10_000), 4);
  const entries: PaperLedgerEntry[] = [];
  if (owed > 0) {
    const parts = [0.5, 0.3, 0.2];
    parts.forEach((share, i) =>
      entries.push({
        id: `${agent.id}:commission:${i}`,
        agentId: agent.id,
        kind: "commission",
        amountUsd: round(owed * share, 4),
        amount0g: null,
        note: "Paper performance fee on realized profit",
        ts: now - (i + 1) * 6 * HOUR,
      }),
    );
    const topupUsd = round(owed * 0.5, 4);
    entries.push({
      id: `${agent.id}:topup:0`,
      agentId: agent.id,
      kind: "topup",
      amountUsd: topupUsd,
      amount0g: round(topupUsd / ZG_PRICE_MOCK_USD, 4),
      note: "Simulated top-up to 0G credit",
      ts: now - 2 * 6 * HOUR,
    });
  }
  const commissionUsd = round(entries.filter((e) => e.kind === "commission").reduce((s, e) => s + e.amountUsd, 0), 4);
  const topupUsd = round(entries.filter((e) => e.kind === "topup").reduce((s, e) => s + e.amountUsd, 0), 4);
  const topup0g = round(entries.filter((e) => e.kind === "topup").reduce((s, e) => s + (e.amount0g ?? 0), 0), 4);
  return {
    entries: entries.sort((a, b) => b.ts - a.ts),
    totals: { commissionUsd, topupUsd, topup0g, balanceUsd: round(commissionUsd - topupUsd, 4) },
  };
}

export async function getRisk(): Promise<RiskStatus> {
  return {
    level: "NORMAL",
    reasonCode: RiskReason.None,
    asOf: Date.now() - 4 * 60_000,
    reportTx: hashOf("risk-oracle:latest"),
  };
}

/** Agents owned by a wallet (seeded demo agents plus anything created this session). */
export async function getMyAgents(address: string): Promise<OwnedAgent[]> {
  const me = address.toLowerCase();
  const now = Date.now();
  const out: OwnedAgent[] = [];
  const toOwned = (agent: Agent, stats: PerformanceStats | null, allocationUsd: number): OwnedAgent => {
    const t = treasuryFor(agent, stats?.realizedPnlUsd ?? 0, now);
    return { ...agent, stats, allocationUsd, budgetTier: t.zg.tier, withdrawableUsd: t.withdrawableUsd };
  };
  for (const s of AGENT_SEEDS) {
    const agent = agentFromSeed(s, now);
    if (agent.ownerAddress.toLowerCase() !== me) continue;
    out.push(toOwned(agent, statsFor(s, "all", now), s.allocationUsd));
  }
  for (const c of CREATED.values()) {
    if (c.agent.ownerAddress.toLowerCase() !== me) continue;
    const agent = { ...c.agent, status: STATUS_OVERRIDE.get(c.agent.id) ?? c.agent.status };
    out.push(toOwned(agent, null, c.allocationUsd));
  }
  return out;
}

export async function getHumanStats(address: string): Promise<PerformanceStats | null> {
  const me = address.toLowerCase();
  const seed = HUMAN_SEEDS.find((s) => s.id.toLowerCase() === me);
  return seed ? statsFor(seed, "all", Date.now()) : null;
}

export async function getTemplates(): Promise<TemplateDef[]> {
  return TEMPLATES;
}

/** Open orders, fills and balances for the trade terminal (mock; no wallet required). */
export async function getTradingActivity(_address?: string): Promise<TradingActivity> {
  const now = Date.now();
  const r = rng(hashStr("terminal"));
  const fills: Fill[] = Array.from({ length: 6 }, (_, i) => {
    const asset = i % 2 === 0 ? "WETH" : "cbBTC";
    const px = (ASSET_BASE[asset]?.price ?? 1) * (1 + (r() - 0.5) * 0.01);
    const size = round(0.5 + r() * 0.5, 2);
    return {
      id: `fill_${i}`,
      ts: now - (i + 1) * 47 * 60_000,
      asset,
      side: i % 3 === 2 ? "sell" : "buy",
      sizeUsd: size,
      priceUsd: round(px, 2),
      feeUsd: round(size * 0.001, 4),
      txHash: hashOf(`fill:${i}`),
    };
  });
  return {
    source: "demo",
    openOrders: [
      { id: "ord_7f3a21", ts: now - 14 * 60_000, asset: "WETH", side: "buy", orderType: "limit", sizeUsd: 1, priceUsd: 3398.5, status: "open" },
      { id: "ord_9c0e44", ts: now - 3 * HOUR, asset: "cbBTC", side: "buy", orderType: "twap", sizeUsd: 1, priceUsd: 103_900, status: "partially_filled" },
    ],
    fills,
    balances: [
      { symbol: "USDC", amount: 12.4, valueUsd: 12.4 },
      { symbol: "WETH", amount: 0.0021, valueUsd: round(0.0021 * 3412.8, 2) },
      { symbol: "cbBTC", amount: 0.00002, valueUsd: round(0.00002 * 104_250, 2) },
      { symbol: "0G", amount: 1.84, valueUsd: round(1.84 * ZG_PRICE_MOCK_USD, 2) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mock write paths (no DATABASE_URL). Same semantics as the DB repos, process-local only.
// ---------------------------------------------------------------------------

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const FORK_TX_KEY = "__arenaMockForks";
type ForkMap = Map<string, { newAgentId: string; sourceAgentId: string; buyer: string }>;
function forkMap(): ForkMap {
  const g = globalThis as Record<string, unknown>;
  if (!g[FORK_TX_KEY]) g[FORK_TX_KEY] = new Map();
  return g[FORK_TX_KEY] as ForkMap;
}

/** Persists a new agent in process memory (paused, paper, unfunded). Input must already be validated. */
export function mockCreateAgent(input: {
  name: string;
  ownerAddress: `0x${string}`;
  config: StrategyConfig;
  configHash: `0x${string}`;
  mode: ExecutionMode;
  forkedFrom?: string | null;
}): { id: string } {
  const id = `ag_${crypto.randomUUID().slice(0, 8)}`;
  const agent: Agent = {
    id,
    name: input.name,
    ownerAddress: input.ownerAddress,
    tradingWallet: ZERO_ADDRESS,
    zgWallet: null,
    config: input.config,
    configVersion: 1,
    configHash: input.configHash,
    status: "paused",
    mode: input.mode,
    forkedFrom: input.forkedFrom ?? null,
    createdAt: Date.now(),
  };
  CREATED.set(id, { agent, allocationUsd: input.config.limits.maxAllocationUsd });
  return { id };
}

/** Idempotent on txHash, like the forks table. Returns the clone's id. */
export function mockRecordFork(
  txHash: string,
  sourceAgentId: string,
  buyer: string,
  makeClone: () => string,
): { newAgentId: string; created: boolean } {
  const existing = forkMap().get(txHash.toLowerCase());
  if (existing) return { newAgentId: existing.newAgentId, created: false };
  const newAgentId = makeClone();
  forkMap().set(txHash.toLowerCase(), { newAgentId, sourceAgentId, buyer: buyer.toLowerCase() });
  return { newAgentId, created: true };
}

/** True when this buyer has a recorded fork of the source agent (the fork license). */
export function mockHasForkLicense(agentId: string, buyer: string): boolean {
  const me = buyer.toLowerCase();
  for (const f of forkMap().values()) if (f.sourceAgentId === agentId && f.buyer === me) return true;
  return false;
}

/** Owner status change. Stopped agents are terminal and are not changed here. */
export async function mockSetAgentStatus(agentId: string, status: AgentStatus): Promise<Agent | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  STATUS_OVERRIDE.set(agentId, status);
  return { ...agent, status };
}

export function mockGetHumansOptIn(address: string): boolean {
  return HUMANS_OPT_IN.get(address.toLowerCase()) ?? false;
}

export function mockSetHumansOptIn(address: string, optIn: boolean): HumansPrefs {
  const key = address.toLowerCase() as `0x${string}`;
  HUMANS_OPT_IN.set(key, optIn);
  return { address: key, humansBoardOptIn: optIn };
}
