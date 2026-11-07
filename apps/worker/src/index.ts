#!/usr/bin/env bun
// Worker CLI.
//   bun src/index.ts run                 migrate, then scheduler, provisioning, forecast resolver, crash guard, stats/attestation sync,
//                                        treasury, insight digests (15 min), humans board sync (5 min), reflection loops,
//                                        runtime status, run-now requests (3 s), paper TP/SL and self-funding (30 s),
//                                        paper trade journal (20 s)
//   bun src/index.ts relayer             poll TopUpRequested and deposit 0G through the Payment Layer
//   bun src/index.ts tick <agentId>      one decision tick; prints the episode JSON
//   bun src/index.ts insights <agentId>  one insight cycle for one agent; prints the run and its digest
//   bun src/index.ts provision <agentId> run every provisioning step now (ignores backoff); prints the result
//   bun src/index.ts journal             journal every pending paper fill to TradeJournal now; prints the totals
//   bun src/index.ts seed-demo           two paper demo agents, only when the database has no agents

import { closeDb, createDb, getAgent, migrate } from "@arena/db";
import { loadWorkerEnv, type WorkerEnv } from "./env.ts";
import { createRuntime, loadAgents, type Runtime } from "./runtime.ts";
import { Scheduler, withDemoTickInterval } from "./scheduler.ts";
import { runTick, type TickResult } from "./tick.ts";
import { modeFor } from "./execution.ts";
import { closePaperBrackets, DEFAULT_ZG_PER_USDC, settlePaperCommission, settlePaperTopUp } from "./paper.ts";
import { recordNextTick, recordPortfolio, recordTickStatus, type StatusDeps } from "./runtime-status.ts";
import { handleRunNow } from "./run-now.ts";
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
import { createJournalRunner, journalChainFromEnv, JOURNAL_BATCH_SIZE, JOURNAL_MAX_BATCHES, runJournalPass } from "./journal.ts";
import { createLogger } from "./logger.ts";
import type { Agent, BudgetTier } from "@arena/shared";

const FORECAST_EVERY_MS = 60_000;
const PROVISION_EVERY_MS = 30_000;
const RISK_CHECK_EVERY_MS = 30_000;
const PAPER_MONITOR_EVERY_MS = 30_000;
const JOURNAL_EVERY_MS = 20_000;
const RUN_NOW_EVERY_MS = 3_000;
/** Paused agents stay in the TP/SL monitor: their open brackets still protect positions. */
const PAPER_MONITOR_STATUSES: Agent["status"][] = ["active", "paused"];
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
  journal             journal every pending paper fill to TradeJournal and print the totals
  seed-demo           create two paper demo agents when the database is empty`;

/** Paper agents are the ones the platform simulates. modeFor is the same rule the tick uses to pick the execution mode. */
export const isPaperAgent = (deps: Pick<Runtime["deps"], "executionMode">, agent: Agent): boolean => modeFor(deps, agent) === "paper";

const statusDepsOf = (rt: Runtime): StatusDeps => ({ db: rt.db, clock: rt.clock, logger: rt.logger, market: rt.deps.market });

/**
 * Shared work after each tick: runtime status (every mode), reflect after a sell, then the mode's self-funding.
 * Paper agents use the simulated commission and top-up ledger. Live agents use the onchain treasury.
 */
export async function afterTick(rt: Runtime, agent: Agent, result: TickResult): Promise<void> {
  const tier = result.budgetTier ?? "healthy";
  try {
    await recordTickStatus(statusDepsOf(rt), agent, result);
  } catch (err) {
    rt.logger.error("runtime status write failed", { agent: agent.id, error: err });
  }
  if (result.sold) await reflectAgent(rt.reflectionDeps(), agent, tier);
  if (isPaperAgent(rt.deps, agent)) {
    await rt.agentLock.run(agent.id, () => settlePaperSelfFunding(rt, agent, tier));
  } else {
    await rt.treasury.maybeTopUp(agent, tier);
  }
}

/** Paper PRD 6.11 loop: commission on the high-water mark, then a simulated 0G top-up if the budget tier calls for it. */
async function settlePaperSelfFunding(rt: Runtime, agent: Agent, tier: BudgetTier): Promise<void> {
  const deps = { db: rt.db, clock: rt.clock, logger: rt.logger };
  await settlePaperCommission(deps, agent);
  await settlePaperTopUp(deps, agent, tier, {
    minUsd: rt.env.PAPER_MIN_TOPUP_USD,
    zgPerUsdc: rt.env.ZG_PER_USDC ?? DEFAULT_ZG_PER_USDC,
  });
}

/** One tick under the agent's lock. Never throws: an unexpected failure becomes an error result. */
function runAgent(rt: Runtime, agent: Agent): Promise<TickResult> {
  return rt.agentLock.run(agent.id, () => runTick(rt.deps, agent)).catch((err: unknown) => {
    rt.logger.error("tick failed", { agent: agent.id, error: err });
    return {
      agentId: agent.id,
      requestId: "",
      episode: null,
      skipped: null,
      orderId: null,
      mode: null,
      budgetTier: null,
      sold: false,
      error: err instanceof Error ? err.message : String(err),
    };
  });
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

  if (env.DEMO_TICK_INTERVAL_SEC) {
    log.warn("demo tick interval: paper agents tick on a fixed interval", { seconds: env.DEMO_TICK_INTERVAL_SEC });
  }
  const scheduler = new Scheduler({
    deps: rt.deps,
    loadAgents: async () =>
      (await loadAgents(db)).map((a) => withDemoTickInterval(a, env.DEMO_TICK_INTERVAL_SEC, isPaperAgent(rt.deps, a))),
    maxConcurrency: env.WORKER_MAX_CONCURRENCY,
    logger: log,
    runner: (_deps, agent) => runAgent(rt, agent),
    onTick: async (agent, result) => {
      await afterTick(rt, agent, result);
    },
    onScheduled: (agent, nextRunAt) => recordNextTick({ db, clock }, agent.id, nextRunAt),
  });
  await scheduler.start();

  // Paper TP/SL (PRD 6.5): a bracket entry whose mark crossed its take-profit or stop-loss is closed at the mark.
  let paperMonitorRunning = false;
  const paperMonitor = async () => {
    if (paperMonitorRunning) return;
    paperMonitorRunning = true;
    try {
      for (const agent of await loadAgents(db, PAPER_MONITOR_STATUSES)) {
        if (!isPaperAgent(rt.deps, agent)) continue;
        await rt.agentLock
          .run(agent.id, async () => {
            const exits = await closePaperBrackets(rt.deps, agent);
            if (exits.length === 0) return;
            await settlePaperCommission({ db, clock, logger: log }, agent);
            await recordPortfolio(statusDepsOf(rt), agent);
          })
          .catch((err) => log.error("paper TP/SL check failed", { agent: agent.id, error: err }));
      }
    } finally {
      paperMonitorRunning = false;
    }
  };

  // Paper trade journal: every paper fill with no journal tx yet is recorded in TradeJournal (Base Sepolia).
  // Off unless TRADE_JOURNAL_ADDRESS and OPERATOR_PRIVATE_KEY are set.
  const journal = createJournalRunner({ db, chain: journalChainFromEnv(env), logger: log });
  const journalPass = () => journal.run().catch((e) => log.error("trade journal pass failed", { error: e }));

  // Run now (owner console): claimed requests tick their agents on the scheduler, or directly when it does not hold them.
  let runNowRunning = false;
  const runNow = async () => {
    if (runNowRunning) return;
    runNowRunning = true;
    try {
      await handleRunNow({
        db,
        clock,
        logger: log,
        scheduler,
        runDirect: async (agentId) => {
          const agent = await getAgent(db, agentId);
          if (!agent) {
            log.warn("run-now: no such agent", { agent: agentId });
            return;
          }
          await afterTick(rt, agent, await runAgent(rt, agent));
        },
      });
    } finally {
      runNowRunning = false;
    }
  };

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
  let firstProvision = true;
  const provision = async () => {
    if (provisioning) return;
    provisioning = true;
    try {
      const results = await provisionPass(rt.provisionDeps(), { force: firstProvision });
      firstProvision = false;
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
    setInterval(() => void paperMonitor().catch((e) => log.error("paper TP/SL monitor failed", { error: e })), PAPER_MONITOR_EVERY_MS),
    setInterval(() => void journalPass(), JOURNAL_EVERY_MS),
    setInterval(() => void runNow().catch((e) => log.error("run-now poll failed", { error: e })), RUN_NOW_EVERY_MS),
  ];
  // Kick the slow loops off once at startup.
  void provision().catch((e) => log.error("provisioning pass failed", { error: e }));
  void poll().catch((e) => log.error("forecast or order poll failed", { error: e }));
  void crash.check().catch((e) => log.error("crash guard failed", { error: e }));
  void attest().catch((e) => log.error("stats or attestation sync failed", { error: e }));
  void insightCycle().catch((e) => log.error("insight cycle failed", { error: e }));
  void humans().catch((e) => log.error("humans board sync failed", { error: e }));
  void journalPass();

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

/** Collects owed commission for every active live agent. Paper agents settle on their simulated ledger instead. */
async function treasurySweep(rt: Runtime): Promise<void> {
  for (const agent of await loadAgents(rt.db)) {
    if (isPaperAgent(rt.deps, agent)) continue;
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

/**
 * Journals every pending paper fill now, pass after pass, until a pass finds nothing new. Prints the totals.
 * Exit 1 when the journal is not configured or a transaction failed.
 */
async function cmdJournal(env: WorkerEnv): Promise<number> {
  const chain = journalChainFromEnv(env);
  if (!chain) {
    console.error("trade journal disabled: set TRADE_JOURNAL_ADDRESS and OPERATOR_PRIVATE_KEY");
    return 1;
  }
  const db = createDb({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
  await migrate(db);
  const log = createLogger();
  const total = { listed: 0, journaled: 0, alreadyOnchain: 0, txHashes: [] as string[] };
  try {
    for (;;) {
      const pass = await runJournalPass({ db, chain, logger: log });
      total.listed += pass.listed;
      total.journaled += pass.journaled;
      total.alreadyOnchain += pass.alreadyOnchain;
      total.txHashes.push(...pass.txHashes);
      if (pass.listed < JOURNAL_BATCH_SIZE * JOURNAL_MAX_BATCHES || pass.journaled === 0) break;
    }
    console.log(JSON.stringify(total, null, 2));
    return 0;
  } finally {
    await closeDb(db);
  }
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
    case "journal":
      return cmdJournal(env);
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
