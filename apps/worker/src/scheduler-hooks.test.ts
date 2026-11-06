import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { intervalMs, Scheduler, withDemoTickInterval } from "./scheduler.ts";
import { silentLogger } from "./logger.ts";
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

describe("Scheduler.onScheduled", () => {
  test("reports the first due time on scheduling and the next one after each run", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const clock = fixedClock();
    const seen: Array<{ id: string; at: number }> = [];
    const scheduler = new Scheduler({
      deps: deps({ db, clock }),
      loadAgents: async () => [agent],
      maxConcurrency: 1,
      runner: (async (_d: unknown, a: Agent) => tickFor(a)) as never,
      onScheduled: (a, at) => {
        seen.push({ id: a.id, at });
      },
      random: () => 0,
      logger: silentLogger,
    });

    await scheduler.refresh();
    expect(seen).toEqual([{ id: agent.id, at: NOW }]);

    scheduler.pump();
    await flush();
    // random() = 0 gives the lower end of the ±10% jitter.
    expect(seen[1]).toEqual({ id: agent.id, at: NOW + intervalMs(agent) * 0.9 });
    await scheduler.stop();
  });

  test("a failing schedule hook never stops the scheduler", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const started: string[] = [];
    const scheduler = new Scheduler({
      deps: deps({ db }),
      loadAgents: async () => [agent],
      maxConcurrency: 1,
      runner: (async (_d: unknown, a: Agent) => {
        started.push(a.id);
        return tickFor(a);
      }) as never,
      onScheduled: () => {
        throw new Error("hook failed");
      },
      random: () => 0,
      logger: silentLogger,
    });
    await scheduler.refresh();
    scheduler.pump();
    await scheduler.stop();
    expect(started).toEqual([agent.id]);
  });
});

describe("Scheduler.requestRun", () => {
  test("returns false for an agent the scheduler does not hold", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const scheduler = new Scheduler({ deps: deps({ db }), loadAgents: async () => [], maxConcurrency: 1, logger: silentLogger });
    await scheduler.refresh();
    expect(scheduler.requestRun("missing-agent")).toBe(false);
  });

  test("runs a scheduled agent before its due time", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const started: string[] = [];
    const scheduler = new Scheduler({
      deps: deps({ db }),
      loadAgents: async () => [agent],
      maxConcurrency: 1,
      runner: (async (_d: unknown, a: Agent) => {
        started.push(a.id);
        return tickFor(a);
      }) as never,
      random: () => 0.9, // due in most of an interval
      logger: silentLogger,
    });
    await scheduler.refresh();
    scheduler.pump();
    expect(started).toEqual([]);
    expect(scheduler.requestRun(agent.id)).toBe(true);
    expect(started).toEqual([agent.id]);
    await scheduler.stop();
  });
});

describe("withDemoTickInterval", () => {
  const base = { id: "a", config: { tickIntervalSec: 300 } } as unknown as Agent;

  test("overrides the interval of paper agents only", () => {
    expect(withDemoTickInterval(base, 60, true).config.tickIntervalSec).toBe(60);
    expect(withDemoTickInterval(base, 60, false)).toBe(base);
  });

  test("leaves agents alone when DEMO_TICK_INTERVAL_SEC is unset", () => {
    expect(withDemoTickInterval(base, undefined, true)).toBe(base);
  });
});
