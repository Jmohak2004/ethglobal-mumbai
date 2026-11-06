// Relayer idempotency keyed on the database nonce (topups.nonce, unique per agent). The treasury and the
// relayer both write the top-up for a nonce, in either order, and a nonce is only ever relayed once.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, listTopupsByAgent, getTopupByNonce, type Db } from "@arena/db";
import { agentIdToBytes32 } from "@arena/shared";
import type { Hex } from "viem";
import type { DepositOptions, DepositResult } from "@arena/zerog";
import { fixedClock, memoryDb, seedAgent } from "../test-fixtures.ts";
import { silentLogger } from "../logger.ts";
import { processTopUpRequest, runRelayerOnce, type CursorStore, type RelayerChain, type RelayerOptions, type TopUpRequest } from "./relayer.ts";
import { createTreasury, topupIdFor, type TreasuryAccount, type TreasuryChain } from "./treasury.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const ZG_WALLET = "0x2222222222222222222222222222222222222222" as const;
const hash = (c: string): Hex => `0x${c.repeat(32)}`;

class MemoryCursor implements CursorStore {
  value: bigint | null = null;
  async read() {
    return this.value;
  }
  async write(block: bigint) {
    this.value = block;
  }
}

class FixedChain implements RelayerChain {
  constructor(public logs: TopUpRequest[]) {}
  async latestBlock() {
    return 110n;
  }
  async topUpRequests(from: bigint, to: bigint) {
    return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }
}

/** Treasury chain whose topUp always emits the given nonce. */
class TreasuryWithNonce implements TreasuryChain {
  constructor(private readonly nonce: bigint) {}
  async commissionOwed(): Promise<bigint> {
    return 0n;
  }
  async account(): Promise<TreasuryAccount> {
    return { balance: 5_000_000n, commissionPaid: 0n, topUpDay: 0n, toppedUpToday: 0n, topUpNonce: 0n };
  }
  async effectiveDailyCap(): Promise<bigint> {
    return 10_000_000n;
  }
  async collectCommission(): Promise<Hex> {
    return hash("c0");
  }
  async topUp(): Promise<{ txHash: Hex; nonce: bigint }> {
    return { txHash: hash("b0"), nonce: this.nonce };
  }
}

async function fixture(nonce = 1n) {
  const db = await memoryDb();
  dbs.push(db);
  const agent = await seedAgent(db, { zgWallet: ZG_WALLET });
  const request: TopUpRequest = {
    agentIdBytes32: agentIdToBytes32(agent.id),
    amountUsd6: 2_000_000n,
    zgWallet: ZG_WALLET,
    nonce,
    txHash: hash("ab"),
    blockNumber: 105n,
  };
  const deposits: DepositOptions[] = [];
  const cursor = new MemoryCursor();
  const chain = new FixedChain([request]);
  const opts: RelayerOptions = {
    db,
    clock: fixedClock(),
    logger: silentLogger,
    chain,
    cursor,
    deposit: async (o: DepositOptions): Promise<DepositResult> => {
      deposits.push(o);
      return { txHash: hash("cd"), blockNumber: 1, recipient: o.recipient ?? "" };
    },
    zgPrice: async () => 0.5,
    fallbackZgPerUsdc: null,
    spreadBps: 100,
    maxRequestUsd: 2,
    zg: { rpcUrl: "https://zg.test", privateKey: hash("11"), network: "testnet" as const },
    agents: async () => [agent],
  };
  return { db, agent, request, chain, cursor, deposits, opts };
}

describe("relayer keyed on the database nonce", () => {
  test("a top-up the treasury recorded first is picked up by the relayer, not duplicated", async () => {
    const { db, agent, opts, deposits } = await fixture(1n);
    const treasury = createTreasury({ db, clock: fixedClock(), chain: new TreasuryWithNonce(1n), minTopUpUsd: 0.5, maxTopUpPerDayUsd: 2 });
    const requested = await treasury.maybeTopUp(agent, "empty");
    expect(requested?.id).toBe(topupIdFor(agent.id, 1n));

    const res = await runRelayerOnce(opts);
    expect(res.deposited).toBe(1);
    expect(deposits).toHaveLength(1);

    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nonce).toBe("1");
    expect(rows[0]?.status).toBe("deposited");
    expect(rows[0]?.depositTx).toBe(hash("cd"));
  });

  test("a relayer deposit is not overwritten when the treasury records the same nonce afterwards", async () => {
    const { db, agent, opts } = await fixture(7n);
    await runRelayerOnce(opts);
    const treasury = createTreasury({ db, clock: fixedClock(), chain: new TreasuryWithNonce(7n), minTopUpUsd: 0.5, maxTopUpPerDayUsd: 2 });
    await treasury.maybeTopUp(agent, "low");

    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("deposited");
    expect((await getTopupByNonce(db, agent.id, 7n))?.depositTx).toBe(hash("cd"));
  });

  test("the same nonce arriving again under a different log never deposits twice", async () => {
    const { db, agent, request, chain, cursor, deposits, opts } = await fixture(3n);
    await runRelayerOnce(opts);
    cursor.value = null;
    chain.logs = [request, { ...request, txHash: hash("ee") }];
    const again = await runRelayerOnce(opts);
    expect(again.deposited).toBe(0);
    expect(deposits).toHaveLength(1);
    expect(await listTopupsByAgent(db, agent.id)).toHaveLength(1);
  });

  test("a failed top-up can be retried by the same nonce", async () => {
    const { db, agent, request, opts } = await fixture(4n);
    const failing = { ...opts, deposit: async () => { throw new Error("rpc down"); } };
    const first = await processTopUpRequest(failing, request, agent);
    expect(first).toBe("failed");
    const retry = await processTopUpRequest(opts, request, agent);
    expect(retry).toBe("deposited");
    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("deposited");
  });
});
