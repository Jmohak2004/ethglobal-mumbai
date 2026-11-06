// Forecast resolution (PRD 6.4). Due forecasts are scored against the current Chainlink price.
// The hit rule lives in @arena/db (forecastHit) and is the one resolveForecast stores:
//   - up:   the price moved up, and the move is at least 25% of expectedMovePct.
//   - down: the price moved down, and the move is at least 25% of expectedMovePct.
//   - flat: the absolute move is within ±0.2%.

import { listDueForecasts, resolveForecast, type Db } from "@arena/db";
import type { Clock, MarketData } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export { forecastHit, FLAT_BAND_PCT, MIN_MOVE_FRACTION } from "@arena/db";

export interface ResolveResult {
  due: number;
  resolved: number;
  failed: number;
}

export interface ResolveOptions {
  db: Db;
  market: MarketData;
  clock: Clock;
  logger?: Logger;
  limit?: number;
}

/** Scores every forecast whose resolveAt has passed. Failures are logged and retried on the next pass. */
export async function resolveDueForecasts(opts: ResolveOptions): Promise<ResolveResult> {
  const logger = opts.logger ?? silentLogger;
  const due = await listDueForecasts(opts.db, opts.clock.now(), opts.limit ?? 200);
  let resolved = 0;
  let failed = 0;

  for (const f of due) {
    try {
      const resolvedPrice = await opts.market.getPrice(f.asset);
      // resolveForecast is idempotent: a row resolved by another pass is returned unchanged.
      const row = await resolveForecast(opts.db, f.id, resolvedPrice);
      resolved += 1;
      logger.info("forecast resolved", { agent: f.agentId, forecast: f.id, asset: f.asset, hit: row?.hit ?? null });
    } catch (err) {
      failed += 1;
      logger.warn("forecast resolution failed", { agent: f.agentId, forecast: f.id, error: err });
    }
  }
  return { due: due.length, resolved, failed };
}
