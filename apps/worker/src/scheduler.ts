// In-process scheduler. Every REFRESH_MS it reloads the active agents. Every PUMP_MS it starts the due
// ticks, with at most one tick per agent at a time and at most maxConcurrency ticks overall. Each agent's
// next run is its tickIntervalSec plus ±10% jitter after the previous run ends. stop() waits for in-flight
// ticks to finish, so shutdown never cuts a tick in half. requestRun() queues an agent's tick now (run-now).

import type { Agent } from "@arena/shared";
import type { Deps } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { runTick, type TickResult } from "./tick.ts";

export const REFRESH_MS = 30_000;
export const PUMP_MS = 1_000;
const MIN_INTERVAL_SEC = 30;

export interface SchedulerOptions {
  deps: Deps;
  loadAgents: () => Promise<Agent[]>;
  maxConcurrency: number;
  refreshMs?: number;
  pumpMs?: number;
  random?: () => number;
  runner?: (deps: Deps, agent: Agent) => Promise<TickResult>;
  /** Runs after every tick (reflection, top-ups, status). Errors are logged and never stop the scheduler. */
  onTick?: (agent: Agent, result: TickResult) => Promise<void> | void;
  /** Runs when an agent gets its next run time: on first scheduling and after every run. Errors are logged. */
  onScheduled?: (agent: Agent, nextRunAt: number) => Promise<void> | void;
  logger?: Logger;
}

interface Entry {
  agent: Agent;
  nextRunAt: number;
  running: boolean;
  /** Set by requestRun. The next pump starts the tick regardless of nextRunAt. */
  runRequested: boolean;
}

export const intervalMs = (agent: Agent): number => Math.max(MIN_INTERVAL_SEC, agent.config.tickIntervalSec) * 1000;

/**
 * DEMO_TICK_INTERVAL_SEC: paper agents tick on this interval instead of their own, so a demo does not wait five minutes.
 * Live agents and an unset variable return the agent unchanged. The scheduler's 30 s floor still applies.
 */
export function withDemoTickInterval(agent: Agent, demoSec: number | undefined, paper: boolean): Agent {
  if (!demoSec || !paper) return agent;
  return { ...agent, config: { ...agent.config, tickIntervalSec: demoSec } };
}

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<Promise<void>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private readonly random: () => number;
  private readonly logger: Logger;

  constructor(private readonly opts: SchedulerOptions) {
    if (!(opts.maxConcurrency >= 1)) throw new RangeError("maxConcurrency must be >= 1");
    this.random = opts.random ?? Math.random;
    this.logger = opts.logger ?? silentLogger;
  }

  /** Ticks currently running. */
  get active(): number {
    return this.inFlight.size;
  }

  /** Reloads agents. New agents get a random first run within one interval, so they do not all start together. */
  async refresh(): Promise<void> {
    const agents = await this.opts.loadAgents();
    const now = this.opts.deps.clock.now();
    const ids = new Set(agents.map((a) => a.id));
    const scheduled: Promise<void>[] = [];

    for (const agent of agents) {
      const existing = this.entries.get(agent.id);
      if (existing) {
        existing.agent = agent;
        continue;
      }
      const nextRunAt = now + this.random() * intervalMs(agent);
      this.entries.set(agent.id, { agent, nextRunAt, running: false, runRequested: false });
      scheduled.push(this.notifyScheduled(agent, nextRunAt));
    }
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id)) this.entries.delete(id);
    }
    await Promise.all(scheduled);
  }

  /**
   * Queues one tick for a scheduled agent, now. It runs on the next pump and never overlaps a tick already running.
   * Returns false when the scheduler does not hold the agent (paused, stopped, or added after the last refresh).
   */
  requestRun(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    entry.runRequested = true;
    this.pump();
    return true;
  }

  /** Starts every due or requested tick that the caps allow. Public so tests can drive the scheduler step by step. */
  pump(): void {
    if (this.stopped) return;
    const now = this.opts.deps.clock.now();
    const due = [...this.entries.values()]
      .filter((e) => !e.running && (e.runRequested || e.nextRunAt <= now))
      .sort((a, b) => Number(b.runRequested) - Number(a.runRequested) || a.nextRunAt - b.nextRunAt);
    for (const entry of due) {
      if (this.inFlight.size >= this.opts.maxConcurrency) break;
      this.launch(entry);
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timers.push(
      setInterval(() => {
        this.refresh().catch((err) => this.logger.error("agent refresh failed", { error: err }));
      }, this.opts.refreshMs ?? REFRESH_MS),
    );
    this.timers.push(setInterval(() => this.pump(), this.opts.pumpMs ?? PUMP_MS));
  }

  /** Stops scheduling and waits for in-flight ticks. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
  }

  private async notifyScheduled(agent: Agent, nextRunAt: number): Promise<void> {
    try {
      await this.opts.onScheduled?.(agent, nextRunAt);
    } catch (err) {
      this.logger.error("schedule hook failed", { agent: agent.id, error: err });
    }
  }

  private launch(entry: Entry): void {
    entry.running = true;
    entry.runRequested = false;
    const runner = this.opts.runner ?? runTick;
    let started: Promise<TickResult>;
    try {
      started = Promise.resolve(runner(this.opts.deps, entry.agent));
    } catch (err) {
      started = Promise.reject(err);
    }
    const run = started
      .then(async (result) => {
        await this.opts.onTick?.(entry.agent, result);
      })
      .catch((err) => this.logger.error("tick or post-tick hook failed", { agent: entry.agent.id, error: err }))
      .then(async () => {
        entry.running = false;
        const jitter = 1 + (this.random() * 0.2 - 0.1);
        entry.nextRunAt = this.opts.deps.clock.now() + intervalMs(entry.agent) * jitter;
        await this.notifyScheduled(entry.agent, entry.nextRunAt);
      });
    this.inFlight.add(run);
    void run.then(() => {
      this.inFlight.delete(run);
    });
  }
}
