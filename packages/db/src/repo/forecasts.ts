import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Forecast } from "@arena/shared";
import type { Db } from "../client.ts";
import { forecasts } from "../schema.ts";
import { clampLimit, newId } from "./util.ts";

/**
 * A forecast as stored. Extends the shared Forecast with the fields PRD 6.4 needs for resolution.
 * (Forecast in @arena/shared does not carry them yet; see the report.)
 */
export interface StoredForecast extends Forecast {
  id: string;
  agentId: string;
  episodeId: string | null;
  priceAtForecast: number;
  resolveAt: number;
  resolvedPrice: number | null;
  hit: boolean | null;
  createdAt: number;
}

export interface InsertForecastInput extends Forecast {
  id?: string;
  agentId: string;
  episodeId?: string | null;
  priceAtForecast: number;
  resolveAt: number;
  createdAt?: number;
}

/**
 * Whether a forecast was correct once resolved.
 * up: price rose. down: price fell. flat: absolute move within expectedMovePct.
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
 * Records the resolved price and computes hit. Idempotent: an already-resolved forecast is returned
 * unchanged. Returns null if the forecast does not exist.
 */
export async function resolveForecast(
  db: Db,
  id: string,
  resolvedPrice: number,
): Promise<StoredForecast | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(forecasts).where(eq(forecasts.id, id)).for("update").limit(1);
    if (!current) return null;
    const forecast = toForecast(current);
    if (forecast.resolvedPrice !== null) return forecast;

    const hit = scoreForecast(forecast, forecast.priceAtForecast, resolvedPrice);
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
    episodeId: row.episodeId,
    asset: row.asset,
    horizonMin: row.horizonMin,
    direction: row.direction as Forecast["direction"],
    expectedMovePct: row.expectedMovePct,
    confidence: row.confidence,
    priceAtForecast: row.priceAtForecast,
    resolveAt: row.resolveAt,
    resolvedPrice: row.resolvedPrice,
    hit: row.hit,
    createdAt: row.createdAt,
  };
}
