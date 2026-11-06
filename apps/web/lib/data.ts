// Data access layer. Pages and route handlers read ONLY through these functions.
// With DATABASE_URL set, reads and writes go to Postgres through the @arena/db repos. Without it,
// the same functions serve the deterministic mock data in lib/mock-data.ts (logged once at startup).
// Server-only: never import from a client component (use lib/types.ts for types).
import { RiskReason, agentIdToBytes32 } from "@arena/shared";
import type { Agent, AgentStatus, Episode, ExecutionMode, Lesson, PerformanceStats, StrategyConfig } from "@arena/shared";
import { env } from "@/lib/server/env";
import { dbContext, type Db, type Repo } from "@/lib/server/db";
import { readTreasuryAccount } from "@/lib/server/chain";
import { ApiError } from "@/lib/server/errors";
import { shortAddr } from "@/lib/format";
import { round4, tierFor } from "@/lib/treasury-math";
import * as mock from "@/lib/mock-data";
import { TEMPLATES, type TemplateDef } from "@/lib/templates";
import type {
  AgentTreasury,
  EquityPoint,
  HumansPrefs,
  LeaderboardQuery,
  OwnedAgent,
  PublicAgent,
  RiskStatus,
  TopUp,
  TradingActivity,
  ZgBudget,
} from "@/lib/types";

export const parseLeaderboardQuery = mock.parseLeaderboardQuery;

const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const DAY = 24 * 3600_000;

interface Ctx {
  db: Db;
  r: Repo;
}

/** Stats keyed by entity id. Stats come from the agent_stats table (CRE WF1 output or the stats job). */
async function statsById(ctx: Ctx): Promise<Map<string, PerformanceStats>> {
  const rows = await ctx.r.leaderboard(ctx.db, { kind: "all", limit: 500 });
  return new Map(rows.map((row) => [row.entityId, row]));
}

// ---------------------------------------------------------------------------
// Leaderboard, agents, humans
// ---------------------------------------------------------------------------

/** Leaderboard rows (stats only, no trades). Sorted by realized PnL % descending. */
export async function getLeaderboard(q: LeaderboardQuery = {}): Promise<PerformanceStats[]> {
  const ctx = await dbContext();
  if (!ctx) return mock.getLeaderboard(q);
  const rows = await ctx.r.leaderboard(ctx.db, {
    kind: q.kind ?? "agent",
    template: q.template && q.template !== "all" ? q.template : undefined,
    mode: q.mode && q.mode !== "all" ? q.mode : undefined,
    limit: 500,
  });
  // Timeframe filters are not stored per window yet, so the DB path serves all-time stats.
  return rows.sort((a, b) => b.realizedPnlPct - a.realizedPnlPct);
}

/**
 * Full agent record, config included. Server-internal: routes and pages must not return it to anyone who is not
 * the owner or a fork licensee. Public reads go through getPublicAgent and the agent route's viewer check.
 */
export async function getAgent(id: string): Promise<Agent | null> {
  const ctx = await dbContext();
  if (!ctx) return mock.getAgent(id);
  return ctx.r.getAgent(ctx.db, id);
}

/** Stats-only projection of an agent (PRD 6.1). No config, sources, lessons, limits or full owner address. */
export function toPublicAgent(agent: Agent): PublicAgent {
  return {
    id: agent.id,
    name: agent.name,
    template: agent.config.template,
    mode: agent.mode,
    status: agent.status,
    ownerShort: shortAddr(agent.ownerAddress),
    forkable: agent.config.fork.forkable,
    forkPriceUsd: agent.config.fork.priceUsd,
    forkedFrom: agent.forkedFrom,
    configVersion: agent.configVersion,
    createdAt: agent.createdAt,
  };
}

export async function getPublicAgent(id: string): Promise<PublicAgent | null> {
  const agent = await getAgent(id);
  return agent ? toPublicAgent(agent) : null;
}

/** True when the buyer paid StrategyMarketplace.fork for this agent (a recorded fork with buyer == address). */
export async function hasForkLicense(agentId: string, buyer: string): Promise<boolean> {
  const ctx = await dbContext();
  if (!ctx) return mock.mockHasForkLicense(agentId, buyer);
  const me = buyer.toLowerCase();
  const forks = await ctx.r.listForksByBuyer(ctx.db, me);
  return forks.some((f) => f.agentId === agentId);
}

/**
 * Owner pause/resume. Stopped is terminal and is set by the platform, so it is not accepted here. Returns null when
 * the agent does not exist.
 */
export async function setAgentStatus(id: string, status: Exclude<AgentStatus, "stopped">): Promise<Agent | null> {
  const ctx = await dbContext();
  if (!ctx) return mock.mockSetAgentStatus(id, status);
  return ctx.r.setAgentStatus(ctx.db, id, status);
}

/** Humans-board opt-in for a wallet. Users without a row are not opted in. */
export async function getHumansPrefs(address: string): Promise<HumansPrefs> {
  const key = address.toLowerCase() as `0x${string}`;
  const ctx = await dbContext();
  if (!ctx) return { address: key, humansBoardOptIn: mock.mockGetHumansOptIn(key) };
  const user = await ctx.r.getUser(ctx.db, key);
  return { address: key, humansBoardOptIn: user?.humansBoardOptIn ?? false };
}

export async function setHumansBoardOptIn(address: string, optIn: boolean): Promise<HumansPrefs> {
  const key = address.toLowerCase() as `0x${string}`;
  const ctx = await dbContext();
  if (!ctx) return mock.mockSetHumansOptIn(key, optIn);
  const user = await ctx.r.upsertUser(ctx.db, { address: key, humansBoardOptIn: optIn });
  return { address: key, humansBoardOptIn: user.humansBoardOptIn };
}

/** Decision log (owner-only, enforced by the route). Newest first. */
export async function getAgentEpisodes(id: string): Promise<Episode[]> {
  const ctx = await dbContext();
  if (!ctx) return mock.getAgentEpisodes(id);
  return ctx.r.listEpisodesByAgent(ctx.db, id, { limit: 50 });
}

/** Reflection lessons (owner-only, enforced by the route). */
export async function getAgentLessons(id: string): Promise<Lesson[]> {
  const ctx = await dbContext();
  if (!ctx) return mock.getAgentLessons(id);
  return ctx.r.topForAgent(ctx.db, id, { k: 20 });
}

export async function getAgentTreasury(id: string): Promise<AgentTreasury | null> {
  const ctx = await dbContext();
  if (!ctx) return mock.getAgentTreasury(id);
  const agent = await ctx.r.getAgent(ctx.db, id);
  if (!agent) return null;
  const stats = (await statsById(ctx)).get(id);
  return treasuryFromDb(ctx, agent, stats?.realizedPnlUsd ?? 0);
}

/** Aggregate equity for the agent page chart. Ends at the all-time realized PnL. */
export async function getAgentEquityCurve(id: string): Promise<EquityPoint[]> {
  const ctx = await dbContext();
  if (!ctx) return mock.getAgentEquityCurve(id);
  const agent = await ctx.r.getAgent(ctx.db, id);
  if (!agent) return [];
  const stats = (await statsById(ctx)).get(id);
  // Per-tick equity is not persisted yet, so the curve is synthesized from the all-time stats.
  return mock.equityCurveFor(id, agent.config.limits.maxAllocationUsd, stats?.realizedPnlPct ?? 0);
}

export async function getRisk(): Promise<RiskStatus> {
  const ctx = await dbContext();
  if (!ctx) return mock.getRisk();
  const r = await ctx.r.latestRisk(ctx.db);
  if (!r) return { level: "NORMAL", reasonCode: RiskReason.None, asOf: Date.now(), reportTx: ZERO_HASH };
  return {
    level: r.level,
    reasonCode: r.reasonCode,
    asOf: r.asOf,
    reportTx: (r.txHash ?? ZERO_HASH) as `0x${string}`,
  };
}

/** Agents owned by a wallet. Full records (config included): the route restricts this to the owner. */
export async function getMyAgents(address: string): Promise<OwnedAgent[]> {
  const ctx = await dbContext();
  if (!ctx) return mock.getMyAgents(address);
  const rows = await ctx.r.listByOwner(ctx.db, address);
  const stats = await statsById(ctx);
  return Promise.all(
    rows.map(async (agent) => {
      const s = stats.get(agent.id) ?? null;
      const t = await treasuryFromDb(ctx, agent, s?.realizedPnlUsd ?? 0);
      return {
        ...agent,
        stats: s,
        allocationUsd: agent.config.limits.maxAllocationUsd,
        budgetTier: t.zg.tier,
        withdrawableUsd: t.withdrawableUsd,
      };
    }),
  );
}

export async function getHumanStats(address: string): Promise<PerformanceStats | null> {
  const ctx = await dbContext();
  if (!ctx) return mock.getHumanStats(address);
  const me = address.toLowerCase();
  const rows = await ctx.r.leaderboard(ctx.db, { kind: "human", limit: 500 });
  return rows.find((row) => row.entityId.toLowerCase() === me) ?? null;
}

export async function getTemplates(): Promise<TemplateDef[]> {
  return TEMPLATES;
}

/**
 * Open orders, fills and balances. The DB path returns nothing: live Flash activity is fetched per wallet
 * from /api/flash/orders. The mock path returns demo rows.
 */
export async function getTradingActivity(address?: string): Promise<TradingActivity> {
  const ctx = await dbContext();
  if (!ctx) return mock.getTradingActivity(address);
  return { source: "none", openOrders: [], fills: [], balances: [] };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewAgent {
  name: string;
  ownerAddress: `0x${string}`;
  config: StrategyConfig;
  configHash: `0x${string}`;
  mode: ExecutionMode;
  forkedFrom?: string | null;
}

/** Creates a paused, unfunded agent. Input must already be validated by @arena/policy. */
export async function createAgent(input: NewAgent): Promise<{ id: string }> {
  const ctx = await dbContext();
  if (!ctx) return mock.mockCreateAgent(input);
  const agent = await ctx.r.createAgent(ctx.db, {
    name: input.name,
    ownerAddress: input.ownerAddress,
    // Trading wallet provisioning (server wallet) is not built yet. The zero address marks "not provisioned".
    tradingWallet: mock.ZERO_ADDRESS,
    zgWallet: null,
    config: input.config,
    configHash: input.configHash,
    mode: input.mode,
    status: "paused",
    forkedFrom: input.forkedFrom ?? null,
  });
  return { id: agent.id };
}

/**
 * Clones a source agent for a verified fork. The clone uses the stored config version whose hash matches
 * the onchain configHash from the Forked event, and is owned by the buyer. Idempotent on the fork tx.
 */
export async function forkAgent(input: {
  sourceId: string;
  buyer: `0x${string}`;
  txHash: `0x${string}`;
  onchainConfigHash: `0x${string}`;
  priceUsd: number;
}): Promise<{ newAgentId: string; created: boolean }> {
  const source = await getAgent(input.sourceId);
  if (!source) throw new ApiError(404, "NOT_FOUND", "Source agent not found");
  const ctx = await dbContext();

  if (!ctx) {
    return mock.mockRecordFork(input.txHash, input.sourceId, input.buyer, () =>
      mock.mockCreateAgent({
        name: forkName(source.name),
        ownerAddress: input.buyer,
        config: source.config,
        configHash: source.configHash,
        mode: "paper",
        forkedFrom: source.id,
      }).id,
    );
  }
  const { db, r } = ctx;

  const existing = (await r.listForksByBuyer(db, input.buyer)).find(
    (f) => f.txHash.toLowerCase() === input.txHash.toLowerCase(),
  );
  if (existing?.newAgentId) return { newAgentId: existing.newAgentId, created: false };

  let version: { config: StrategyConfig; configHash: `0x${string}` } | null = null;
  for (let v = source.configVersion; v >= 1 && !version; v--) {
    const cv = await r.getConfigVersion(db, source.id, v);
    if (cv && cv.configHash.toLowerCase() === input.onchainConfigHash.toLowerCase()) version = cv;
  }
  if (!version) {
    throw new ApiError(409, "CONFLICT", "No stored config version matches the fork event's configHash");
  }

  const clone = await r.createAgent(db, {
    name: forkName(source.name),
    ownerAddress: input.buyer,
    tradingWallet: mock.ZERO_ADDRESS,
    zgWallet: null,
    config: version.config,
    configHash: version.configHash,
    mode: "paper",
    status: "paused",
    forkedFrom: source.id,
  });
  await r.insertFork(db, {
    agentId: source.id,
    buyer: input.buyer,
    priceUsd: input.priceUsd,
    txHash: input.txHash,
    configHash: version.configHash,
    newAgentId: clone.id,
  });
  return { newAgentId: clone.id, created: true };
}

function forkName(name: string): string {
  return `${name.slice(0, 24)} (fork)`;
}

// ---------------------------------------------------------------------------
// DB-backed treasury and budget view
// ---------------------------------------------------------------------------

async function treasuryFromDb(ctx: Ctx, agent: Agent, pnlUsd: number): Promise<AgentTreasury> {
  const { db, r } = ctx;
  const now = Date.now();
  const e = env();
  const bps = agent.config.commissionBps;
  const owed = round4((Math.max(0, pnlUsd) * bps) / 10_000);

  const events = await r.listTreasuryEvents(db, agent.id, 500);
  const paid = round4(
    events.filter((ev) => ev.kind === "commission_collected").reduce((sum, ev) => sum + ev.amountUsd, 0),
  );

  // Chain balances win when the treasury is deployed. Otherwise the figures are derived from stats.
  const onchain = await readTreasuryAccount(agentIdToBytes32(agent.id));
  const derivedBalance = round4(Math.max(0, owed - paid));

  // 0G spend over the last day, from inference billing. The 0G account balance read is not wired, so the
  // balance is 0 and the tier reads as empty until that lands.
  const spentToday = Number(await r.sumBillingSince(db, agent.id, now - DAY)) || 0;
  const dailySpendUsd = round4(spentToday);
  const reserveUsd = round4(dailySpendUsd * e.RESERVE_DAYS);
  const balanceUsd = onchain ? onchain.balanceUsd : derivedBalance;
  const zg: ZgBudget = {
    tier: tierFor(0, 0),
    balanceUsd: 0,
    dailyCapUsd: e.AGENT_DAILY_0G_CAP,
    spentTodayUsd: round4(Math.min(e.AGENT_DAILY_0G_CAP, spentToday)),
    dailySpendUsd,
    runwayDays: 0,
  };

  const topUps: TopUp[] = (await r.listTopupsByAgent(db, agent.id, 10)).map((t) => ({
    id: t.id,
    ts: t.ts,
    usdcAmount: t.usdcAmount,
    zgAmount: 0,
    basePayTx: (t.baseTx ?? ZERO_HASH) as `0x${string}`,
    zgTransferTx: (t.zgTransferTx ?? null) as `0x${string}` | null,
    depositTx: (t.depositTx ?? null) as `0x${string}` | null,
    status: t.status === "credited" ? "credited" : "pending",
  }));

  return {
    agentId: agent.id,
    balanceUsd,
    reserveUsd,
    withdrawableUsd: onchain ? onchain.withdrawableUsd : round4(Math.max(0, balanceUsd - reserveUsd)),
    commissionOwedUsd: owed,
    commissionPaidUsd: paid,
    commissionBps: bps,
    source: onchain ? "chain" : "derived",
    zg,
    topUps,
  };
}
