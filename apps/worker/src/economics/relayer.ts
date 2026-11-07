// Conversion relayer (PRD 6.11.4). Watches AgentTreasury.TopUpRequested on Base, converts the USDC amount
// to 0G at the market rate minus a spread, and deposits it to the agent's 0G wallet through the 0G
// Payment Layer (depositFor). Each request is handled once: the top-up is keyed by (agent, nonce) in the
// database (topups.nonce, unique per agent), and a deposited row is never sent again.

import { createTopupIfAbsent, getTopupByNonce, insertTreasuryEvent, updateTopup, type Db } from "@arena/db";
import { agentIdToBytes32, fromUsd6, type Agent } from "@arena/shared";
import { depositToPaymentLayer, type DepositOptions, type DepositResult } from "@arena/zerog";
import { parseEther, type Hex, type PublicClient } from "viem";
import { readFile, rename, writeFile } from "node:fs/promises";
import { AGENT_TREASURY_ABI } from "../abi.ts";
import type { Clock } from "../deps.ts";
import type { Logger } from "../logger.ts";
import { silentLogger } from "../logger.ts";
import { topupIdFor } from "./treasury.ts";

export const COINGECKO_ZG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=zero-gravity&vs_currencies=usd";
const MAX_BLOCKS_PER_QUERY = 2_000n;
const LOOKBACK_BLOCKS = 1_000n;

export interface TopUpRequest {
  agentIdBytes32: Hex;
  amountUsd6: bigint;
  zgWallet: Hex;
  nonce: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

export interface RelayerChain {
  latestBlock(): Promise<bigint>;
  /** TopUpRequested logs in [fromBlock, toBlock], inclusive. */
  topUpRequests(fromBlock: bigint, toBlock: bigint): Promise<TopUpRequest[]>;
}

export interface CursorStore {
  /** Last fully processed Base block, or null before the first run. */
  read(): Promise<bigint | null>;
  write(block: bigint): Promise<void>;
}

/** Cursor in a JSON file, written atomically (tmp file, then rename). */
export function fileCursorStore(path: string): CursorStore {
  return {
    async read() {
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as { block?: string };
        return raw.block ? BigInt(raw.block) : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(block) {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify({ block: block.toString() }));
      await rename(tmp, path);
    },
  };
}

/** USD price of 0G, or null when unavailable. */
export type ZgPriceSource = () => Promise<number | null>;

export function coingeckoZgUsd(fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init)): ZgPriceSource {
  return async () => {
    try {
      const res = await fetchFn(COINGECKO_ZG_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { "zero-gravity"?: { usd?: unknown } };
      const price = body["zero-gravity"]?.usd;
      return typeof price === "number" && price > 0 ? price : null;
    } catch {
      return null;
    }
  };
}

export function createViemRelayerChain(opts: { client: PublicClient; treasury: Hex }): RelayerChain {
  return {
    latestBlock: () => opts.client.getBlockNumber(),
    async topUpRequests(fromBlock, toBlock) {
      const logs = await opts.client.getContractEvents({
        address: opts.treasury,
        abi: AGENT_TREASURY_ABI,
        eventName: "TopUpRequested",
        fromBlock,
        toBlock,
      });
      return logs.map((log) => {
        const args = log.args as { agentId: Hex; amountUsd6: bigint; zgWallet: Hex; nonce: bigint };
        return {
          agentIdBytes32: args.agentId,
          amountUsd6: args.amountUsd6,
          zgWallet: args.zgWallet,
          nonce: args.nonce,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        };
      });
    },
  };
}

export interface RelayerOptions {
  db: Db;
  clock: Clock;
  logger?: Logger;
  chain: RelayerChain;
  cursor: CursorStore;
  /** Defaults to the Payment Layer deposit in @arena/zerog. Injected for tests. */
  deposit?: (opts: DepositOptions) => Promise<DepositResult>;
  zgPrice: ZgPriceSource;
  /** 0G per USDC when no price is available. Null means no fallback. */
  fallbackZgPerUsdc: number | null;
  spreadBps: number;
  maxRequestUsd: number;
  zg: { rpcUrl: string; privateKey: Hex; network: "mainnet" | "testnet" };
  /**
   * Account credited by depositFor, for every agent. The Router bills the account that owns the API keys (the
   * platform account), so this should be that account. When absent, the agent's own zgWallet is credited.
   */
  depositRecipient?: Hex | null;
  /** Agents to resolve TopUpRequested logs against. */
  agents: () => Promise<Array<Pick<Agent, "id" | "zgWallet">>>;
}

export type RequestOutcome = "deposited" | "skipped" | "rejected" | "failed";

/** Handles one TopUpRequested log. Safe to call repeatedly for the same request. */
export async function processTopUpRequest(
  opts: RelayerOptions,
  req: TopUpRequest,
  agent: Pick<Agent, "id" | "zgWallet">,
): Promise<RequestOutcome> {
  const logger = (opts.logger ?? silentLogger).child({ agent: agent.id, nonce: req.nonce.toString() });
  const id = topupIdFor(agent.id, req.nonce);
  const existing = await getTopupByNonce(opts.db, agent.id, req.nonce);
  const rowId = existing?.id ?? id;
  if (existing?.status === "deposited") return "skipped";
  if (existing?.status === "relaying") {
    logger.warn("top-up already in flight or interrupted; needs manual review", { topup: existing.id });
    return "skipped";
  }
  if (!agent.zgWallet) {
    logger.warn("top-up ignored: agent has no 0G wallet", {});
    return "skipped";
  }

  const usd = fromUsd6(req.amountUsd6);
  const now = opts.clock.now();
  /** Moves this nonce's row to a status, creating it first when the treasury has not recorded it yet. */
  const markRow = async (status: string, depositTx?: string | null) => {
    const patch = { status, ...(depositTx !== undefined ? { depositTx } : {}) };
    if (existing) {
      await updateTopup(opts.db, existing.id, patch);
      return;
    }
    const { topup, created } = await createTopupIfAbsent(opts.db, {
      id,
      agentId: agent.id,
      nonce: req.nonce,
      usdcAmount: usd,
      baseTx: req.txHash,
      depositTx: depositTx ?? null,
      status,
      ts: now,
    });
    if (!created) await updateTopup(opts.db, topup.id, patch);
  };

  if (usd > opts.maxRequestUsd) {
    logger.warn("top-up rejected: above RELAYER_MAX_REQUEST_USD", { usd, max: opts.maxRequestUsd });
    await markRow("rejected");
    return "rejected";
  }

  const zgUsd = await opts.zgPrice();
  const zgPerUsdc = zgUsd !== null ? 1 / zgUsd : opts.fallbackZgPerUsdc;
  if (zgPerUsdc === null || !(zgPerUsdc > 0)) {
    logger.error("top-up failed: no 0G price and no ZG_PER_USDC fallback", {});
    await markRow("failed");
    return "failed";
  }
  const zgAmount = usd * zgPerUsdc * (1 - opts.spreadBps / 10_000);
  const amountWei = parseEther(zgAmount.toFixed(18));
  if (amountWei <= 0n) {
    logger.error("top-up failed: converted amount rounds to zero", { usd });
    await markRow("failed");
    return "failed";
  }

  await markRow("relaying");
  try {
    const deposit = opts.deposit ?? depositToPaymentLayer;
    const res = await deposit({ rpcUrl: opts.zg.rpcUrl, privateKey: opts.zg.privateKey, network: opts.zg.network, amountWei, recipient: opts.depositRecipient ?? agent.zgWallet });
    await updateTopup(opts.db, rowId, { status: "deposited", depositTx: res.txHash });
    await insertTreasuryEvent(opts.db, {
      agentId: agent.id,
      kind: "relayer_deposit",
      amountUsd: usd,
      txHash: res.txHash,
      meta: { zgAmountWei: amountWei.toString(), baseTx: req.txHash, nonce: req.nonce.toString(), recipient: res.recipient },
      ts: opts.clock.now(),
    });
    logger.info("top-up deposited to 0G", { usd, zgAmountWei: amountWei.toString(), depositTx: res.txHash, recipient: res.recipient });
    return "deposited";
  } catch (err) {
    logger.error("0G deposit failed", { topup: rowId, error: err });
    await updateTopup(opts.db, rowId, { status: "failed" });
    return "failed";
  }
}

export interface RelayerRunResult {
  scanned: number;
  deposited: number;
  skipped: number;
  rejected: number;
  failed: number;
  cursor: bigint;
}

/** One pass over new TopUpRequested logs, from the cursor to the chain head. Advances the cursor per chunk. */
export async function runRelayerOnce(opts: RelayerOptions): Promise<RelayerRunResult> {
  const logger = opts.logger ?? silentLogger;
  const head = await opts.chain.latestBlock();
  const stored = await opts.cursor.read();
  let start = stored !== null ? stored + 1n : head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  const result: RelayerRunResult = { scanned: 0, deposited: 0, skipped: 0, rejected: 0, failed: 0, cursor: stored ?? start };
  if (stored === null) logger.info("relayer has no cursor; starting from a recent block", { from: start.toString() });

  const agents = await opts.agents();
  const byBytes = new Map<string, Pick<Agent, "id" | "zgWallet">>();
  for (const a of agents) {
    byBytes.set(agentIdToBytes32(a.id).toLowerCase(), a);
  }

  while (start <= head) {
    const end = start + MAX_BLOCKS_PER_QUERY - 1n < head ? start + MAX_BLOCKS_PER_QUERY - 1n : head;
    const requests = (await opts.chain.topUpRequests(start, end)).sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));
    for (const req of requests) {
      result.scanned += 1;
      const agent = byBytes.get(req.agentIdBytes32.toLowerCase());
      if (!agent) {
        logger.warn("TopUpRequested for an unknown agent", { agentIdBytes32: req.agentIdBytes32 });
        result.skipped += 1;
        continue;
      }
      const outcome = await processTopUpRequest(opts, req, agent);
      result[outcome] += 1;
    }
    await opts.cursor.write(end);
    result.cursor = end;
    start = end + 1n;
  }
  return result;
}
