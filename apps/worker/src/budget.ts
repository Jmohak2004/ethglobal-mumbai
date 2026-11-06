// Per-agent compute budget tier (PRD 6.11.6). With a 0G management key, the balance is the account's
// total balance. Without one, it is an estimate: AGENT_SEED_CREDIT_0G minus everything billed so far.
// Units: 0G. Billing strings from the Router are assumed to be 0G, not neuron (see report).

import { sumBillingSince, type Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import { budgetTierFrom, type ZeroGAccount } from "@arena/zerog";
import type { BudgetReading, BudgetSource, Clock } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CRITICAL_OVERRIDE_MS = 10 * 60 * 1000;

export interface BudgetSourceOptions {
  db: Db;
  clock: Clock;
  seedCredit0G: number;
  account?: Pick<ZeroGAccount, "getBalance"> | null;
  logger?: Logger;
}

export function createBudgetSource(opts: BudgetSourceOptions): BudgetSource {
  const logger = opts.logger ?? silentLogger;
  const overrides = new Map<string, { until: number; reason: string }>();

  return {
    async forAgent(agent: Agent): Promise<BudgetReading> {
      const now = opts.clock.now();
      const [billedTotal, billedDay] = await Promise.all([
        sumBillingSince(opts.db, agent.id, 0),
        sumBillingSince(opts.db, agent.id, now - DAY_MS),
      ]);
      const dailyBurn = Math.max(0, Number(billedDay) || 0);

      const override = overrides.get(agent.id);
      if (override && override.until > now) {
        return { tier: "critical", balance: null, dailyBurn, source: "override" };
      }

      let balance: number | null = null;
      let source: BudgetReading["source"] = "estimate";
      if (opts.account) {
        try {
          const account = await opts.account.getBalance();
          const total = Number(account.totalBalance);
          if (!Number.isFinite(total)) throw new Error(`unparseable total_balance ${account.totalBalance}`);
          balance = total;
          source = "account";
        } catch (err) {
          logger.warn("0G balance read failed, estimating from billing", { agent: agent.id, error: err });
        }
      }
      if (balance === null) {
        balance = Math.max(0, opts.seedCredit0G - (Number(billedTotal) || 0));
      }

      return { tier: budgetTierFrom({ balance, dailyBurn }), balance, dailyBurn, source };
    },

    markCritical(agentId, reason) {
      overrides.set(agentId, { until: opts.clock.now() + CRITICAL_OVERRIDE_MS, reason });
    },
  };
}
