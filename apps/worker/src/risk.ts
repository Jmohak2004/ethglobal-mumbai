// Platform risk level (RiskOracle). Order: onchain getRisk() when RISK_ORACLE_ADDRESS is set, then the
// latest risk_states row, then NORMAL. Cached for 30 s. The reading includes the report's asOf, which the
// crash guard uses to act once per HALT report.

import { latestRisk, type Db } from "@arena/db";
import { RISK_LEVELS, type RiskLevel } from "@arena/shared";
import type { PublicClient } from "viem";
import { RISK_ORACLE_ABI } from "./abi.ts";
import type { Clock, RiskReading, RiskSource } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export const RISK_CACHE_MS = 30_000;

export interface RiskSourceOptions {
  db: Db;
  clock: Clock;
  /** Reads RiskOracle.getRisk(). Omit when RISK_ORACLE_ADDRESS is not configured. */
  readOnchain?: () => Promise<{ level: number; asOf: number | null }>;
  logger?: Logger;
  cacheMs?: number;
}

/** RiskOracle asOf is uint64 seconds; the database stores unix ms. Values below 1e12 are seconds. */
export const toMs = (asOf: number): number => (asOf < 1e12 ? asOf * 1000 : asOf);

export function createRiskSource(opts: RiskSourceOptions): RiskSource {
  const logger = opts.logger ?? silentLogger;
  const cacheMs = opts.cacheMs ?? RISK_CACHE_MS;
  let cached: { at: number; reading: RiskReading } | null = null;

  const read = async (): Promise<RiskReading> => {
    if (cached && opts.clock.now() - cached.at < cacheMs) return cached.reading;

    let reading: RiskReading | null = null;
    if (opts.readOnchain) {
      try {
        const raw = await opts.readOnchain();
        const level: RiskLevel | undefined = RISK_LEVELS[raw.level];
        if (level) reading = { level, asOf: raw.asOf === null ? null : toMs(raw.asOf) };
      } catch (err) {
        logger.warn("RiskOracle read failed, falling back to the database", { error: err });
      }
    }
    if (!reading) {
      const row = await latestRisk(opts.db);
      reading = row ? { level: row.level, asOf: row.asOf } : { level: "NORMAL", asOf: null };
    }
    cached = { at: opts.clock.now(), reading };
    return reading;
  };

  return {
    async current() {
      return (await read()).level;
    },
    reading: read,
  };
}

/** Onchain reader for RiskOracle.getRisk(). Returns the uint8 level (0 NORMAL, 1 CAUTION, 2 HALT) and asOf. */
export function riskOracleReader(client: PublicClient, address: `0x${string}`): () => Promise<{ level: number; asOf: number }> {
  return async () => {
    const risk = (await client.readContract({ address, abi: RISK_ORACLE_ABI, functionName: "getRisk" })) as {
      level: number;
      asOf: bigint;
    };
    return { level: Number(risk.level), asOf: Number(risk.asOf) };
  };
}
