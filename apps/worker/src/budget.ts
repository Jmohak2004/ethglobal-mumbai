// Per-agent compute budget tier (PRD 6.11.6). With a 0G management key, the balance is the account's
// total balance. Without one, it is an estimate: AGENT_SEED_CREDIT_0G minus everything billed so far.
// Paper agents always use the estimate, plus the 0G that their simulated top-ups bought (paper_ledger).
// The management-key balance is shared by the whole platform, so it cannot reflect one paper agent's top-ups.
// Units: 0G. Billing strings from the Router are assumed to be 0G, not neuron (see report).

import { billingTo0G } from "@arena/shared";
import { zgPerUsd } from "./billing.ts";
import { paperLedgerTotals, sumBillingSince, type Db } from "@arena/db";
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
  /** True for agents that trade on paper. Their balance includes simulated top-ups and never reads the account. */
  isPaper?: (agent: Agent) => boolean;
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

      const paper = opts.isPaper?.(agent) ?? false;
      let balance: number | null = null;
      let source: BudgetReading["source"] = "estimate";
      if (opts.account && !paper) {
        try {
          const account = await opts.account.getBalance();
          const total = billingTo0G(
            account.totalBalance,
            account.currency === "usd" ? "usd_micro" : account.currency ? "neuron" : null,
            zgPerUsd(),
          );
          if (total === null) throw new Error(`unparseable total_balance ${account.totalBalance}`);
          balance = Number(total);
          source = "account";
        } catch (err) {
          logger.warn("0G balance read failed, estimating from billing", { agent: agent.id, error: err });
        }
      }
      if (balance === null) {
        const topup0g = paper ? (await paperLedgerTotals(opts.db, agent.id)).topup0g : 0;
        balance = Math.max(0, opts.seedCredit0G + topup0g - (Number(billedTotal) || 0));
      }

      return { tier: budgetTierFrom({ balance, dailyBurn }), balance, dailyBurn, source };
    },

    markCritical(agentId, reason) {
      overrides.set(agentId, { until: opts.clock.now() + CRITICAL_OVERRIDE_MS, reason });
    },
  };
}
