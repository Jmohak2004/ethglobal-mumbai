import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, getAgentRuntime, paperLedgerTotals, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { afterTick, isPaperAgent } from "./index.ts";
import { loadWorkerEnv } from "./env.ts";
import { silentLogger } from "./logger.ts";
import { createRuntime } from "./runtime.ts";
import type { TickResult } from "./tick.ts";
import { fixedClock, memoryDb, NOW, seedAgent, seedPaperFill } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

const resultFor = (agent: Agent, budgetTier: TickResult["budgetTier"]): TickResult => ({
  agentId: agent.id,
  requestId: "req",
  episode: null,
  skipped: null,
  orderId: null,
  mode: null,
  budgetTier,
  sold: false,
  error: null,
});

/** A round trip of +100 realized, as paper fills. */
async function seedProfitableClose(db: Db, agent: Agent): Promise<void> {
  await seedPaperFill(db, agent, { id: "rt-buy", side: "buy", qty: 1, price: 2000, ts: NOW });
  await seedPaperFill(db, agent, { id: "rt-sell", side: "sell", qty: 1, price: 2100, ts: NOW + 1 });
}

describe("isPaperAgent", () => {
  test("the platform mode decides unless both platform and agent are live", () => {
    const paperAgent = { mode: "paper" } as Agent;
    const liveAgent = { mode: "live" } as Agent;
    expect(isPaperAgent({ executionMode: "paper" }, liveAgent)).toBe(true);
    expect(isPaperAgent({ executionMode: "live" }, paperAgent)).toBe(true);
    expect(isPaperAgent({ executionMode: "live" }, liveAgent)).toBe(false);
  });
});

describe("afterTick", () => {
  test("a paper agent accrues commission on its profit, then a low tier buys a top-up", async () => {
    const db = await freshDb();
    const rt = createRuntime(loadWorkerEnv({ EXECUTION_MODE: "paper" }), { db, clock: fixedClock(), logger: silentLogger });
    const agent = await seedAgent(db);
    await seedProfitableClose(db, agent);

    await afterTick(rt, agent, resultFor(agent, "low"));

    const totals = await paperLedgerTotals(db, agent.id);
    expect(totals.commissionUsd).toBeCloseTo(10); // 10% of 100
    expect(totals.topup0g).toBeCloseTo(60); // default ZG_PER_USDC of 6
    expect(totals.balanceUsd).toBeCloseTo(0);

    const runtime = await getAgentRuntime(db, agent.id);
    expect(runtime.lastTickAt).toBe(NOW);
    expect(runtime.portfolio?.realizedPnlUsd).toBeCloseTo(100);
  });

  test("a live agent never writes the paper ledger, but still gets its runtime status", async () => {
    const db = await freshDb();
    const rt = createRuntime(loadWorkerEnv({ EXECUTION_MODE: "live" }), { db, clock: fixedClock(), logger: silentLogger });
    const agent = await seedAgent(db, { mode: "live" });
    await seedProfitableClose(db, agent);

    await afterTick(rt, agent, resultFor(agent, "low"));

    const totals = await paperLedgerTotals(db, agent.id);
    expect(totals).toEqual({ commissionUsd: 0, topupUsd: 0, topup0g: 0, balanceUsd: 0 });
    expect((await getAgentRuntime(db, agent.id)).lastOutcome).toBe("noop");
  });
});
