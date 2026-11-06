import { z } from "zod";
import type { GlobalLimits } from "./types.ts";

const num = (d: number) => z.coerce.number().default(d);
const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? d : v === "true" || v === "1"));

/** Platform-wide env config. Every money limit is tiny by default and overridable via env. */
export const EnvSchema = z.object({
  EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),
  NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  GLOBAL_KILL_SWITCH: bool(false),
  MAX_TRADE_USD: num(1),
  MAX_AGENT_ALLOCATION_USD: num(5),
  MAX_DAILY_VOLUME_USD_PER_AGENT: num(20),
  MAX_DAILY_LOSS_USD_PER_AGENT: num(1),
  MAX_OPEN_POSITIONS: num(2),
  ALLOWED_TOKENS: z.string().default("WETH,cbBTC").transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean)),
  FLASH_INTEGRATOR_FEE_BPS: num(10),
  COMMISSION_BPS_DEFAULT: num(1000),
  COMMISSION_BPS_MIN: num(0),
  COMMISSION_BPS_MAX: num(2000),
  FORK_PLATFORM_BPS: num(3000),
  AGENT_DAILY_0G_CAP: num(1),
  RESERVE_DAYS: num(3),
  MIN_TOPUP_USD: num(0.5),
  MAX_TOPUP_PER_DAY_USD: num(2),
  RELAYER_SPREAD_BPS: num(100),
  TICK_INTERVAL_DEFAULT_SEC: num(300),
  DATABASE_URL: z.string().optional(),
  DEFINITIVE_API_KEY: z.string().optional(),
  ZG_API_KEY: z.string().optional(),
  ZG_ROUTER_URL: z.string().optional(),
  BASE_RPC_URL: z.string().default("https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: z.string().default("https://sepolia.base.org"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}

export function globalLimitsFromEnv(env: Env): GlobalLimits {
  return {
    maxTradeUsd: env.MAX_TRADE_USD,
    maxAgentAllocationUsd: env.MAX_AGENT_ALLOCATION_USD,
    maxDailyVolumeUsdPerAgent: env.MAX_DAILY_VOLUME_USD_PER_AGENT,
    maxDailyLossUsdPerAgent: env.MAX_DAILY_LOSS_USD_PER_AGENT,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
    allowedTokens: env.ALLOWED_TOKENS,
    killSwitch: env.GLOBAL_KILL_SWITCH,
  };
}
