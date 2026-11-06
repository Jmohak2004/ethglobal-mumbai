// "Run now" from the owner console. Pending tick requests are claimed once (claimTickRequests marks them handled),
// then each agent is queued on the scheduler, which applies the one-tick-per-agent rule. An agent the scheduler does
// not hold (paused, or added since the last refresh) goes to runDirect, which records a skip or runs it under the same lock.

import { claimTickRequests, type Db } from "@arena/db";
import type { Clock } from "./deps.ts";
import type { Logger } from "./logger.ts";

export interface RunNowOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  scheduler: { requestRun(agentId: string): boolean };
  runDirect(agentId: string): Promise<void>;
}

/** Claims the pending requests and starts one tick per requested agent. Returns the distinct agent ids claimed. */
export async function handleRunNow(opts: RunNowOptions): Promise<string[]> {
  const ids = await claimTickRequests(opts.db, opts.clock.now());
  for (const agentId of ids) {
    try {
      if (opts.scheduler.requestRun(agentId)) {
        opts.logger.info("run-now queued", { agent: agentId });
        continue;
      }
      opts.logger.info("run-now: agent not scheduled, running directly", { agent: agentId });
      await opts.runDirect(agentId);
    } catch (err) {
      opts.logger.error("run-now failed", { agent: agentId, error: err });
    }
  }
  return ids;
}
