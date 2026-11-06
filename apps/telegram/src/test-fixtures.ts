// Shared test fixtures: an in-memory PGlite db seeded through the @arena/db repos.

import { createAgent, createDb, insertRisk, migrate, upsertStats, upsertUser, type Db, type StatsInput } from "@arena/db";
import { RiskReason, type StrategyConfig, type TemplateId } from "@arena/shared";
import type { ExplorerLinks } from "./format.ts";

export const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const OWNER = `0x${"a".repeat(40)}`;
export const OTHER = `0x${"c".repeat(40)}`;
export const HUMAN = `0x${"b".repeat(40)}`;
export const WEB_URL = "http://localhost:3000";
export const LINKS: ExplorerLinks = { basescanUrl: "https://sepolia.basescan.org", zgExplorerUrl: null };

export const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;

export function config(template: TemplateId, fork = { forkable: true, priceUsd: 2 }): StrategyConfig {
  return {
    template,
    assets: ["WETH", "cbBTC"],
    sliders: { sizePct: 0.2, tpPct: 3, slPct: 2 },
    limits: { maxTradeUsd: 1, maxOpenPositions: 2, maxAllocationUsd: 5, maxDailyLossUsd: 1, maxDrawdownPct: 15, cooldownSec: 900 },
    tickIntervalSec: 300,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: 1000,
    autoTune: { enabled: false, maxDeltaPct: 0 },
    publicCommentary: "delayed",
    insightSources: [],
    fork,
  };
}

/**
 * Seeds:
 *   agent-mom       "[demo] Momentum Alpha"  owned by OWNER, stats, CRE-verified, self-funded
 *   agent-mom-2     "Momentum Beta"          owned by OTHER, no stats yet
 *   agent-brk       "[demo] Breakout Charlie" owned by OTHER, stats, negative PnL
 *   agent-locked    "Locked Strategy"        owned by OTHER, not forkable
 *   human           "[demo] Ada K."          on the humans board
 * Platform risk: NORMAL.
 */
export async function seedDb(): Promise<Db> {
  const db = createDb({ memory: true });
  await migrate(db);

  await createAgent(db, {
    id: "agent-mom",
    name: "[demo] Momentum Alpha",
    ownerAddress: OWNER,
    tradingWallet: address(1),
    config: config("momentum"),
    configHash: hash(101),
    createdAt: T0 - 2 * DAY,
  });
  await createAgent(db, {
    id: "agent-mom-2",
    name: "Momentum Beta",
    ownerAddress: OTHER,
    tradingWallet: address(2),
    config: config("momentum"),
    configHash: hash(102),
    createdAt: T0 - DAY,
  });
  await createAgent(db, {
    id: "agent-brk",
    name: "[demo] Breakout Charlie",
    ownerAddress: OTHER,
    tradingWallet: address(3),
    config: config("breakout"),
    configHash: hash(103),
    createdAt: T0 - DAY,
  });
  await createAgent(db, {
    id: "agent-locked",
    name: "Locked Strategy",
    ownerAddress: OTHER,
    tradingWallet: address(4),
    config: config("smart_dca", { forkable: false, priceUsd: 2 }),
    configHash: hash(104),
    createdAt: T0 - DAY,
  });

  await upsertUser(db, { address: HUMAN, displayName: "[demo] Ada K.", humansBoardOptIn: true, createdAt: T0 });
  const stats: StatsInput[] = [
    {
      entityId: "agent-mom",
      kind: "agent",
      name: "[demo] Momentum Alpha",
      template: "momentum",
      mode: "paper",
      realizedPnlUsd: 4.82,
      realizedPnlPct: 3.1,
      volumeUsd: 210,
      trades: 620,
      winRateBps: 5810,
      maxDrawdownBps: 420,
      forecastHitRateBps: 6150,
      daysActive: 8,
      verified: { reportTx: hash(9), asOf: T0 - HOUR },
      selfFunded: true,
    },
    {
      entityId: "agent-brk",
      kind: "agent",
      name: "[demo] Breakout Charlie",
      template: "breakout",
      mode: "paper",
      realizedPnlUsd: -0.91,
      realizedPnlPct: -0.6,
      volumeUsd: 96,
      trades: 1040,
      winRateBps: 4170,
      maxDrawdownBps: 880,
      forecastHitRateBps: 4720,
      daysActive: 5,
      verified: null,
      selfFunded: false,
    },
    {
      entityId: HUMAN,
      kind: "human",
      name: "[demo] Ada K.",
      template: null,
      mode: "paper",
      realizedPnlUsd: 6.35,
      realizedPnlPct: 4.2,
      volumeUsd: 430,
      trades: 880,
      winRateBps: 6320,
      maxDrawdownBps: 500,
      forecastHitRateBps: 6600,
      daysActive: 21,
      verified: null,
      selfFunded: false,
    },
  ];
  await upsertStats(db, stats);

  await insertRisk(db, { id: "risk-normal", level: "NORMAL", reasonCode: RiskReason.None, asOf: T0 - 1000, txHash: null });
  return db;
}

/** Substrings that must never appear in public (stats-only) output. Matched case-insensitively. */
export const PUBLIC_FORBIDDEN = [
  "notional",
  "limitprice",
  "triggerprice",
  "sizepct",
  "ordertype",
  "orderid",
  "flash order",
  "priceusd",
  "price",
  "qty",
  "fill",
  "txid",
  "attachedbracket",
  "takeprofit",
  "stoploss",
  "trailpct",
  "order placed",
  "guardrail",
];

export function forbiddenHits(text: string): string[] {
  const lower = text.toLowerCase();
  return PUBLIC_FORBIDDEN.filter((term) => lower.includes(term));
}
