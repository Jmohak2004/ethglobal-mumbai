#!/usr/bin/env bun
// Worker CLI.
//   bun src/index.ts run                 migrate, then scheduler, provisioning, forecast resolver, crash guard, stats/attestation sync,
//                                        treasury, insight digests (15 min), humans board sync (5 min), reflection loops
//   bun src/index.ts relayer             poll TopUpRequested and deposit 0G through the Payment Layer
//   bun src/index.ts tick <agentId>      one decision tick; prints the episode JSON
//   bun src/index.ts insights <agentId>  one insight cycle for one agent; prints the run and its digest
//   bun src/index.ts provision <agentId> run every provisioning step now (ignores backoff); prints the result
//   bun src/index.ts seed-demo           two paper demo agents, only when the database has no agents

import { getAgent, migrate } from "@arena/db";
import { loadWorkerEnv, type WorkerEnv } from "./env.ts";
import { createRuntime, loadAgents, type Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { runTick, type TickResult } from "./tick.ts";
import { resolveDueForecasts } from "./forecasts.ts";
import { createCrashGuard } from "./crash.ts";
import { dbBlockCursor, recomputeStats, syncAttestations, syncOrderFills } from "./stats.ts";
import { checkRegistrations } from "./registry.ts";
import { reflectAgent } from "./reflection.ts";
import { runRelayerOnce } from "./economics/relayer.ts";
import { seedDemoAgents } from "./seed.ts";
import { provisionAgent, provisionPass } from "./provisioner.ts";
import { syncHumans } from "./humans.ts";
import { INSIGHT_CYCLE_MS } from "./insights/producer.ts";
import type { Agent } from "@arena/shared";

const FORECAST_EVERY_MS = 60_000;
const PROVISION_EVERY_MS = 30_000;
const RISK_CHECK_EVERY_MS = 30_000;
const ATTEST_EVERY_MS = 15 * 60_000;
const TREASURY_EVERY_MS = 15 * 60_000;
const REFLECT_CHECK_EVERY_MS = 10 * 60_000;
const HUMANS_EVERY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `usage: bun src/index.ts <command>
  run                 migrate, then start the scheduler and background loops
  relayer             poll TopUpRequested and deposit 0G
  tick <agentId>      run one decision tick and print the episode JSON
  insights <agentId>  run one insight cycle for one agent and print the digest
  provision <agentId> run every provisioning step for one agent now and print the result
  seed-demo           create two paper demo agents when the database is empty`;

/** Shared work after each tick: reflect after a sell, and request a top-up when the budget is low. */
export async function afterTick(rt: Runtime, agent: Agent, result: TickResult): Promise<void> {
  const tier = result.budgetTier ?? "healthy";
  if (result.sold) await reflectAgent(rt.reflectionDeps(), agent, tier);
  await rt.treasury.maybeTopUp(agent, tier);
}

/** Once a day per agent, reflect on the agent's recent episodes. The last run time is read from the lessons table. */
export async function dailyReflections(rt: Runtime, lastRun: Map<string, number>): Promise<void> {
  const now = rt.clock.now();
  for (const agent of await loadAgents(rt.db)) {
    if (!lastRun.has(agent.id)) {
      const latest = await rt.db.query.lessons.findFirst({
        where: (l, { eq }) => eq(l.agentId, agent.id),
        orderBy: (l, { desc }) => [desc(l.ts)],
      });
      lastRun.set(agent.id, latest?.ts ?? 0);
    }
    if (now - (lastRun.get(agent.id) ?? 0) < DAY_MS) continue;
    lastRun.set(agent.id, now);
    await reflectAgent(rt.reflectionDeps(), agent);
  }
}

async function cmdRun(env: WorkerEnv): Promise<void> {
  const rt = createRuntime(env);
  await migrate(rt.db);
  const log = rt.logger;
  const { db, clock } = rt;
  const market = rt.deps.market;

  const scheduler = new Scheduler({
    deps: rt.deps,
    loadAgents: () => loadAgents(db),
    maxConcurrency: env.WORKER_MAX_CONCURRENCY,
    logger: log,
    onTick: async (agent, result) => {
      await afterTick(rt, agent, result);
    },
  });
  await scheduler.start();

  const attest = async () => {
    await recomputeStats({ db, clock, logger: log });
    if (rt.perf) {
      await syncAttestations({
        db,
        perf: rt.perf,
        logger: log,
        cursor: dbBlockCursor(db, "perf_reports"),
        fromBlock: BigInt(env.PERF_REGISTRY_FROM_BLOCK),
        chunkBlocks: env.LOG_CHUNK_BLOCKS,
      });
    }
    if (rt.registry) await checkRegistrations(await loadAgents(db), rt.registry, log);
  };
  /** Forecast scoring and live order fills, both on the minute. */
  const poll = async () => {
    await resolveDueForecasts({ db, market, clock, logger: log });
    if (rt.flash) await syncOrderFills({ db, flash: rt.flash, clock, logger: log });
  };
  const crash = createCrashGuard({ deps: rt.deps, loadAgents: () => loadAgents(db) });
  const reflectLastRun = new Map<string, number>();
  // Insight digests (PRD 6.8). A cycle never overlaps the one before it, since each digest is a paid 0G call.
  let insightCycleRunning = false;
  const insightCycle = async () => {
    if (insightCycleRunning) return;
    insightCycleRunning = true;
    try {
      const runs = await rt.insights.runCycle(await loadAgents(db));
      const outcomes = runs.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
      if (runs.length > 0) log.info("insight cycle", { agents: runs.length, outcomes });
    } finally {
      insightCycleRunning = false;
    }
  };
  // Humans board (PRD 6.13). Needs the Flash client, so it is off when DEFINITIVE_API_KEY is not set.
  let humansRunning = false;
  const humans = async () => {
    if (!rt.flash || humansRunning) return;
    humansRunning = true;
    try {
      const result = await syncHumans({ db, flash: rt.flash, clock, logger: log });
      if (result.users > 0) log.info("humans board synced", { ...result });
    } finally {
      humansRunning = false;
    }
  };
  if (!rt.flash) log.warn("humans board sync disabled: DEFINITIVE_API_KEY is not set", {});
  // Provisioning passes can outlast the interval (RPC calls), so a pass never starts while one is running.
  let provisioning = false;
  const provision = async () => {
    if (provisioning) return;
    provisioning = true;
    try {
      const results = await provisionPass(rt.provisionDeps());
      const failed = results.filter((r) => r.status === "failed").length;
      if (results.length > 0) log.info("provisioning pass", { agents: results.length, failed });
    } finally {
      provisioning = false;
    }
  };
  const timers: ReturnType<typeof setInterval>[] = [
    setInterval(() => void provision().catch((e) => log.error("provisioning pass failed", { error: e })), PROVISION_EVERY_MS),
    setInterval(() => void poll().catch((e) => log.error("forecast or order poll failed", { error: e })), FORECAST_EVERY_MS),
    setInterval(() => void crash.check().catch((e) => log.error("crash guard failed", { error: e })), RISK_CHECK_EVERY_MS),
    setInterval(() => void attest().catch((e) => log.error("stats or attestation sync failed", { error: e })), ATTEST_EVERY_MS),
    setInterval(() => void treasurySweep(rt).catch((e) => log.error("treasury sweep failed", { error: e })), TREASURY_EVERY_MS),
    setInterval(() => void dailyReflections(rt, reflectLastRun).catch((e) => log.error("daily reflection failed", { error: e })), REFLECT_CHECK_EVERY_MS),
    setInterval(() => void insightCycle().catch((e) => log.error("insight cycle failed", { error: e })), INSIGHT_CYCLE_MS),
    setInterval(() => void humans().catch((e) => log.error("humans board sync failed", { error: e })), HUMANS_EVERY_MS),
  ];
  // Kick the slow loops off once at startup.
  void provision().catch((e) => log.error("provisioning pass failed", { error: e }));
  void poll().catch((e) => log.error("forecast or order poll failed", { error: e }));
  void crash.check().catch((e) => log.error("crash guard failed", { error: e }));
  void attest().catch((e) => log.error("stats or attestation sync failed", { error: e }));
  void insightCycle().catch((e) => log.error("insight cycle failed", { error: e }));
  void humans().catch((e) => log.error("humans board sync failed", { error: e }));

  log.info("worker running", { maxConcurrency: env.WORKER_MAX_CONCURRENCY, executionMode: env.EXECUTION_MODE, chain: rt.chain.name });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    for (const t of timers) clearInterval(t);
    await scheduler.stop();
    await rt.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Collects owed commission for every active agent. Failures are logged per agent. */
async function treasurySweep(rt: Runtime): Promise<void> {
  for (const agent of await loadAgents(rt.db)) {
    try {
      await rt.treasury.collectCommissionIfOwed(agent);
    } catch (err) {
      rt.logger.error("commission collection failed", { agent: agent.id, error: err });
    }
  }
}

/** One insight cycle for one agent, ignoring the digest's age. Prints the run (with the digest). Exit 1 when it failed. */
async function cmdInsights(env: WorkerEnv, agentId: string | undefined): Promise<number> {
  if (!agentId) {
    console.error(USAGE);
    return 2;
  }
  const rt = createRuntime(env);
  await migrate(rt.db);
  const agent = await getAgent(rt.db, agentId);
  if (!agent) {
    console.error(`no agent with id ${agentId}`);
    await rt.close();
    return 1;
  }
  const run = await rt.insights.produce(agent);
  console.log(JSON.stringify(run, null, 2));
  await rt.close();
  return run.outcome === "failed" ? 1 : 0;
}

async function cmdRelayer(env: WorkerEnv): Promise<void> {
  const rt = createRuntime(env);
  await migrate(rt.db);
  const opts = rt.relayerOptions();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  rt.logger.info("relayer running", { pollSec: env.RELAYER_POLL_SEC });
  while (!stopping) {
    try {
      const res = await runRelayerOnce(opts);
      if (res.scanned > 0) rt.logger.info("relayer pass", { ...res, cursor: res.cursor.toString() });
    } catch (err) {
      rt.logger.error("relayer pass failed", { error: err });
    }
    await new Promise((resolve) => setTimeout(resolve, env.RELAYER_POLL_SEC * 1000));
  }
  await rt.close();
}

async function cmdTick(env: WorkerEnv, agentId: string | undefined): Promise<number> {
  if (!agentId) {
    console.error(USAGE);
    return 2;
  }
  const rt = createRuntime(env);
  await migrate(rt.db);
  const agent = await getAgent(rt.db, agentId);
  if (!agent) {
    console.error(`no agent with id ${agentId}`);
    await rt.close();
    return 1;
  }
  const result = await runTick(rt.deps, agent);
  console.log(JSON.stringify(result.episode ?? result, null, 2));
  await rt.close();
  return result.error ? 1 : 0;
}

/** Runs every provisioning step for one agent, ignoring backoff. Exit code 1 when a step failed. */
async function cmdProvision(env: WorkerEnv, agentId: string | undefined): Promise<number> {
  if (!agentId) {
    console.error(USAGE);
    return 2;
  }
  const rt = createRuntime(env);
  await migrate(rt.db);
  const agent = await getAgent(rt.db, agentId);
  if (!agent) {
    console.error(`no agent with id ${agentId}`);
    await rt.close();
    return 1;
  }
  const result = await provisionAgent(rt.provisionDeps(), agent, { force: true });
  console.log(JSON.stringify(result, null, 2));
  await rt.close();
  return result.status === "failed" ? 1 : 0;
}

async function cmdSeed(env: WorkerEnv): Promise<number> {
  const rt = createRuntime(env);
  await migrate(rt.db);
  const res = await seedDemoAgents({ db: rt.db, env, wallets: rt.deps.wallets, clock: rt.clock, logger: rt.logger });
  console.log(JSON.stringify(res, null, 2));
  await rt.close();
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(USAGE);
    return 2;
  }
  const env = loadWorkerEnv();
  switch (command) {
    case "run":
      await cmdRun(env);
      return 0;
    case "relayer":
      await cmdRelayer(env);
      return 0;
    case "tick":
      return cmdTick(env, args[0]);
    case "insights":
      return cmdInsights(env, args[0]);
    case "provision":
      return cmdProvision(env, args[0]);
    case "seed-demo":
      return cmdSeed(env);
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
