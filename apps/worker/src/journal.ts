// Paper trade journal (Base Sepolia). Paper fills never touch a chain, so the operator records each one in the
// TradeJournal contract. The queue is the database: a paper fill whose tx_id is null is still unjournaled. Nothing
// is held in memory, so fills from before the journal existed and fills from before a restart are picked up.
// Disabled cleanly when TRADE_JOURNAL_ADDRESS (or OPERATOR_PRIVATE_KEY) is unset.

import { listUnjournaledPaperFills, setFillTxId, type Db, type UnjournaledPaperFill } from "@arena/db";
import { agentIdToBytes32, toUsd6 } from "@arena/shared";
import { createPublicClient, createWalletClient, http, isAddress, keccak256, parseUnits, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { TRADE_JOURNAL_ABI } from "./abi.ts";
import type { WorkerEnv } from "./env.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

/** Fills per record() call. The contract takes any size; this keeps each tx small and the receipts quick. */
export const JOURNAL_BATCH_SIZE = 20;
/** Batches per pass. A pass lists at most JOURNAL_BATCH_SIZE x this many fills. */
export const JOURNAL_MAX_BATCHES = 10;

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

/** One TradeJournal.Trade, in the units the contract takes. */
export interface JournalTrade {
  agentId: Hex;
  funder: Hex;
  fillId: Hex;
  asset: string;
  /** 0 = buy, 1 = sell. */
  side: number;
  notionalUsd6: bigint;
  priceUsd18: bigint;
  quoteIdHash: Hex;
  paper: boolean;
  /** Unix milliseconds, the same unit as fills.ts. */
  ts: bigint;
}

/** The TradeJournal calls the worker makes. The operator key is the contract's recorder. */
export interface JournalChain {
  /** Sends record(trades) from the operator wallet and waits for the receipt. Throws when the tx reverts. */
  record(trades: JournalTrade[]): Promise<Hex>;
  /** True when the fill was already journaled onchain. */
  isRecorded(fillId: Hex): Promise<boolean>;
}

/** Onchain fill id: keccak256 of the offchain fills.id. */
export function journalFillId(fillRowId: string): Hex {
  return keccak256(toBytes(fillRowId));
}

/** The TradeJournal.Trade for one unjournaled paper fill. Human manual fills use agentId = 0 and their own funder. */
export function journalTradeFor(row: UnjournaledPaperFill): JournalTrade {
  return {
    agentId: row.agentId ? agentIdToBytes32(row.agentId) : ZERO_BYTES32,
    funder: isAddress(row.funderAddress) ? (row.funderAddress.toLowerCase() as Hex) : ZERO_ADDRESS,
    fillId: journalFillId(row.fill.id),
    asset: row.asset,
    side: row.side === "sell" ? 1 : 0,
    notionalUsd6: toUsd6(row.fill.notionalUsd),
    priceUsd18: parseUnits(row.fill.price.toFixed(18), 18),
    quoteIdHash: row.quoteId ? keccak256(toBytes(row.quoteId)) : ZERO_BYTES32,
    paper: true,
    ts: BigInt(Math.round(row.fill.ts)),
  };
}

export interface JournalPassOptions {
  db: Db;
  chain: JournalChain;
  logger?: Logger;
  batchSize?: number;
  maxBatches?: number;
}

export interface JournalPassResult {
  /** Unjournaled paper fills read in this pass. */
  listed: number;
  /** Fills whose tx hash was stored. */
  journaled: number;
  /** Fills that were already journaled onchain but had no tx hash in the database. They are left unjournaled. */
  alreadyOnchain: number;
  txHashes: Hex[];
}

/**
 * One journal pass: unjournaled paper fills, oldest first, in batches of at most batchSize per record() call. Each
 * confirmed batch stores its tx hash on its fills before the next batch is sent. A failed call throws and the rest
 * of the pass is skipped, so the same fills are retried next pass.
 */
export async function runJournalPass(opts: JournalPassOptions): Promise<JournalPassResult> {
  const log = opts.logger ?? silentLogger;
  const batchSize = opts.batchSize ?? JOURNAL_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? JOURNAL_MAX_BATCHES;
  const pending = await listUnjournaledPaperFills(opts.db, batchSize * maxBatches);
  const result: JournalPassResult = { listed: pending.length, journaled: 0, alreadyOnchain: 0, txHashes: [] };

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const checked = await Promise.all(batch.map((row) => opts.chain.isRecorded(journalFillId(row.fill.id))));
    const rows: UnjournaledPaperFill[] = [];
    const trades: JournalTrade[] = [];
    batch.forEach((row, n) => {
      if (checked[n]) {
        result.alreadyOnchain++;
        log.warn("paper fill already journaled onchain; tx hash not stored", { fillId: row.fill.id });
        return;
      }
      rows.push(row);
      trades.push(journalTradeFor(row));
    });
    if (trades.length === 0) continue;

    const txHash = await opts.chain.record(trades);
    const stored = await setFillTxId(opts.db, rows.map((r) => r.fill.id), txHash);
    result.journaled += stored;
    result.txHashes.push(txHash);
    log.info("paper trades journaled", { txHash, fills: stored, chain: "baseSepolia" });
  }
  return result;
}

export interface JournalRunnerOptions {
  db: Db;
  /** Null when the journal is not configured. run() then does nothing. */
  chain: JournalChain | null;
  logger?: Logger;
  batchSize?: number;
  maxBatches?: number;
}

/** Runs journal passes. A pass never starts while one is still running (a tx can take longer than the interval). */
export function createJournalRunner(opts: JournalRunnerOptions): { run(): Promise<JournalPassResult | null> } {
  const log = opts.logger ?? silentLogger;
  if (!opts.chain) {
    log.info("trade journal disabled: TRADE_JOURNAL_ADDRESS or OPERATOR_PRIVATE_KEY is not set");
  }
  let running = false;
  return {
    async run() {
      if (!opts.chain || running) return null;
      running = true;
      try {
        const result = await runJournalPass({ ...opts, chain: opts.chain, logger: log });
        return result;
      } finally {
        running = false;
      }
    },
  };
}

/** Viem-backed JournalChain on Base Sepolia. Writes are sent from the operator key, which must be the recorder. */
export function createViemJournalChain(opts: { rpcUrl: string; address: Hex; operatorKey: Hex }): JournalChain {
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(opts.operatorKey), chain: baseSepolia, transport });
  return {
    async record(trades) {
      const hash = await wallet.writeContract({ address: opts.address, abi: TRADE_JOURNAL_ABI, functionName: "record", args: [trades] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`TradeJournal.record reverted (tx ${hash})`);
      return hash;
    },
    async isRecorded(fillId) {
      return (await publicClient.readContract({
        address: opts.address,
        abi: TRADE_JOURNAL_ABI,
        functionName: "recorded",
        args: [fillId],
      })) as boolean;
    },
  };
}

/** The journal chain from env, or null when TRADE_JOURNAL_ADDRESS or OPERATOR_PRIVATE_KEY is unset. */
export function journalChainFromEnv(env: Pick<WorkerEnv, "TRADE_JOURNAL_ADDRESS" | "OPERATOR_PRIVATE_KEY" | "BASE_SEPOLIA_RPC_URL">): JournalChain | null {
  if (!env.TRADE_JOURNAL_ADDRESS || !env.OPERATOR_PRIVATE_KEY) return null;
  return createViemJournalChain({
    rpcUrl: env.BASE_SEPOLIA_RPC_URL,
    address: env.TRADE_JOURNAL_ADDRESS as Hex,
    operatorKey: env.OPERATOR_PRIVATE_KEY as Hex,
  });
}
