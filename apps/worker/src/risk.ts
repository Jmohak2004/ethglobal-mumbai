// Platform risk level (RiskOracle). Order: onchain getRisk() when RISK_ORACLE_ADDRESS is set, then the
// latest risk_states row, then NORMAL. Cached for 30 s.

import { latestRisk, type Db } from "@arena/db";
import { RISK_LEVELS, type RiskLevel } from "@arena/shared";
import type { PublicClient } from "viem";
import { RISK_ORACLE_ABI } from "./abi.ts";
import type { Clock, RiskSource } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export const RISK_CACHE_MS = 30_000;

export interface RiskSourceOptions {
  db: Db;
  clock: Clock;
  /** Reads RiskOracle.getRisk().level. Omit when RISK_ORACLE_ADDRESS is not configured. */
  readOnchain?: () => Promise<number>;
  logger?: Logger;
  cacheMs?: number;
}

export function createRiskSource(opts: RiskSourceOptions): RiskSource {
  const logger = opts.logger ?? silentLogger;
  const cacheMs = opts.cacheMs ?? RISK_CACHE_MS;
  let cached: { at: number; level: RiskLevel } | null = null;

  return {
    async current() {
      if (cached && opts.clock.now() - cached.at < cacheMs) return cached.level;

      let level: RiskLevel | null = null;
      if (opts.readOnchain) {
        try {
          const raw = await opts.readOnchain();
          level = RISK_LEVELS[raw] ?? null;
        } catch (err) {
          logger.warn("RiskOracle read failed, falling back to the database", { error: err });
        }
      }
      if (!level) {
        const row = await latestRisk(opts.db);
        level = row?.level ?? "NORMAL";
      }
      cached = { at: opts.clock.now(), level };
      return level;
    },
  };
}

/** Onchain reader for RiskOracle.getRisk(). Returns the uint8 level (0 NORMAL, 1 CAUTION, 2 HALT). */
export function riskOracleReader(client: PublicClient, address: `0x${string}`): () => Promise<number> {
  return async () => {
    const risk = (await client.readContract({ address, abi: RISK_ORACLE_ABI, functionName: "getRisk" })) as { level: number };
    return Number(risk.level);
  };
}
