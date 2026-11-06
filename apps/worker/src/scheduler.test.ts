import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { Scheduler, intervalMs } from "./scheduler.ts";
import type { TickResult } from "./tick.ts";
import { fixedClock, deps, memoryDb, seedAgent } from "./test-fixtures.ts";
import { silentLogger } from "./logger.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const tick = (agent: Agent): TickResult => ({
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Scheduler", () => {
  test("never overlaps ticks for one agent and respects the global concurrency cap", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const a = await seedAgent(db, { name: "a" });
    const b = await seedAgent(db, { name: "b" });
    const clock = fixedClock();
    const started: string[] = [];
    const finishers: Array<() => void> = [];
    const runner = (_d: unknown, agent: Agent) =>
      new Promise<TickResult>((resolve) => {
        started.push(agent.id);
        finishers.push(() => resolve(tick(agent)));
      });

    const scheduler = new Scheduler({
      deps: deps({ db, clock }),
      loadAgents: async () => [a, b],
      maxConcurrency: 1,
      runner: runner as never,
      random: () => 0,
      logger: silentLogger,
    });
    await scheduler.refresh();

    scheduler.pump();
    scheduler.pump();
    expect(started).toEqual([a.id]); // cap of 1: b waits

    finishers[0]?.();
    await flush();
    scheduler.pump();
    expect(started).toEqual([a.id, b.id]); // a is not due again until its interval passes

    finishers[1]?.();
    await flush();
    clock.advance(intervalMs(a) * 2);
    scheduler.pump();
    expect(started.filter((id) => id === a.id)).toHaveLength(2);
    for (const finish of finishers) finish();
    await scheduler.stop();
  });

  test("calls the post-tick hook with each result and keeps running when the hook throws", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const seen: TickResult[] = [];
    const scheduler = new Scheduler({
      deps: deps({ db }),
      loadAgents: async () => [agent],
      maxConcurrency: 2,
      runner: (async (_d: unknown, a: Agent) => tick(a)) as never,
      onTick: (_a, result) => {
        seen.push(result);
        throw new Error("hook failed");
      },
      random: () => 0,
      logger: silentLogger,
    });
    await scheduler.refresh();
    scheduler.pump();
    await scheduler.stop();
    expect(seen).toHaveLength(1);
    expect(scheduler.active).toBe(0);
  });

  test("agents that leave the active set are dropped on refresh", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const a = await seedAgent(db);
    let current: Agent[] = [a];
    const started: string[] = [];
    const scheduler = new Scheduler({
      deps: deps({ db }),
      loadAgents: async () => current,
      maxConcurrency: 4,
      runner: (async (_d: unknown, agent: Agent) => {
        started.push(agent.id);
        return tick(agent);
      }) as never,
      random: () => 0,
      logger: silentLogger,
    });
    await scheduler.refresh();
    current = [];
    await scheduler.refresh();
    scheduler.pump();
    await scheduler.stop();
    expect(started).toEqual([]);
  });
});
