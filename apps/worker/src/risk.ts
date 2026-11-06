// Platform risk level. Reads both the onchain RiskOracle (written by the CRE Crash Sentinel) and the latest
// risk_states row (written by the web Demo menu or by this mirror), and uses whichever report is newer.
// A newer onchain report is mirrored into risk_states so the web pill and Telegram show it. NORMAL when
// neither exists. Cached for 30 s. The reading includes asOf, which the crash guard uses to act once per HALT.

import { insertRisk, latestRisk, type Db } from "@arena/db";
import { RISK_LEVELS, type RiskLevel, type RiskReason } from "@arena/shared";
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
  readOnchain?: () => Promise<{ level: number; asOf: number | null; reasonCode?: number }>;
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

    let onchain: (RiskReading & { reasonCode: number }) | null = null;
    if (opts.readOnchain) {
      try {
        const raw = await opts.readOnchain();
        const level: RiskLevel | undefined = RISK_LEVELS[raw.level];
        // asOf 0 means the oracle has never been written.
        if (level && raw.asOf) onchain = { level, asOf: toMs(raw.asOf), reasonCode: raw.reasonCode ?? 0 };
      } catch (err) {
        logger.warn("RiskOracle read failed, using the database", { error: err });
      }
    }
    const row = await latestRisk(opts.db);
    let reading: RiskReading;
    if (onchain && (!row || (onchain.asOf ?? 0) > row.asOf)) {
      reading = { level: onchain.level, asOf: onchain.asOf };
      try {
        // Deterministic id, so repeated reads of the same report don't duplicate rows.
        await insertRisk(opts.db, {
          id: `onchain-${onchain.asOf}`,
          level: onchain.level,
          reasonCode: onchain.reasonCode as RiskReason,
          asOf: onchain.asOf ?? 0,
        });
      } catch {
        // Already mirrored.
      }
    } else {
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
export function riskOracleReader(
  client: PublicClient,
  address: `0x${string}`,
): () => Promise<{ level: number; asOf: number; reasonCode: number }> {
  return async () => {
    const risk = (await client.readContract({ address, abi: RISK_ORACLE_ABI, functionName: "getRisk" })) as {
      level: number;
      reasonCode: number;
      asOf: bigint;
    };
    return { level: Number(risk.level), asOf: Number(risk.asOf), reasonCode: Number(risk.reasonCode) };
  };
}
