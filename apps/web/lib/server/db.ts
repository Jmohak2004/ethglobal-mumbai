// Process-wide database handle. Server-only.
//
// @arena/db is loaded at runtime, never bundled and never imported for types: its schema.sql and PGlite dir are
// resolved from its real path, which a bundler cannot reproduce, and its source has a type error in
// repo/treasury.ts that would fail this app's typecheck. Mock mode (no DATABASE_URL) never loads it at all.
// The facade below mirrors the packages/db repo signatures this app uses.
import type {
  Agent,
  AgentStatus,
  Episode,
  ExecutionMode,
  Lesson,
  PerformanceStats,
  RiskLevel,
  StrategyConfig,
  TemplateId,
} from "@arena/shared";
import type { FlashOrderType, InferenceTrace } from "@arena/shared";
import type { RiskReason } from "@arena/shared";
import type {
  AgentRuntimeState,
  PaperLedgerEntry,
  PaperLedgerTotals,
  ProvisioningStatus,
} from "@/lib/types";

/** Opaque: the concrete type is @arena/db's Db (drizzle over postgres-js). */
export type Db = unknown;

/** Mirrors @arena/db PaperFillInput (repo/orders.ts). */
export interface PaperFillInput {
  funderAddress: string;
  side: "buy" | "sell";
  asset: string;
  orderType: FlashOrderType;
  notionalUsd: number;
  priceUsd: number;
  feeUsd: number;
  integratorFeeUsd: number;
  quoteId?: string | null;
  ts?: number;
}

/** Mirrors @arena/db PaperFillRecord. `id` is the fill id. */
export interface PaperFillRow {
  id: string;
  orderId: string;
  price: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  integratorFeeUsd: number;
  txId: string | null;
  ts: number;
  asset: string;
  side: "buy" | "sell";
  orderType: FlashOrderType;
  funderAddress: string;
}

export interface Repo {
  createDb(opts: { url?: string }): Db;
  migrate(db: Db): Promise<void>;
  leaderboard(
    db: Db,
    q: { kind?: "agent" | "human" | "all"; template?: TemplateId; mode?: ExecutionMode; limit?: number },
  ): Promise<PerformanceStats[]>;
  getAgent(db: Db, id: string): Promise<Agent | null>;
  listByOwner(db: Db, ownerAddress: string): Promise<Agent[]>;
  setAgentStatus(db: Db, agentId: string, status: AgentStatus): Promise<Agent | null>;
  getUser(
    db: Db,
    address: string,
  ): Promise<{ address: string; humansBoardOptIn: boolean; displayName: string | null; tgHandle: string | null } | null>;
  upsertUser(db: Db, input: { address: string; humansBoardOptIn?: boolean }): Promise<{ address: string; humansBoardOptIn: boolean }>;
  createAgent(
    db: Db,
    input: {
      name: string;
      ownerAddress: string;
      tradingWallet: string;
      zgWallet?: string | null;
      config: StrategyConfig;
      configHash: `0x${string}`;
      mode?: ExecutionMode;
      status?: Agent["status"];
      forkedFrom?: string | null;
    },
  ): Promise<Agent>;
  getConfigVersion(
    db: Db,
    agentId: string,
    version: number,
  ): Promise<{ config: StrategyConfig; configHash: `0x${string}` } | null>;
  listEpisodesByAgent(db: Db, agentId: string, opts?: { limit?: number; beforeTs?: number }): Promise<Episode[]>;
  topForAgent(db: Db, agentId: string, opts?: { k?: number; asOf?: number }): Promise<Lesson[]>;
  latestRisk(
    db: Db,
  ): Promise<{ level: RiskLevel; reasonCode: RiskReason; asOf: number; txHash: `0x${string}` | null } | null>;
  listForksByBuyer(
    db: Db,
    buyer: string,
  ): Promise<{ agentId: string; txHash: `0x${string}`; newAgentId: string | null }[]>;
  insertFork(
    db: Db,
    input: {
      agentId: string;
      buyer: string;
      priceUsd: number;
      txHash: `0x${string}`;
      configHash: `0x${string}`;
      newAgentId?: string | null;
    },
  ): Promise<unknown>;
  listTreasuryEvents(db: Db, agentId: string, limit?: number): Promise<{ kind: string; amountUsd: number }[]>;
  sumBillingSince(db: Db, agentId: string, since: number): Promise<string>;
  listTopupsByAgent(
    db: Db,
    agentId: string,
    limit?: number,
  ): Promise<
    {
      id: string;
      ts: number;
      usdcAmount: number;
      baseTx: string | null;
      zgTransferTx: string | null;
      depositTx: string | null;
      status: string;
    }[]
  >;
  insertInference(
    db: Db,
    trace: InferenceTrace,
    ctx?: { agentId?: string | null; userAddress?: string | null; purpose?: string; ts?: number },
  ): Promise<void>;
  // Worker runtime status, run-now requests, paper ledger (@arena/db repo/demo.ts, repo/agents.ts)
  getAgentRuntime(db: Db, agentId: string): Promise<AgentRuntimeState>;
  requestTick(db: Db, agentId: string, requestedBy: string | null, now?: number): Promise<string>;
  hasPendingTickRequest(db: Db, agentId: string): Promise<boolean>;
  listPaperLedger(db: Db, agentId: string, limit?: number): Promise<PaperLedgerEntry[]>;
  paperLedgerTotals(db: Db, agentId: string): Promise<PaperLedgerTotals>;
  getProvisioning(db: Db, agentId: string): Promise<ProvisioningStatus | null>;
  // Risk writes (repo/attestations.ts)
  insertRisk(
    db: Db,
    input: { id?: string; level: RiskLevel; reasonCode: RiskReason; asOf: number; txHash?: string | null },
  ): Promise<string>;
  // Paper fills from the web terminal (repo/orders.ts)
  insertPaperFill(db: Db, input: PaperFillInput): Promise<{ orderId: string; fillId: string }>;
  listPaperFillsByFunder(db: Db, funderAddress: string, limit?: number): Promise<PaperFillRow[]>;
  cancelPaperOrders(db: Db, funderAddress: string, orderIds: string[], now?: number): Promise<string[]>;
}

let repoPromise: Promise<Repo> | undefined;
const ARENA_DB = "@arena/db";

/** The @arena/db module, loaded on first use. The specifier is a variable so no bundler or typechecker follows it. */
export function arenaDb(): Promise<Repo> {
  repoPromise ??= import(/* turbopackIgnore: true */ /* webpackIgnore: true */ ARENA_DB) as Promise<Repo>;
  return repoPromise;
}

type Cache = { promise?: Promise<Db> };
const g = globalThis as typeof globalThis & { __arenaDb?: Cache };

let warned = false;

/** True when DATABASE_URL is set. Without it every getter falls back to mock data. */
export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * The migrated database, or null when DATABASE_URL is unset (mock fallback). Created once per process and
 * cached on globalThis so dev HMR does not reopen connections. The first unconfigured call logs once.
 */
export function getDb(): Promise<Db> | null {
  if (!dbConfigured()) {
    if (!warned) {
      warned = true;
      console.warn("[arena] DATABASE_URL is not set: serving mock data. Set it to use Postgres.");
    }
    return null;
  }
  const cache = (g.__arenaDb ??= {});
  cache.promise ??= (async () => {
    const repo = await arenaDb();
    const db = repo.createDb({ url: process.env.DATABASE_URL });
    await repo.migrate(db);
    return db;
  })().catch((err: unknown) => {
    // Let the next request retry instead of caching a failed connection.
    if (g.__arenaDb) g.__arenaDb.promise = undefined;
    throw err;
  });
  return cache.promise;
}

/** Database plus repo module, or null in mock mode. Use in getters: `const ctx = await dbContext(); if (!ctx) ...`. */
export async function dbContext(): Promise<{ db: Db; r: Repo } | null> {
  const p = getDb();
  if (!p) return null;
  const [db, r] = await Promise.all([p, arenaDb()]);
  return { db, r };
}
