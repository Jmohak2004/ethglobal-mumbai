import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Forecast, StoredForecast } from "@arena/shared";
import type { Db } from "../client.ts";
import { forecasts } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

export type { StoredForecast } from "@arena/shared";

/** A flat forecast hits when the absolute move is within this many percent (PRD 6.4). */
export const FLAT_BAND_PCT = 0.2;
/** An up or down forecast hits when the move is at least this fraction of expectedMovePct (PRD 6.4). */
export const MIN_MOVE_FRACTION = 0.25;

export interface InsertForecastInput extends Forecast {
  id?: string;
  agentId: string;
  episodeId?: string | null;
  priceAtForecast: number;
  resolveAt: number;
  createdAt?: number;
}

/**
 * Whether a forecast was right once resolved. The single hit rule used by resolveForecast and the worker.
 *   up / down: the price moved in the forecast direction, and the move is at least 25% of expectedMovePct.
 *   flat:      the absolute move is within ±0.2%.
 * A non-positive entry price or a non-finite resolved price never hits.
 */
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

/**
 * Legacy rule (direction only; flat within expectedMovePct). Kept so existing callers do not change.
 * New code should use forecastHit, which is what resolveForecast stores.
 * @deprecated Use forecastHit.
 */
export function scoreForecast(
  f: Pick<Forecast, "direction" | "expectedMovePct">,
  priceAtForecast: number,
  resolvedPrice: number,
): boolean {
  const movePct = ((resolvedPrice - priceAtForecast) / priceAtForecast) * 100;
  if (f.direction === "up") return movePct > 0;
  if (f.direction === "down") return movePct < 0;
  return Math.abs(movePct) <= f.expectedMovePct;
}

export async function insertForecast(db: Db, input: InsertForecastInput): Promise<string> {
  const id = input.id ?? newId();
  await db
    .insert(forecasts)
    .values({
      id,
      agentId: input.agentId,
      episodeId: input.episodeId ?? null,
      asset: input.asset,
      horizonMin: input.horizonMin,
      direction: input.direction,
      expectedMovePct: input.expectedMovePct,
      confidence: input.confidence,
      priceAtForecast: input.priceAtForecast,
      resolveAt: input.resolveAt,
      createdAt: input.createdAt ?? Date.now(),
    })
    .onConflictDoNothing({ target: forecasts.id });
  return id;
}

/** Unresolved forecasts whose resolveAt has passed, oldest first. */
export async function listDueForecasts(db: Db, now: number = Date.now(), limit = 200): Promise<StoredForecast[]> {
  const rows = await db
    .select()
    .from(forecasts)
    .where(and(isNull(forecasts.resolvedPrice), lte(forecasts.resolveAt, now)))
    .orderBy(asc(forecasts.resolveAt))
    .limit(clampLimit(limit, 200, 1000));
  return rows.map(toForecast);
}

/**
 * Records the resolved price and whether the forecast hit (forecastHit). Idempotent: an already-resolved
 * forecast is returned unchanged. Returns null if the forecast does not exist.
 */
export async function resolveForecast(db: Db, id: string, resolvedPrice: number): Promise<StoredForecast | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(forecasts).where(eq(forecasts.id, id)).for("update").limit(1);
    if (!current) return null;
    const forecast = toForecast(current);
    if (forecast.resolvedPrice !== null) return forecast;

    const hit = forecastHit(forecast, forecast.priceAtForecast, resolvedPrice);
    const [row] = await tx
      .update(forecasts)
      .set({ resolvedPrice, hit })
      .where(eq(forecasts.id, id))
      .returning();
    return row ? toForecast(row) : null;
  });
}

export async function listForecastsByAgent(db: Db, agentId: string, limit = 100): Promise<StoredForecast[]> {
  const rows = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.agentId, agentId))
    .orderBy(asc(forecasts.createdAt))
    .limit(clampLimit(limit, 100, 1000));
  return rows.map(toForecast);
}

function toForecast(row: typeof forecasts.$inferSelect): StoredForecast {
  return {
    id: row.id,
    agentId: row.agentId,
    asset: row.asset,
    horizonMin: row.horizonMin,
    direction: row.direction as Forecast["direction"],
    expectedMovePct: row.expectedMovePct,
    confidence: row.confidence,
    ts: row.createdAt,
    priceAtForecast: row.priceAtForecast,
    resolveAt: row.resolveAt,
    resolvedPrice: row.resolvedPrice,
    hit: row.hit,
  };
}
