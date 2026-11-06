// Forecast resolution (PRD 6.4). Due forecasts are scored against the current Chainlink price.
//
// Hit rule:
//   - up:   the price moved up, and the move is at least 25% of expectedMovePct.
//   - down: the price moved down, and the move is at least 25% of expectedMovePct.
//   - flat: the absolute move is within ±0.2%.
//
// The db package's resolveForecast scores with a different rule (direction only, flat within
// expectedMovePct), so this module writes the result itself through an upsert. See the report.

import { forecasts, listDueForecasts, type Db, type StoredForecast } from "@arena/db";
import type { Forecast } from "@arena/shared";
import type { Clock, MarketData } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export const FLAT_BAND_PCT = 0.2;
export const MIN_MOVE_FRACTION = 0.25;

/** Whether a forecast was right, given the price when it was made and the price at resolution. */
export function forecastHit(
  forecast: Pick<Forecast, "direction" | "expectedMovePct">,
  priceAtForecast: number,
  resolvedPrice: number,
): boolean {
  if (!(priceAtForecast > 0) || !Number.isFinite(resolvedPrice)) return false;
  const movePct = ((resolvedPrice - priceAtForecast) / priceAtForecast) * 100;
  if (forecast.direction === "flat") return Math.abs(movePct) <= FLAT_BAND_PCT;
  const directionMatched = forecast.direction === "up" ? movePct > 0 : movePct < 0;
  return directionMatched && Math.abs(movePct) >= MIN_MOVE_FRACTION * forecast.expectedMovePct;
}

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
      const hit = forecastHit(f, f.priceAtForecast, resolvedPrice);
      await writeResolution(opts.db, f, resolvedPrice, hit);
      resolved += 1;
      logger.info("forecast resolved", { agent: f.agentId, forecast: f.id, asset: f.asset, hit });
    } catch (err) {
      failed += 1;
      logger.warn("forecast resolution failed", { agent: f.agentId, forecast: f.id, error: err });
    }
  }
  return { due: due.length, resolved, failed };
}

/** Upserts the resolved row by id. Only resolves rows still unresolved, so re-running is harmless. */
async function writeResolution(db: Db, f: StoredForecast, resolvedPrice: number, hit: boolean): Promise<void> {
  if (f.resolvedPrice !== null) return;
  await db
    .insert(forecasts)
    .values({
      id: f.id,
      agentId: f.agentId,
      episodeId: f.episodeId,
      asset: f.asset,
      horizonMin: f.horizonMin,
      direction: f.direction,
      expectedMovePct: f.expectedMovePct,
      confidence: f.confidence,
      priceAtForecast: f.priceAtForecast,
      resolveAt: f.resolveAt,
      resolvedPrice,
      hit,
      createdAt: f.createdAt,
    })
    .onConflictDoUpdate({ target: forecasts.id, set: { resolvedPrice, hit } });
}
