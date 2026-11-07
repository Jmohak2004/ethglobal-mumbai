// Worker env: the shared platform env plus the runtime secrets and addresses the worker needs.
// Empty strings are treated as unset, so a blank line in .env does not fail validation.

import { EnvSchema, type Env } from "@arena/shared";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key");
const num = (d: number) => z.coerce.number().default(d);

export const WorkerEnvSchema = EnvSchema.extend({
  /**
   * Who signs for agent trading wallets. "local" derives keys from DEV_AGENT_* (dev only). "privy" uses Privy server
   * wallets with policies (PRD 7.4). Startup fails on "privy" without PRIVY_APP_ID and PRIVY_APP_SECRET.
   */
  WALLET_PROVIDER: z.enum(["local", "privy"]).default("local"),
  /** Dev-only: derive one trading account per agent from this mnemonic (LocalWalletProvider). */
  DEV_AGENT_MNEMONIC: z.string().optional(),
  /** Dev-only: one shared trading key for every agent (LocalWalletProvider). */
  DEV_AGENT_PRIVATE_KEY: privateKey.optional(),
  /** Privy app id (WALLET_PROVIDER=privy). */
  PRIVY_APP_ID: z.string().optional(),
  /** Privy app secret (WALLET_PROVIDER=privy). Server-only. */
  PRIVY_APP_SECRET: z.string().optional(),
  /**
   * Base64 PKCS8 P-256 private key that authorizes wallet calls. When set, it becomes the owner of each new agent
   * wallet, and every wallet call is signed with it. Create it in the Privy dashboard (docs/SETUP.md).
   */
  PRIVY_AUTHORIZATION_KEY: z.string().optional(),
  /** Privy policy id attached to each new agent wallet. The policy is created in the Privy dashboard (docs/SETUP.md). */
  PRIVY_POLICY_ID: z.string().optional(),
  /** 0G management key (`mk-…`). Enables real per-account balances via ZeroGAccount, and per-agent capped keys. */
  ZG_MGMT_KEY: z.string().optional(),
  /** 32-byte hex key (AES-256-GCM) that encrypts per-agent 0G secrets at rest. Required to mint or use them. */
  AGENT_KEY_ENCRYPTION_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
    .optional(),
  /** 0G chain RPC for storage uploads and the Payment Layer deposit. */
  ZG_RPC_URL: z.string().optional(),
  ZG_STORAGE_INDEXER: z.string().optional(),
  /** Signer for 0G Storage uploads. */
  ZG_PRIVATE_KEY: privateKey.optional(),
  /**
   * 0G per USDC. The relayer uses it when CoinGecko has no price. Paper top-ups use it too (fallback 6 when unset).
   * Paper top-ups are simulated, so this only sets the 0G credit a paper agent receives.
   */
  ZG_PER_USDC: z.coerce.number().positive().optional(),
  /**
   * Paper mode only: the smallest simulated ledger balance (USD of paper commission) that buys a 0G top-up
   * once the agent's budget tier is low, critical or empty (PRD 6.11, simulated). Default 0.01.
   */
  PAPER_MIN_TOPUP_USD: num(0.01),
  /**
   * Demo speed. When set, every paper agent ticks on this interval (seconds) instead of its own tickIntervalSec,
   * e.g. 60 so a demo does not wait five minutes. Live agents are not affected. The scheduler's 30 s floor still applies.
   */
  DEMO_TICK_INTERVAL_SEC: z.coerce.number().int().positive().optional(),
  /** Assumed 0G credit per agent when no management key is set (estimate = seed − billed). */
  AGENT_SEED_CREDIT_0G: num(1),
  /** Comma list of curated RSS/Atom feeds for insight sources. Unset uses the built-in defaults (PRD 6.8). */
  INSIGHT_RSS_FEEDS: z.string().optional(),

  /** AgentRegistry on Base. Read-only: the worker warns about active agents that are not registered onchain. */
  REGISTRY_ADDRESS: address.optional(),
  TREASURY_ADDRESS: address.optional(),
  PERF_REGISTRY_ADDRESS: address.optional(),
  RISK_ORACLE_ADDRESS: address.optional(),
  /** TradeJournal on Base Sepolia. Paper fills are journaled here by OPERATOR_PRIVATE_KEY. Unset = journal off. */
  TRADE_JOURNAL_ADDRESS: address.optional(),
  /** First block to scan for PerformanceReported logs (used when no scan cursor is stored yet). */
  PERF_REGISTRY_FROM_BLOCK: z.coerce.number().int().nonnegative().default(0),
  /** Blocks per eth_getLogs call when scanning PerformanceReported logs. Keeps each call under RPC range limits. */
  LOG_CHUNK_BLOCKS: z.coerce.number().int().positive().default(2000),

  /** Operator key: calls AgentTreasury.topUp and collectCommission, and AgentRegistry.updateConfig. */
  OPERATOR_PRIVATE_KEY: privateKey.optional(),
  /** Platform admin key: calls AgentRegistry.register (the registry `platform` role). */
  PLATFORM_ADMIN_PRIVATE_KEY: privateKey.optional(),
  /** Key on the 0G chain that pays for Payment Layer deposits. */
  RELAYER_ZG_PRIVATE_KEY: privateKey.optional(),
  /**
   * 0G account the relayer credits through the Payment Layer. Router keys bill the wallet account that owns them
   * (here the platform account behind ZG_MGMT_KEY), so a deposit to an agent's own zg_wallet funds no Router key.
   * Set this to the platform account (GET /v1/account/balance `address`) so top-ups pay for agent inference.
   * Unset keeps the old behaviour: deposit to the agent's zg_wallet.
   */
  ZG_DEPOSIT_RECIPIENT: address.optional(),
  /** Per-request guard: a TopUpRequested above this many USDC is not converted. */
  RELAYER_MAX_REQUEST_USD: num(2),
  RELAYER_POLL_SEC: num(15),
  /** JSON file holding the last processed Base block of TopUpRequested logs. */
  RELAYER_CURSOR_FILE: z.string().default(".relayer-cursor.json"),

  /** Base chain for Flash, USDC, the registry and treasury. Must match NEXT_PUBLIC_CHAIN in the web app. */
  CHAIN: z.enum(["base", "baseSepolia"]).default("baseSepolia"),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  PGLITE_DIR: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.WALLET_PROVIDER !== "privy") return;
  if (!env.PRIVY_APP_ID) ctx.addIssue({ code: "custom", path: ["PRIVY_APP_ID"], message: "required when WALLET_PROVIDER=privy" });
  if (!env.PRIVY_APP_SECRET) ctx.addIssue({ code: "custom", path: ["PRIVY_APP_SECRET"], message: "required when WALLET_PROVIDER=privy" });
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

/** Parses the worker env. Blank values are dropped first so defaults apply. */
export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value.trim();
  }
  return WorkerEnvSchema.parse(cleaned);
}

export type { Env };
