import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertFills, insertPaperFill, listUnjournaledPaperFills, upsertOrder, type Db } from "@arena/db";
import { agentIdToBytes32 } from "@arena/shared";
import { keccak256, toBytes, type Hex } from "viem";
import { createJournalRunner, journalChainFromEnv, journalFillId, journalTradeFor, runJournalPass, type JournalChain, type JournalTrade } from "./journal.ts";
import { loadWorkerEnv } from "./env.ts";
import { silentLogger } from "./logger.ts";
import { memoryDb, seedAgent, seedPaperFill, NOW } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

const WALLET = "0x00000000000000000000000000000000000000Dd";
const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** In-memory JournalChain: records every call, and knows which fills are already onchain. */
function fakeJournal(opts: { alreadyOnchain?: Hex[]; failCalls?: number } = {}) {
  const calls: JournalTrade[][] = [];
  const recorded = new Set<Hex>(opts.alreadyOnchain ?? []);
  let failures = opts.failCalls ?? 0;
  const chain: JournalChain & { calls: JournalTrade[][]; recorded: Set<Hex> } = {
    calls,
    recorded,
    async record(trades) {
      if (failures > 0) {
        failures--;
        throw new Error("rpc unavailable");
      }
      calls.push(trades);
      for (const t of trades) recorded.add(t.fillId);
      return txHash(calls.length);
    },
    async isRecorded(fillId) {
      return recorded.has(fillId);
    },
  };
  return chain;
}

describe("journalTradeFor", () => {
  test("maps an agent sell with a quote into the contract units", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { tradingWallet: "0x00000000000000000000000000000000000000Ab" });
    await seedPaperFill(db, agent, { id: "paper-quote-1", side: "sell", qty: 0.5, price: 2000.25, ts: NOW });
    const [row] = await listUnjournaledPaperFills(db);
    // seedPaperFill stores no quote id, so the quote hash is zero here.
    const trade = journalTradeFor({ ...row!, quoteId: "quote-abc" });

    expect(trade.agentId).toBe(agentIdToBytes32(agent.id));
    expect(trade.funder).toBe(agent.tradingWallet.toLowerCase() as Hex);
    expect(trade.fillId).toBe(keccak256(toBytes("paper-quote-1:fill")));
    expect(trade.side).toBe(1);
    expect(trade.asset).toBe("WETH");
    expect(trade.notionalUsd6).toBe(1_000_125_000n);
    expect(trade.priceUsd18).toBe(2000250000000000000000n);
    expect(trade.quoteIdHash).toBe(keccak256(toBytes("quote-abc")));
    expect(trade.paper).toBe(true);
    expect(trade.ts).toBe(BigInt(NOW));
  });

  test("human manual fills use bytes32(0) and their own funder; no quote gives a zero quote hash", async () => {
    const db = await freshDb();
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "cbBTC", orderType: "market", notionalUsd: 10, priceUsd: 60000, feeUsd: 0, integratorFeeUsd: 0, ts: 7 });
    const [row] = await listUnjournaledPaperFills(db);
    const trade = journalTradeFor(row!);
    expect(trade.agentId).toBe(`0x${"0".repeat(64)}`);
    expect(trade.funder).toBe(WALLET.toLowerCase() as Hex);
    expect(trade.side).toBe(0);
    expect(trade.quoteIdHash).toBe(`0x${"0".repeat(64)}`);
    expect(trade.ts).toBe(7n);
  });
});

describe("runJournalPass", () => {
  test("journals oldest first, at most 20 fills per record call, and stores the tx hash on every fill", async () => {
    const db = await freshDb();
    for (let i = 0; i < 45; i++) {
      await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1_000 + i });
    }
    const chain = fakeJournal();
    const result = await runJournalPass({ db, chain, logger: silentLogger });

    expect(chain.calls.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(result).toMatchObject({ listed: 45, journaled: 45, alreadyOnchain: 0, txHashes: [txHash(1), txHash(2), txHash(3)] });
    // The first call holds the 20 oldest fills.
    expect(chain.calls[0]?.[0]?.ts).toBe(1_000n);
    expect(chain.calls[1]?.[0]?.ts).toBe(1_020n);
    expect(await listUnjournaledPaperFills(db)).toEqual([]);
  });

  test("backfills existing paper fills from agents and humans, and never sends live fills", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-old-agent", side: "buy", qty: 1, price: 2000, ts: 500 });
    await insertPaperFill(db, { funderAddress: WALLET, side: "sell", asset: "WETH", orderType: "market", notionalUsd: 2, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 600 });
    // A live Flash fill with no journal tx is not a paper fill and must be skipped.
    await upsertOrder(db, {
      id: "flash-live-journal",
      agentId: null,
      funderAddress: WALLET,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 1,
      status: "ORDER_STATUS_FILLED",
      raw: { paper: false },
      createdAt: 700,
      updatedAt: 700,
    });
    await insertFills(db, [{ id: "flash-live-journal:fill", orderId: "flash-live-journal", price: 2000, qty: 0.0005, notionalUsd: 1, feeUsd: 0, integratorFeeUsd: 0, txId: null, ts: 700 }]);

    const chain = fakeJournal();
    const result = await runJournalPass({ db, chain, logger: silentLogger });
    expect(result.journaled).toBe(2);
    expect(result.listed).toBe(2);
    expect(chain.calls[0]?.map((t) => t.agentId)).toEqual([agentIdToBytes32(agent.id), `0x${"0".repeat(64)}`]);
  });

  test("a fill that is already onchain is not sent again and keeps no tx hash", async () => {
    const db = await freshDb();
    const a = await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1 });
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 2 });
    const chain = fakeJournal({ alreadyOnchain: [journalFillId(a.fillId)] });

    const result = await runJournalPass({ db, chain, logger: silentLogger });
    expect(result).toMatchObject({ journaled: 1, alreadyOnchain: 1 });
    expect(chain.calls[0]).toHaveLength(1);
    expect((await listUnjournaledPaperFills(db)).map((r) => r.fill.id)).toEqual([a.fillId]);
  });

  test("a second pass with nothing pending sends nothing", async () => {
    const db = await freshDb();
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1 });
    const chain = fakeJournal();
    await runJournalPass({ db, chain, logger: silentLogger });
    const again = await runJournalPass({ db, chain, logger: silentLogger });
    expect(again).toEqual({ listed: 0, journaled: 0, alreadyOnchain: 0, txHashes: [] });
    expect(chain.calls).toHaveLength(1);
  });

  test("a failed record call throws, stores nothing, and the next pass retries the same fills", async () => {
    const db = await freshDb();
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1 });
    const chain = fakeJournal({ failCalls: 1 });

    await expect(runJournalPass({ db, chain, logger: silentLogger })).rejects.toThrow("rpc unavailable");
    expect(await listUnjournaledPaperFills(db)).toHaveLength(1);

    const retry = await runJournalPass({ db, chain, logger: silentLogger });
    expect(retry.journaled).toBe(1);
  });

  test("with no paper fills pending the pass makes no calls at all", async () => {
    const db = await freshDb();
    const chain = fakeJournal();
    expect(await runJournalPass({ db, chain, logger: silentLogger })).toEqual({ listed: 0, journaled: 0, alreadyOnchain: 0, txHashes: [] });
    expect(chain.calls).toHaveLength(0);
  });
});

describe("createJournalRunner", () => {
  test("is a no-op when the journal is not configured", async () => {
    const db = await freshDb();
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1 });
    const runner = createJournalRunner({ db, chain: null, logger: silentLogger });
    expect(await runner.run()).toBeNull();
    expect(await listUnjournaledPaperFills(db)).toHaveLength(1);
  });

  test("does not start a pass while one is running", async () => {
    const db = await freshDb();
    await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1 });
    const inner = fakeJournal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: JournalChain = {
      isRecorded: (id) => inner.isRecorded(id),
      record: async (trades) => {
        await gate;
        return inner.record(trades);
      },
    };
    const runner = createJournalRunner({ db, chain: slow, logger: silentLogger });
    const first = runner.run();
    expect(await runner.run()).toBeNull();
    release();
    expect((await first)?.journaled).toBe(1);
  });
});

describe("journalChainFromEnv", () => {
  test("is null unless TRADE_JOURNAL_ADDRESS and OPERATOR_PRIVATE_KEY are both set", () => {
    const base = loadWorkerEnv({});
    expect(journalChainFromEnv(base)).toBeNull();
    expect(journalChainFromEnv({ ...base, TRADE_JOURNAL_ADDRESS: "0x8514850997B6eAbd6ACBfB8feD0D637d5a76EBe0" })).toBeNull();
    const withKey = journalChainFromEnv({
      ...base,
      TRADE_JOURNAL_ADDRESS: "0x8514850997B6eAbd6ACBfB8feD0D637d5a76EBe0",
      OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    });
    expect(withKey).not.toBeNull();
  });
});
