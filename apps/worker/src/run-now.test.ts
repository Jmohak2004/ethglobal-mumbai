import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, requestTick, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { silentLogger } from "./logger.ts";
import { handleRunNow } from "./run-now.ts";
import { Scheduler } from "./scheduler.ts";
import type { TickResult } from "./tick.ts";
import { deps, fixedClock, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const tickFor = (agent: Agent): TickResult => ({
  agentId: agent.id,
  requestId: "req",
  episode: null,
  skipped: null,
  orderId: null,
  mode: null,
  budgetTier: "healthy",
  sold: false,
  error: null,
});

describe("handleRunNow", () => {
  test("two requests for one agent claim once and tick the agent once", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const clock = fixedClock();
    await requestTick(db, agent.id, "0x1111111111111111111111111111111111111111", NOW);
    await requestTick(db, agent.id, null, NOW + 1);

    const runs: string[] = [];
    const scheduler = new Scheduler({
      deps: deps({ db, clock }),
      loadAgents: async () => [agent],
      maxConcurrency: 2,
      runner: (async (_d: unknown, a: Agent) => {
        runs.push(a.id);
        return tickFor(a);
      }) as never,
      random: () => 0.5, // first run is not due for a while, so only run-now can start it
      logger: silentLogger,
    });
    await scheduler.refresh();
    scheduler.pump();
    expect(runs).toEqual([]);

    const directCalls: string[] = [];
    const claimed = await handleRunNow({
      db,
      clock,
      logger: silentLogger,
      scheduler,
      runDirect: async (id) => {
        directCalls.push(id);
      },
    });
    expect(claimed).toEqual([agent.id]);
    await flush();
    expect(runs).toEqual([agent.id]);
    expect(directCalls).toEqual([]);

    // Claimed requests are marked handled, so the next poll finds nothing.
    expect(await handleRunNow({ db, clock, logger: silentLogger, scheduler, runDirect: async () => {} })).toEqual([]);
    await scheduler.stop();
    expect(runs).toHaveLength(1);
  });

  test("a request for an agent the scheduler does not hold runs directly", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db, { status: "paused" });
    const clock = fixedClock();
    await requestTick(db, agent.id, null, NOW);

    const scheduler = new Scheduler({
      deps: deps({ db, clock }),
      loadAgents: async () => [],
      maxConcurrency: 1,
      logger: silentLogger,
    });
    await scheduler.refresh();

    const direct: string[] = [];
    await handleRunNow({
      db,
      clock,
      logger: silentLogger,
      scheduler,
      runDirect: async (id) => {
        direct.push(id);
      },
    });
    expect(direct).toEqual([agent.id]);
  });

  test("a request for a running agent waits for that tick, then runs once more", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const clock = fixedClock();
    const runs: string[] = [];
    const finishers: Array<() => void> = [];
    const scheduler = new Scheduler({
      deps: deps({ db, clock }),
      loadAgents: async () => [agent],
      maxConcurrency: 1,
      runner: ((_d: unknown, a: Agent) =>
        new Promise<TickResult>((resolve) => {
          runs.push(a.id);
          finishers.push(() => resolve(tickFor(a)));
        })) as never,
      random: () => 0, // due immediately
      logger: silentLogger,
    });
    await scheduler.refresh();
    scheduler.pump();
    expect(runs).toHaveLength(1);

    await requestTick(db, agent.id, null, NOW);
    await handleRunNow({ db, clock, logger: silentLogger, scheduler, runDirect: async () => {} });
    expect(runs).toHaveLength(1); // no overlap while the first tick is running

    finishers[0]?.();
    await flush();
    scheduler.pump();
    expect(runs).toHaveLength(2);

    finishers[1]?.();
    await flush();
    await scheduler.stop();
  });
});
