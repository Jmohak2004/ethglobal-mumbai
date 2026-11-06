import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, getAgentRuntime, PLACEHOLDER_WALLET, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { silentLogger } from "./logger.ts";
import { outcomeFor, recordTickStatus } from "./runtime-status.ts";
import { runTick, type TickResult } from "./tick.ts";
import {
  buyReply,
  completion,
  deps,
  fakeBudget,
  fakeMarket,
  FakeExecutor,
  fixedClock,
  memoryDb,
  NOW,
  routerWith,
  seedAgent,
} from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

const emptyResult = (agent: Agent): TickResult => ({
  agentId: agent.id,
  requestId: "req",
  episode: null,
  skipped: null,
  orderId: null,
  mode: null,
  budgetTier: null,
  sold: false,
  error: null,
});

describe("outcomeFor", () => {
  test("maps skips and failures to the UI outcome list", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    expect(outcomeFor({ ...emptyResult(agent), skipped: "not provisioned" }).outcome).toBe("not provisioned");
    expect(outcomeFor({ ...emptyResult(agent), skipped: "agent is paused" })).toMatchObject({ outcome: "paused", lastError: "agent is paused" });
    expect(outcomeFor({ ...emptyResult(agent), error: "boom" })).toMatchObject({ outcome: "error", lastError: "boom" });
    expect(outcomeFor(emptyResult(agent)).outcome).toBe("noop");
  });
});

describe("recordTickStatus", () => {
  test("a skipped tick for a paused agent is written to the runtime", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { status: "paused" });
    const d = deps({ db, clock: fixedClock() });
    const result = await runTick(d, agent);
    expect(result.skipped).toBe("agent is paused");

    await recordTickStatus({ db, clock: fixedClock(), logger: silentLogger, market: d.market }, agent, result);
    const runtime = await getAgentRuntime(db, agent.id);
    expect(runtime).toMatchObject({ lastOutcome: "paused", lastTickAt: NOW, lastRequestId: null, lastError: "agent is paused" });
    expect(runtime.portfolio?.cashUsd).toBe(agent.config.limits.maxAllocationUsd);
  });

  test("a tick for an agent without a trading wallet is written as not provisioned", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { tradingWallet: PLACEHOLDER_WALLET });
    const d = deps({ db, clock: fixedClock() });
    const result = await runTick(d, agent);
    await recordTickStatus({ db, clock: fixedClock(), logger: silentLogger, market: d.market }, agent, result);
    expect((await getAgentRuntime(db, agent.id)).lastOutcome).toBe("not provisioned");
  });

  test("a tick skipped for an empty budget is written as a noop", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const d = deps({ db, clock: fixedClock(), budget: fakeBudget("empty"), market: fakeMarket({ WETH: 2000 }) });
    const result = await runTick(d, agent);
    await recordTickStatus({ db, clock: fixedClock(), logger: silentLogger, market: d.market }, agent, result);
    const runtime = await getAgentRuntime(db, agent.id);
    expect(runtime.lastOutcome).toBe("noop");
    expect(runtime.lastError).toBeNull();
  });

  test("a failed decision is written as an error with its reason", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const d = deps({ db, clock: fixedClock(), market: fakeMarket({ WETH: 2000 }) }); // default routerFor throws
    const result = await runTick(d, agent);
    await recordTickStatus({ db, clock: fixedClock(), logger: silentLogger, market: d.market }, agent, result);
    const runtime = await getAgentRuntime(db, agent.id);
    expect(runtime.lastOutcome).toBe("error");
    expect(runtime.lastError).toContain("decision failed");
  });

  test("an approved tick writes the 0G request id and the portfolio after the fill", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const market = fakeMarket({ WETH: 2000 });
    const executor = new FakeExecutor();
    const { router } = routerWith(() => completion(buyReply(2000), "req-status-1"));
    const d = deps({ db, clock: fixedClock(), market, executor, routerFor: () => router });
    const result = await runTick(d, agent);
    expect(result.episode?.verdict.kind).toBe("approve");

    await recordTickStatus({ db, clock: fixedClock(), logger: silentLogger, market }, agent, result);
    const runtime = await getAgentRuntime(db, agent.id);
    expect(runtime).toMatchObject({ lastOutcome: "approve", lastRequestId: "req-status-1" });
    expect(runtime.portfolio?.positions.map((p) => p.asset)).toEqual(["WETH"]);
    expect(runtime.portfolio?.cashUsd).toBeLessThan(agent.config.limits.maxAllocationUsd);
  });
});
