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
  MIN_ORDER_USD: num(0.1),
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
    minOrderUsd: env.MIN_ORDER_USD,
    maxAgentAllocationUsd: env.MAX_AGENT_ALLOCATION_USD,
    maxDailyVolumeUsdPerAgent: env.MAX_DAILY_VOLUME_USD_PER_AGENT,
    maxDailyLossUsdPerAgent: env.MAX_DAILY_LOSS_USD_PER_AGENT,
    maxOpenPositions: env.MAX_OPEN_POSITIONS,
    allowedTokens: env.ALLOWED_TOKENS,
    killSwitch: env.GLOBAL_KILL_SWITCH,
  };
}

/**
 * Converts a 0G Router cost into 0G. USD-mode accounts bill in micro-USD (converted at zgPerUsd, ~0G per USDC);
 * 0G-mode accounts bill in neuron (1e-18 0G). Unknown units are returned unchanged. Returns null if unparseable.
 */
export function billingTo0G(
  billing: string | null,
  unit: "usd_micro" | "neuron" | "0g" | null | undefined,
  zgPerUsd: number,
): string | null {
  if (billing === null) return null;
  const v = Number(billing);
  if (!Number.isFinite(v)) return null;
  if (unit === "usd_micro") return String((v / 1_000_000) * zgPerUsd);
  if (unit === "neuron") return String(v / 1e18);
  return billing;
}
