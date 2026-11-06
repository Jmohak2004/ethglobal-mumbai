import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, listTopupsByAgent, type Db } from "@arena/db";
import { agentIdToBytes32 } from "@arena/shared";
import { formatEther, type Hex } from "viem";
import type { DepositOptions, DepositResult } from "@arena/zerog";
import { memoryDb, seedAgent, fixedClock } from "../test-fixtures.ts";
import { processTopUpRequest, runRelayerOnce, type CursorStore, type RelayerChain, type TopUpRequest } from "./relayer.ts";
import { createTreasury, topupIdFor, type TreasuryAccount, type TreasuryChain } from "./treasury.ts";
import { silentLogger } from "../logger.ts";

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

class FakeRelayerChain implements RelayerChain {
  constructor(
    public head: bigint,
    public logs: TopUpRequest[],
  ) {}
  async latestBlock() {
    return this.head;
  }
  async topUpRequests(from: bigint, to: bigint) {
    return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }
}

async function relayerFixture(opts: { amountUsd6?: bigint; deposit?: (o: DepositOptions) => Promise<DepositResult> } = {}) {
  const db = await memoryDb();
  dbs.push(db);
  const agent = await seedAgent(db, { zgWallet: ZG_WALLET });
  const request: TopUpRequest = {
    agentIdBytes32: agentIdToBytes32(agent.id),
    amountUsd6: opts.amountUsd6 ?? 500_000n,
    zgWallet: ZG_WALLET,
    nonce: 1n,
    txHash: hash("ab"),
    blockNumber: 105n,
  };
  const deposits: DepositOptions[] = [];
  const cursor = new MemoryCursor();
  const chain = new FakeRelayerChain(110n, [request]);
  const runOpts = {
    db,
    clock: fixedClock(),
    logger: silentLogger,
    chain,
    cursor,
    deposit:
      opts.deposit ??
      (async (o: DepositOptions) => {
        deposits.push(o);
        return { txHash: hash("cd"), blockNumber: 1, recipient: o.recipient ?? "" };
      }),
    zgPrice: async () => 0.5,
    fallbackZgPerUsdc: null,
    spreadBps: 100,
    maxRequestUsd: 2,
    zg: { rpcUrl: "https://zg.test", privateKey: hash("11"), network: "testnet" as const },
    agents: async () => [agent],
  };
  return { db, agent, request, deposits, cursor, chain, runOpts };
}

describe("relayer", () => {
  test("converts USDC to 0G at the spot rate minus the spread and deposits to the agent's 0G wallet", async () => {
    const { db, agent, deposits, runOpts } = await relayerFixture();
    const res = await runRelayerOnce(runOpts);
    expect(res.deposited).toBe(1);
    expect(deposits).toHaveLength(1);
    // $0.50 at $0.50 per 0G is 1 0G, minus 1%.
    expect(Number(formatEther(deposits[0]?.amountWei ?? 0n))).toBeCloseTo(0.99, 9);
    expect(deposits[0]?.recipient).toBe(ZG_WALLET);
    expect(deposits[0]?.network).toBe("testnet");

    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(topupIdFor(agent.id, 1n));
    expect(rows[0]?.status).toBe("deposited");
    expect(rows[0]?.depositTx).toBe(hash("cd"));
  });

  test("replaying the same TopUpRequested nonce never deposits twice", async () => {
    const { deposits, runOpts, cursor, chain, request, agent, db } = await relayerFixture();
    await runRelayerOnce(runOpts);
    // Replay: the cursor is lost and the same log comes back.
    cursor.value = null;
    chain.logs = [request, { ...request, txHash: hash("ee") }];
    const again = await runRelayerOnce(runOpts);
    expect(again.deposited).toBe(0);
    expect(again.skipped).toBe(2);
    expect(deposits).toHaveLength(1);
    expect(await listTopupsByAgent(db, agent.id)).toHaveLength(1);
  });

  test("the cursor advances to the head, so the next pass scans nothing new", async () => {
    const { runOpts, cursor } = await relayerFixture();
    await runRelayerOnce(runOpts);
    expect(cursor.value).toBe(110n);
    const next = await runRelayerOnce(runOpts);
    expect(next.scanned).toBe(0);
  });

  test("a request above RELAYER_MAX_REQUEST_USD is rejected and never deposited", async () => {
    const { db, agent, deposits, runOpts } = await relayerFixture({ amountUsd6: 5_000_000n });
    const res = await runRelayerOnce(runOpts);
    expect(res.rejected).toBe(1);
    expect(deposits).toHaveLength(0);
    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows[0]?.status).toBe("rejected");
  });

  test("a failed deposit is recorded as failed", async () => {
    const { db, agent, runOpts } = await relayerFixture({
      deposit: async () => {
        throw new Error("rpc down");
      },
    });
    const res = await runRelayerOnce(runOpts);
    expect(res.failed).toBe(1);
    expect((await listTopupsByAgent(db, agent.id))[0]?.status).toBe("failed");
  });

  test("a request for an unknown agent is skipped", async () => {
    const { runOpts, request, chain, deposits } = await relayerFixture();
    chain.logs = [{ ...request, agentIdBytes32: hash("99") }];
    const res = await runRelayerOnce({ ...runOpts, agents: async () => [] });
    expect(res.skipped).toBe(1);
    expect(deposits).toHaveLength(0);
  });

  test("with no price and no fallback, nothing is deposited", async () => {
    const { db, agent, request, deposits, runOpts } = await relayerFixture();
    const outcome = await processTopUpRequest(
      { ...runOpts, zgPrice: async () => null, fallbackZgPerUsdc: null },
      request,
      agent,
    );
    expect(outcome).toBe("failed");
    expect(deposits).toHaveLength(0);
    expect((await listTopupsByAgent(db, agent.id))[0]?.status).toBe("failed");
  });
});

class FakeTreasuryChain implements TreasuryChain {
  owed = 0n;
  state: TreasuryAccount = { balance: 5_000_000n, commissionPaid: 0n, topUpDay: 0n, toppedUpToday: 0n, topUpNonce: 0n };
  cap = 10_000_000n;
  topUps: bigint[] = [];
  collects = 0;
  private nonce = 0n;

  async commissionOwed(): Promise<bigint> {
    return this.owed;
  }
  async account(): Promise<TreasuryAccount> {
    return this.state;
  }
  async effectiveDailyCap(): Promise<bigint> {
    return this.cap;
  }
  async collectCommission(): Promise<Hex> {
    this.collects += 1;
    return hash("c0");
  }
  async topUp(_id: Hex, amount: bigint): Promise<{ txHash: Hex; nonce: bigint }> {
    this.topUps.push(amount);
    this.nonce += 1n;
    return { txHash: hash("b0"), nonce: this.nonce };
  }
}

describe("treasury", () => {
  test("is disabled cleanly when no chain is configured", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db, { zgWallet: ZG_WALLET });
    const treasury = createTreasury({ db, clock: fixedClock(), chain: null, minTopUpUsd: 0.5, maxTopUpPerDayUsd: 2 });
    expect(treasury.enabled).toBe(false);
    expect(await treasury.maybeTopUp(agent, "critical")).toBeNull();
    expect(await treasury.collectCommissionIfOwed(agent)).toBeNull();
  });

  test("tops up up to the per-day cap, once", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db, { zgWallet: ZG_WALLET });
    const chain = new FakeTreasuryChain();
    const treasury = createTreasury({ db, clock: fixedClock(), chain, minTopUpUsd: 0.5, maxTopUpPerDayUsd: 2 });

    expect(await treasury.maybeTopUp(agent, "healthy")).toBeNull();
    const first = await treasury.maybeTopUp(agent, "empty");
    expect(first?.amountUsd).toBe(2); // capped by MAX_TOPUP_PER_DAY_USD, not the $5 balance
    expect(chain.topUps).toEqual([2_000_000n]);

    const rows = await listTopupsByAgent(db, agent.id);
    expect(rows[0]?.id).toBe(topupIdFor(agent.id, 1n));
    expect(rows[0]?.status).toBe("requested");
    expect(rows[0]?.baseTx).toBe(hash("b0"));

    // Same day, cap spent: nothing more is requested.
    expect(await treasury.maybeTopUp(agent, "low")).toBeNull();
    expect(chain.topUps).toHaveLength(1);
  });

  test("collects only the commission that is newly owed", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db, { zgWallet: ZG_WALLET });
    const chain = new FakeTreasuryChain();
    chain.owed = 3_000_000n;
    chain.state = { ...chain.state, commissionPaid: 1_000_000n };
    const treasury = createTreasury({ db, clock: fixedClock(), chain, minTopUpUsd: 0.5, maxTopUpPerDayUsd: 2 });

    const res = await treasury.collectCommissionIfOwed(agent);
    expect(res?.amountUsd).toBe(2);
    expect(chain.collects).toBe(1);

    chain.state = { ...chain.state, commissionPaid: 3_000_000n };
    expect(await treasury.collectCommissionIfOwed(agent)).toBeNull();
    expect(chain.collects).toBe(1);
  });
});
