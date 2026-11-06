import { afterAll, describe, expect, test } from "bun:test";
import type { Db } from "@arena/db";
import { closeDb, listEpisodesByAgent } from "@arena/db";
import { runTick, isTradingWalletProvisioned } from "./tick.ts";
import {
  completion,
  deps,
  FakeExecutor,
  fakeMarket,
  HOLD_REPLY,
  memoryDb,
  routerWith,
  seedAgent,
} from "./test-fixtures.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

describe("tick: unprovisioned agents", () => {
  test("an agent without a trading wallet is skipped with a noop episode, and nothing is decided or sent", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { tradingWallet: ZERO, status: "active" });
    const market = fakeMarket({ WETH: 2000 });
    const executor = new FakeExecutor();
    const { router, requests } = routerWith(() => completion(HOLD_REPLY));

    const result = await runTick(
      deps({ db, market, executor, routerFor: () => router, agentRouterFor: async () => router }),
      agent,
    );

    expect(result.skipped).toBe("not provisioned");
    expect(result.error).toBeNull();
    expect(result.episode?.verdict).toEqual({ kind: "noop", reasons: ["not provisioned"] });
    expect(result.episode?.market).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
    expect(market.requested).toHaveLength(0);

    const episodes = await listEpisodesByAgent(db, agent.id, { limit: 10 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.verdict).toEqual({ kind: "noop", reasons: ["not provisioned"] });
  });

  test("the router is never built for an unprovisioned agent", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { tradingWallet: ZERO });
    let built = 0;
    const result = await runTick(
      deps({
        db,
        routerFor: () => {
          built += 1;
          throw new Error("should not be called");
        },
        agentRouterFor: async () => {
          built += 1;
          throw new Error("should not be called");
        },
      }),
      agent,
    );
    expect(result.skipped).toBe("not provisioned");
    expect(built).toBe(0);
  });

  test("a provisioned agent ticks normally", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    expect(isTradingWalletProvisioned(agent)).toBe(true);
    const { router, requests } = routerWith(() => completion(HOLD_REPLY));
    const result = await runTick(deps({ db, routerFor: () => router }), agent);
    expect(result.skipped).toBeNull();
    expect(result.episode?.verdict.kind).toBe("noop");
    expect(requests).toHaveLength(1);
  });

  test("the per-agent router hook is used when set, and routerFor is the fallback", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const platform = routerWith(() => completion(HOLD_REPLY));
    const own = routerWith(() => completion(HOLD_REPLY));
    const seen: string[] = [];

    await runTick(
      deps({
        db,
        routerFor: () => platform.router,
        agentRouterFor: async (a) => {
          seen.push(a.id);
          return own.router;
        },
      }),
      agent,
    );
    expect(seen).toEqual([agent.id]);
    expect(own.requests).toHaveLength(1);
    expect(platform.requests).toHaveLength(0);

    await runTick(deps({ db, routerFor: () => platform.router }), agent);
    expect(platform.requests).toHaveLength(1);
  });
});
