// `seed-demo`: creates two paper demo agents, but only when the database has no agents at all.
// Paper agents never sign or send transactions. They have no 0G wallet, so no top-up can be sent to them.

import { createAgent, listPublic, newId, type Db } from "@arena/db";
import { defaultConfig, validateConfig, configHash } from "@arena/policy";
import { agentIdToBytes32, globalLimitsFromEnv, type TemplateId } from "@arena/shared";
import { createHash } from "node:crypto";
import type { WorkerEnv } from "./env.ts";
import type { Logger } from "./logger.ts";
import type { WalletProvider } from "./wallets.ts";
import type { Clock } from "./deps.ts";

const DEMO_TEMPLATES: Array<{ template: TemplateId; name: string }> = [
  { template: "momentum", name: "[demo] Momentum Paper" },
  { template: "mean_reversion", name: "[demo] Mean Reversion Paper" },
];

/** A deterministic placeholder address with no known key. Used only for paper agents. */
export function demoAddress(label: string): `0x${string}` {
  return `0x${createHash("sha256").update(`arena-worker-demo:${label}`).digest("hex").slice(0, 40)}`;
}

export interface SeedResult {
  created: Array<{ id: string; name: string; template: TemplateId }>;
  skipped: string | null;
}

export async function seedDemoAgents(opts: {
  db: Db;
  env: WorkerEnv;
  wallets: WalletProvider;
  clock: Clock;
  logger: Logger;
}): Promise<SeedResult> {
  const existing = await listPublic(opts.db, { limit: 1 });
  if (existing.length > 0) {
    return { created: [], skipped: "agents already exist; seed-demo only runs on an empty database" };
  }

  const global = globalLimitsFromEnv(opts.env);
  const bounds = { min: opts.env.COMMISSION_BPS_MIN, max: opts.env.COMMISSION_BPS_MAX };
  const owner = demoAddress("owner");
  const created: SeedResult["created"] = [];

  for (const [i, demo] of DEMO_TEMPLATES.entries()) {
    const id = newId();
    const assets = [global.allowedTokens[i % Math.max(1, global.allowedTokens.length)] ?? "WETH"];
    const config = defaultConfig(demo.template, {
      assets,
      commissionBps: opts.env.COMMISSION_BPS_DEFAULT,
      tickIntervalSec: opts.env.TICK_INTERVAL_DEFAULT_SEC,
      global,
    });
    const check = validateConfig(config, global, bounds);
    if (!check.ok) throw new Error(`demo config for ${demo.template} is invalid: ${check.errors.join("; ")}`);

    let tradingWallet: `0x${string}`;
    try {
      tradingWallet = await opts.wallets.addressFor({ id });
    } catch {
      tradingWallet = demoAddress(id);
    }

    const agent = await createAgent(opts.db, {
      id,
      name: demo.name,
      ownerAddress: owner,
      tradingWallet,
      zgWallet: null,
      config,
      configHash: configHash(config),
      mode: "paper",
      status: "active",
      createdAt: opts.clock.now(),
    });
    created.push({ id: agent.id, name: agent.name, template: demo.template });
    opts.logger.info("demo agent created", { agent: agent.id, template: demo.template, assets, onchainId: agentIdToBytes32(agent.id) });
  }
  return { created, skipped: null };
}
