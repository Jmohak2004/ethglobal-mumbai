// Agent economics on Base (PRD 6.11): commission collection and operator top-ups through AgentTreasury.
// Both are disabled cleanly unless TREASURY_ADDRESS, PERF_REGISTRY_ADDRESS and OPERATOR_PRIVATE_KEY are set.
// The chain is behind the TreasuryChain interface, so the decision logic is testable without RPC.

import {
  createTopup,
  insertTreasuryEvent,
  listTopupsByAgent,
  type Db,
  type TopupRecord,
} from "@arena/db";
import { agentIdToBytes32, fromUsd6, toUsd6, type Agent, type BudgetTier } from "@arena/shared";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_TREASURY_ABI, PERFORMANCE_REGISTRY_ABI } from "../abi.ts";
import type { ChainConfig } from "../chain.ts";
import type { WorkerEnv } from "../env.ts";
import type { Clock } from "../deps.ts";
import type { Logger } from "../logger.ts";
import { silentLogger } from "../logger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TreasuryAccount {
  balance: bigint;
  commissionPaid: bigint;
  topUpDay: bigint;
  toppedUpToday: bigint;
  topUpNonce: bigint;
}

/** The AgentTreasury and PerformanceRegistry calls the worker makes. */
export interface TreasuryChain {
  commissionOwed(agentIdBytes32: Hex): Promise<bigint>;
  account(agentIdBytes32: Hex): Promise<TreasuryAccount>;
  effectiveDailyCap(agentIdBytes32: Hex): Promise<bigint>;
  /** Sends collectCommission from the operator wallet and waits for the receipt. Returns the tx hash. */
  collectCommission(agentIdBytes32: Hex): Promise<Hex>;
  /** Sends topUp from the operator wallet. nonce is taken from the TopUpRequested log. */
  topUp(agentIdBytes32: Hex, amountUsd6: bigint): Promise<{ txHash: Hex; nonce: bigint | null }>;
}

/** Top-up row id. Deterministic per (agent, nonce), so the treasury and the relayer agree on it. */
export function topupIdFor(agentId: string, nonce: bigint | number): string {
  return `topup-${agentId}-${nonce.toString()}`;
}

export async function findTopup(db: Db, agentId: string, id: string): Promise<TopupRecord | null> {
  const rows = await listTopupsByAgent(db, agentId, 500);
  return rows.find((r) => r.id === id) ?? null;
}

export interface TreasuryOptions {
  db: Db;
  clock: Clock;
  logger?: Logger;
  /** Null disables the treasury. */
  chain: TreasuryChain | null;
  minTopUpUsd: number;
  maxTopUpPerDayUsd: number;
}

export interface Treasury {
  readonly enabled: boolean;
  collectCommissionIfOwed(agent: Agent): Promise<{ amountUsd: number; txHash: Hex } | null>;
  maybeTopUp(agent: Agent, tier: BudgetTier): Promise<{ id: string; amountUsd: number; txHash: Hex } | null>;
}

export function createTreasury(opts: TreasuryOptions): Treasury {
  const logger = opts.logger ?? silentLogger;
  const { chain, db } = opts;

  if (!chain) {
    logger.info("treasury disabled: TREASURY_ADDRESS, PERF_REGISTRY_ADDRESS or OPERATOR_PRIVATE_KEY not set");
    return {
      enabled: false,
      collectCommissionIfOwed: async () => null,
      maybeTopUp: async () => null,
    };
  }

  return {
    enabled: true,

    async collectCommissionIfOwed(agent) {
      const id32 = agentIdToBytes32(agent.id);
      const [owed, account] = await Promise.all([chain.commissionOwed(id32), chain.account(id32)]);
      if (owed <= account.commissionPaid) return null;

      const delta = owed - account.commissionPaid;
      const txHash = await chain.collectCommission(id32);
      const amountUsd = fromUsd6(delta);
      await insertTreasuryEvent(db, {
        agentId: agent.id,
        kind: "commission_collected",
        amountUsd,
        txHash,
        meta: { owedCumulativeUsd6: owed.toString() },
        ts: opts.clock.now(),
      });
      logger.info("commission collected", { agent: agent.id, amountUsd, txHash });
      return { amountUsd, txHash };
    },

    async maybeTopUp(agent, tier) {
      // PRD 6.11.6: low and critical trigger a top-up, and empty waits for one ("paused until a top-up lands").
      if (tier !== "low" && tier !== "critical" && tier !== "empty") return null;
      if (!agent.zgWallet) {
        logger.warn("top-up skipped: agent has no 0G wallet", { agent: agent.id });
        return null;
      }

      const id32 = agentIdToBytes32(agent.id);
      const account = await chain.account(id32);
      const minUsd6 = toUsd6(opts.minTopUpUsd);
      if (account.balance < minUsd6) return null;

      const now = opts.clock.now();
      const dayStart = now - (now % DAY_MS);
      const today = await listTopupsByAgent(db, agent.id, 500);
      const sentTodayUsd6 = today
        .filter((t) => t.ts >= dayStart && t.status !== "failed")
        .reduce<bigint>((sum, t) => sum + toUsd6(t.usdcAmount), 0n);
      const localRemaining = maxBigint(toUsd6(opts.maxTopUpPerDayUsd) - sentTodayUsd6, 0n);

      const contractCap = await chain.effectiveDailyCap(id32);
      const dayIndex = BigInt(Math.floor(now / DAY_MS));
      const contractUsedToday = account.topUpDay === dayIndex ? account.toppedUpToday : 0n;
      const contractRemaining = maxBigint(contractCap - contractUsedToday, 0n);

      const amount = minBigint(account.balance, localRemaining, contractRemaining);
      if (amount < minUsd6) {
        logger.info("top-up skipped: daily cap or balance too low", { agent: agent.id, tier });
        return null;
      }

      const { txHash, nonce } = await chain.topUp(id32, amount);
      if (nonce === null) throw new Error(`topUp tx ${txHash} emitted no TopUpRequested log`);

      const id = topupIdFor(agent.id, nonce);
      const amountUsd = fromUsd6(amount);
      if (!(await findTopup(db, agent.id, id))) {
        await createTopup(db, {
          id,
          agentId: agent.id,
          usdcAmount: amountUsd,
          baseTx: txHash,
          zgTransferTx: null,
          depositTx: null,
          firstPaidRequestId: null,
          status: "requested",
          ts: now,
        });
      }
      await insertTreasuryEvent(db, {
        agentId: agent.id,
        kind: "topup_requested",
        amountUsd,
        txHash,
        meta: { nonce: nonce.toString(), zgWallet: agent.zgWallet, tier },
        ts: now,
      });
      logger.info("top-up requested", { agent: agent.id, amountUsd, nonce: nonce.toString(), txHash });
      return { id, amountUsd, txHash };
    },
  };
}

const maxBigint = (a: bigint, b: bigint) => (a > b ? a : b);
const minBigint = (...xs: bigint[]) => xs.reduce((m, x) => (x < m ? x : m));

/** Viem-backed TreasuryChain. Writes need the operator key. */
export function createViemTreasuryChain(opts: {
  chain: ChainConfig;
  treasury: Hex;
  perfRegistry: Hex;
  operatorPrivateKey: Hex;
}): TreasuryChain {
  const publicClient = createPublicClient({ chain: opts.chain.viemChain, transport: http(opts.chain.rpcUrl) });
  const walletClient = createWalletClient({
    account: privateKeyToAccount(opts.operatorPrivateKey),
    chain: opts.chain.viemChain,
    transport: http(opts.chain.rpcUrl),
  });

  return {
    async commissionOwed(id) {
      return (await publicClient.readContract({
        address: opts.perfRegistry,
        abi: PERFORMANCE_REGISTRY_ABI,
        functionName: "commissionOwedCumulative",
        args: [id],
      })) as bigint;
    },

    async account(id) {
      const a = (await publicClient.readContract({
        address: opts.treasury,
        abi: AGENT_TREASURY_ABI,
        functionName: "getAccount",
        args: [id],
      })) as TreasuryAccount;
      return {
        balance: a.balance,
        commissionPaid: a.commissionPaid,
        topUpDay: a.topUpDay,
        toppedUpToday: a.toppedUpToday,
        topUpNonce: a.topUpNonce,
      };
    },

    async effectiveDailyCap(id) {
      return (await publicClient.readContract({
        address: opts.treasury,
        abi: AGENT_TREASURY_ABI,
        functionName: "effectiveDailyTopUpCap",
        args: [id],
      })) as bigint;
    },

    async collectCommission(id) {
      const txHash = await walletClient.writeContract({
        address: opts.treasury,
        abi: AGENT_TREASURY_ABI,
        functionName: "collectCommission",
        args: [id],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`collectCommission reverted (tx ${txHash})`);
      return txHash;
    },

    async topUp(id, amountUsd6) {
      const txHash = await walletClient.writeContract({
        address: opts.treasury,
        abi: AGENT_TREASURY_ABI,
        functionName: "topUp",
        args: [id, amountUsd6],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`topUp reverted (tx ${txHash})`);
      const [event] = parseEventLogs({ abi: AGENT_TREASURY_ABI, logs: receipt.logs, eventName: "TopUpRequested" });
      const nonce = event ? (event.args as { nonce: bigint }).nonce : null;
      return { txHash, nonce };
    },
  };
}

/** Builds the viem treasury chain from env, or null when any required setting is missing. */
export function treasuryChainFromEnv(env: WorkerEnv, chain: ChainConfig): TreasuryChain | null {
  if (!env.TREASURY_ADDRESS || !env.PERF_REGISTRY_ADDRESS || !env.OPERATOR_PRIVATE_KEY) return null;
  return createViemTreasuryChain({
    chain,
    treasury: env.TREASURY_ADDRESS as Hex,
    perfRegistry: env.PERF_REGISTRY_ADDRESS as Hex,
    operatorPrivateKey: env.OPERATOR_PRIVATE_KEY as Hex,
  });
}
