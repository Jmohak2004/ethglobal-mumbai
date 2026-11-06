import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@arena/db";
import { closeDb } from "@arena/db";
import { runTick } from "./tick.ts";
import {
  apiError,
  buyReply,
  completion,
  deps,
  fakeBudget,
  fakeMarket,
  fakeRisk,
  FakeExecutor,
  globalLimits,
  HOLD_REPLY,
  memoryDb,
  routerWith,
  seedAgent,
  testWallets,
  type FakeMarket,
} from "./test-fixtures.ts";
import type { Agent } from "@arena/shared";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

describe("runTick: approve path", () => {
  let db: Db;
  let agent: Agent;
  let market: FakeMarket;
  let executor: FakeExecutor;

  beforeEach(async () => {
    db = await freshDb();
    agent = await seedAgent(db);
    market = fakeMarket({ WETH: 2000 });
    executor = new FakeExecutor();
  });

  test("persists the episode, forecast, inference call and paper order, linked to the 0G request id", async () => {
    const { router } = routerWith(() => completion(buyReply(2000), "req-approve-1"));
    const result = await runTick(deps({ db, market, executor, routerFor: () => router }), agent);

    expect(result.error).toBeNull();
    expect(result.episode?.verdict.kind).toBe("approve");
    const episodeId = result.episode?.id;
    if (!episodeId) throw new Error("no episode");

    const episode = await db.query.episodes.findFirst({ where: (e, { eq }) => eq(e.id, episodeId) });
    expect(episode?.zgRequestId).toBe("req-approve-1");
    expect(result.orderId).not.toBeNull();
    expect(episode?.flashOrderIds).toEqual([result.orderId ?? ""]);

    const call = await db.query.inferenceCalls.findFirst({ where: (t, { eq }) => eq(t.requestId, "req-approve-1") });
    expect(call?.agentId).toBe(agent.id);
    expect(call?.purpose).toBe("decision");
    expect(call?.payer).toBe("platform");

    const forecast = await db.query.forecasts.findFirst({ where: (f, { eq }) => eq(f.episodeId, episodeId) });
    expect(forecast?.asset).toBe("WETH");
    expect(forecast?.direction).toBe("up");
    expect(forecast?.resolvedPrice).toBeNull();
    expect(forecast?.resolveAt).toBe(forecast ? forecast.createdAt + 60 * 60_000 : -1);

    const order = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, result.orderId ?? "") });
    expect(order?.agentId).toBe(agent.id);
    expect(order?.status).toBe("simulated_fill");
    expect(order?.side).toBe("buy");

    const fills = await db.query.fills.findMany({ where: (f, { eq }) => eq(f.orderId, result.orderId ?? "") });
    expect(fills).toHaveLength(1);

    const blocks = await db.query.guardrailBlocks.findMany({ where: (g, { eq }) => eq(g.episodeId, episodeId) });
    expect(blocks).toHaveLength(0);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.mode).toBe("paper");
    expect(executor.calls[0]?.intent.asset).toBe("WETH");
  });

  test("a hold proposal writes a noop episode and sends nothing", async () => {
    const { router } = routerWith(() => completion(HOLD_REPLY));
    const result = await runTick(deps({ db, market, executor, routerFor: () => router }), agent);
    expect(result.episode?.verdict.kind).toBe("noop");
    expect(result.orderId).toBeNull();
    expect(executor.calls).toHaveLength(0);
  });
});

describe("runTick: guardrails and budget", () => {
  test("HALT blocks a buy and records a guardrail block", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const executor = new FakeExecutor();
    const { router, requests } = routerWith(() => completion(buyReply(2000)));
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), risk: fakeRisk("HALT"), executor, routerFor: () => router }),
      agent,
    );

    expect(requests).toHaveLength(1);
    expect(result.episode?.verdict.kind).toBe("reject");
    expect(result.episode?.riskLevel).toBe("HALT");
    expect(executor.calls).toHaveLength(0);
    expect(result.orderId).toBeNull();

    const blocks = await db.query.guardrailBlocks.findMany({ where: (g, { eq }) => eq(g.agentId, agent.id) });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.episodeId).toBe(result.episode?.id ?? null);
    expect(blocks[0]?.reasons.join(" ")).toContain("HALT");
  });

  test("an empty budget skips the LLM and records a noop episode", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const { router, requests } = routerWith(() => completion(buyReply(2000)));
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), budget: fakeBudget("empty"), routerFor: () => router }),
      agent,
    );
    expect(requests).toHaveLength(0);
    expect(result.episode?.verdict.kind).toBe("noop");
    expect(result.episode?.budgetTier).toBe("empty");
    expect(result.episode?.inference).toBeNull();
  });

  test("a 402 from 0G is recorded, marks the budget critical, and does not throw", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const budget = fakeBudget("healthy");
    const { router } = routerWith(() => apiError(402, "insufficient balance"));
    const result = await runTick(deps({ db, market: fakeMarket({ WETH: 2000 }), budget, routerFor: () => router }), agent);

    expect(result.error).toBeNull();
    expect(result.episode?.budgetTier).toBe("critical");
    expect(result.episode?.error).toContain("402");
    expect(result.episode?.verdict.kind).toBe("noop");
    expect(budget.marks).toEqual([{ agentId: agent.id, reason: "0G 402" }]);
    expect(result.budgetTier).toBe("critical");
  });

  test("a missing decision key is recorded on the episode, not thrown", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const result = await runTick(
      deps({
        db,
        market: fakeMarket({ WETH: 2000 }),
        routerFor: () => {
          throw new Error("ZG_API_KEY is not set: no decision model is available");
        },
      }),
      agent,
    );
    expect(result.error).toBeNull();
    expect(result.episode?.error).toContain("ZG_API_KEY");
    expect(result.episode?.verdict.kind).toBe("noop");
  });

  test("the kill switch skips inference entirely", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const { router, requests } = routerWith(() => completion(buyReply(2000)));
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), globalLimits: globalLimits({ killSwitch: true }), routerFor: () => router }),
      agent,
    );
    expect(requests).toHaveLength(0);
    expect(result.episode?.verdict.kind).toBe("noop");
  });

  test("paused and stopped agents do not tick", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { status: "paused" });
    const result = await runTick(deps({ db }), agent);
    expect(result.skipped).toBe("agent is paused");
    expect(result.episode).toBeNull();
  });
});

describe("runTick: execution mode", () => {
  const cases: Array<{ name: string; env: "paper" | "live"; agentMode: "paper" | "live"; expected: "paper" | "live" }> = [
    { name: "live platform and live agent", env: "live", agentMode: "live", expected: "live" },
    { name: "paper platform, live agent", env: "paper", agentMode: "live", expected: "paper" },
    { name: "live platform, paper agent", env: "live", agentMode: "paper", expected: "paper" },
  ];

  for (const c of cases) {
    test(`${c.name} sends ${c.expected}`, async () => {
      const db = await freshDb();
      // A single-key wallet provider signs for every agent, so one address matches any agent's trading wallet.
      const wallets = testWallets();
      const tradingWallet = (await wallets.addressFor({ id: "any" })) as `0x${string}`;
      const agent = await seedAgent(db, { mode: c.agentMode, tradingWallet });
      const executor = new FakeExecutor();
      const { router } = routerWith(() => completion(buyReply(2000)));
      const result = await runTick(
        deps({ db, executionMode: c.env, wallets, market: fakeMarket({ WETH: 2000 }), executor, routerFor: () => router }),
        agent,
      );
      expect(result.mode).toBe(c.expected);
      expect(executor.calls[0]?.mode).toBe(c.expected);
    });
  }

  test("a live order is refused when the signer does not match the trading wallet", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    const executor = new FakeExecutor();
    const { router } = routerWith(() => completion(buyReply(2000)));
    const result = await runTick(
      deps({ db, executionMode: "live", wallets: testWallets(), market: fakeMarket({ WETH: 2000 }), executor, routerFor: () => router }),
      agent,
    );
    expect(executor.calls).toHaveLength(0);
    expect(result.orderId).toBeNull();
    expect(result.episode?.error).toContain("does not match the agent trading wallet");
  });

  test("a market failure for one asset is recorded and the other asset still runs", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { assets: ["WETH", "cbBTC"] });
    const market = fakeMarket({ WETH: 2000, cbBTC: 60000 });
    market.failAsset("cbBTC");
    const { router } = routerWith(() => completion(HOLD_REPLY));
    const result = await runTick(deps({ db, market, routerFor: () => router }), agent);
    expect(result.episode?.market.map((m) => m.asset)).toEqual(["WETH"]);
    expect(result.episode?.error).toContain("market cbBTC");
  });
});
