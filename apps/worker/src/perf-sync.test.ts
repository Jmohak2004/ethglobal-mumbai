// Chunked PerformanceReported scan: chunk boundaries, the persisted cursor, resume after failure, the
// per-agent chunked lookup, and the LOG_CHUNK_BLOCKS setting.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, leaderboard, upsertStats, type Db } from "@arena/db";
import { agentIdToBytes32 } from "@arena/shared";
import type { Hex, PublicClient } from "viem";
import type { CursorStore } from "./economics/relayer.ts";
import { loadWorkerEnv } from "./env.ts";
import { createPerfChain, syncAttestations, type PerfChain, type PerfReading, type ReportLog } from "./stats.ts";
import { memoryDb, NOW, seedAgent } from "./test-fixtures.ts";
import { silentLogger } from "./logger.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ADDRESS = `0x${"00".repeat(19)}01` as Hex;

class MemoryCursor implements CursorStore {
  value: bigint | null = null;
  async read() {
    return this.value;
  }
  async write(block: bigint) {
    this.value = block;
  }
}

function reading(): PerfReading {
  return {
    asOf: BigInt(NOW / 1000),
    realizedPnlUsd6: 0n,
    volumeUsd6: 0n,
    trades: 0,
    winRateBps: 0,
    maxDrawdownBps: 0,
    forecastHitRateBps: 0,
    hwmUsd6: 0n,
    commissionOwedCumulativeUsd6: 0n,
  };
}

/** A PerfChain over a fixed log list. Records every log query and can fail one chunk. */
function scanner(logs: ReportLog[], head: () => bigint, failFrom?: bigint) {
  const calls: Array<[bigint, bigint]> = [];
  const perf: PerfChain = {
    async getPerformance() {
      return reading();
    },
    async latestReport() {
      throw new Error("the cursor path must not query per agent");
    },
    async reportLogs(from, to) {
      calls.push([from, to]);
      if (failFrom !== undefined && from === failFrom) throw new Error("rpc timeout");
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
    async latestBlock() {
      return head();
    },
  };
  return { perf, calls };
}

async function setup() {
  const db = await memoryDb();
  dbs.push(db);
  const a = await seedAgent(db, { name: "agent a" });
  const b = await seedAgent(db, { name: "agent b" });
  await upsertStats(db, [
    { entityId: a.id, kind: "agent", name: "a", template: "momentum", mode: "paper", realizedPnlUsd: 1, realizedPnlPct: 0, volumeUsd: 0, trades: 0, winRateBps: 0, maxDrawdownBps: 0, forecastHitRateBps: 0, daysActive: 0 },
    { entityId: b.id, kind: "agent", name: "b", template: "momentum", mode: "paper", realizedPnlUsd: 2, realizedPnlPct: 0, volumeUsd: 0, trades: 0, winRateBps: 0, maxDrawdownBps: 0, forecastHitRateBps: 0, daysActive: 0 },
  ]);
  return { db, a, b, bytesA: agentIdToBytes32(a.id), bytesB: agentIdToBytes32(b.id) };
}

async function verifiedTx(db: Db, entityId: string) {
  const row = (await leaderboard(db, { kind: "agent", limit: 500 })).find((r) => r.entityId === entityId);
  return row?.verified?.reportTx ?? null;
}

describe("chunked PerformanceReported scan", () => {
  test("scans [0,9], [10,19], [20,25] for head 25 and verifies each agent's latest report", async () => {
    const { db, a, b, bytesA, bytesB } = await setup();
    const logs: ReportLog[] = [
      { agentIdBytes32: bytesA, txHash: H(1), blockNumber: 3n },
      { agentIdBytes32: bytesA, txHash: H(2), blockNumber: 7n },
      { agentIdBytes32: bytesB, txHash: H(3), blockNumber: 12n },
      { agentIdBytes32: bytesA, txHash: H(4), blockNumber: 22n },
    ];
    const { perf, calls } = scanner(logs, () => 25n);
    const cursor = new MemoryCursor();

    const verified = await syncAttestations({ db, perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger });

    expect(calls).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(verified).toBe(3); // A in chunk 1, B in chunk 2, A again in chunk 3
    expect(await verifiedTx(db, a.id)).toBe(H(4));
    expect(await verifiedTx(db, b.id)).toBe(H(3));
    expect(cursor.value).toBe(25n);

    // One attestation per report tx, so each stored tx matches the report it came from.
    const attestations = await db.query.attestations.findMany({ where: (t, { eq }) => eq(t.kind, "perf") });
    expect(attestations.map((t) => t.txHash).sort()).toEqual([H(2), H(3), H(4)].sort());
  });

  test("the next run starts after the stored cursor and only scans new blocks", async () => {
    const { db, b, bytesB, bytesA } = await setup();
    const logs: ReportLog[] = [{ agentIdBytes32: bytesA, txHash: H(1), blockNumber: 3n }];
    let head = 25n;
    const { perf, calls } = scanner(logs, () => head);
    const cursor = new MemoryCursor();
    await syncAttestations({ db, perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger });
    calls.length = 0;

    head = 30n;
    logs.push({ agentIdBytes32: bytesB, txHash: H(5), blockNumber: 28n });
    const verified = await syncAttestations({ db, perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger });

    expect(calls).toEqual([[26n, 30n]]);
    expect(verified).toBe(1);
    expect(await verifiedTx(db, b.id)).toBe(H(5));
    expect(cursor.value).toBe(30n);
  });

  test("a failed chunk leaves the cursor at the last good block, so the rest is retried", async () => {
    const { db, a, bytesA } = await setup();
    const logs: ReportLog[] = [
      { agentIdBytes32: bytesA, txHash: H(1), blockNumber: 3n },
      { agentIdBytes32: bytesA, txHash: H(2), blockNumber: 15n },
    ];
    const cursor = new MemoryCursor();
    const failing = scanner(logs, () => 25n, 10n);
    await expect(
      syncAttestations({ db, perf: failing.perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger }),
    ).rejects.toThrow("rpc timeout");
    expect(cursor.value).toBe(9n);
    expect(await verifiedTx(db, a.id)).toBe(H(1));

    const retry = scanner(logs, () => 25n);
    await syncAttestations({ db, perf: retry.perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger });
    expect(retry.calls).toEqual([
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(await verifiedTx(db, a.id)).toBe(H(2));
  });

  test("a report for an agent this database does not know is skipped", async () => {
    const { db } = await setup();
    const stranger = agentIdToBytes32("not-a-known-agent");
    const logs: ReportLog[] = [{ agentIdBytes32: stranger, txHash: H(9), blockNumber: 2n }];
    const { perf } = scanner(logs, () => 5n);
    const cursor = new MemoryCursor();
    expect(await syncAttestations({ db, perf, cursor, fromBlock: 0n, chunkBlocks: 10, logger: silentLogger })).toBe(0);
    expect(cursor.value).toBe(5n);
  });
});

describe("createPerfChain chunked lookup", () => {
  test("latestReport walks the range in chunks and returns the newest log for the agent", async () => {
    const { bytesA, bytesB } = await setup();
    const logs = [
      { agentId: bytesA, tx: H(1), block: 3n },
      { agentId: bytesA, tx: H(4), block: 22n },
      { agentId: bytesB, tx: H(3), block: 12n },
    ];
    const ranges: Array<[bigint, bigint]> = [];
    const client = {
      async getBlockNumber() {
        return 25n;
      },
      async getContractEvents(p: { fromBlock: bigint; toBlock: bigint; args?: { agentId: Hex } }) {
        ranges.push([p.fromBlock, p.toBlock]);
        return logs
          .filter((l) => l.block >= p.fromBlock && l.block <= p.toBlock && (!p.args || l.agentId === p.args.agentId))
          .map((l) => ({ transactionHash: l.tx, blockNumber: l.block, args: { agentId: l.agentId } }));
      },
    } as unknown as PublicClient;

    const chain = createPerfChain({ client, address: ADDRESS, fromBlock: 0n, chunkBlocks: 10 });
    const latest = await chain.latestReport(bytesA);
    expect(latest).toEqual({ txHash: H(4), blockNumber: 22n });
    expect(ranges).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);

    const page = await chain.reportLogs!(10n, 19n);
    expect(page.map((l) => l.agentIdBytes32)).toEqual([bytesB]);
    expect(await chain.latestBlock!()).toBe(25n);
  });
});

describe("worker env for the log scan", () => {
  test("LOG_CHUNK_BLOCKS defaults to 2000 and must be positive", () => {
    expect(loadWorkerEnv({}).LOG_CHUNK_BLOCKS).toBe(2000);
    expect(loadWorkerEnv({ LOG_CHUNK_BLOCKS: "500" }).LOG_CHUNK_BLOCKS).toBe(500);
    expect(() => loadWorkerEnv({ LOG_CHUNK_BLOCKS: "0" })).toThrow();
  });

  test("RELAYER_PRIVATE_KEY is no longer parsed, since nothing used it", () => {
    const env = loadWorkerEnv({ RELAYER_PRIVATE_KEY: `0x${"ab".repeat(32)}` });
    expect("RELAYER_PRIVATE_KEY" in env).toBe(false);
  });
});
