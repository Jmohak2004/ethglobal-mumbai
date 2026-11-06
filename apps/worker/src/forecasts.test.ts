import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertForecast, type Db } from "@arena/db";
import { forecastHit, resolveDueForecasts } from "./forecasts.ts";
import { fakeMarket, fixedClock, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

describe("forecastHit", () => {
  const up = { direction: "up" as const, expectedMovePct: 1 };
  const down = { direction: "down" as const, expectedMovePct: 1 };
  const flat = { direction: "flat" as const, expectedMovePct: 1 };

  test("up hits when the price rises at least 25% of the expected move", () => {
    expect(forecastHit(up, 100, 100.25)).toBe(true); // +0.25%, exactly 25% of 1%
    expect(forecastHit(up, 100, 100.5)).toBe(true);
  });

  test("up misses when the rise is smaller than 25% of the expected move, or the direction is wrong", () => {
    expect(forecastHit(up, 100, 100.1)).toBe(false); // +0.1%
    expect(forecastHit(up, 100, 99.9)).toBe(false);
  });

  test("down mirrors up", () => {
    expect(forecastHit(down, 100, 99.5)).toBe(true);
    expect(forecastHit(down, 100, 99.9)).toBe(false);
    expect(forecastHit(down, 100, 100.5)).toBe(false);
  });

  test("flat hits when the absolute move is within ±0.2%", () => {
    expect(forecastHit(flat, 100, 100.19)).toBe(true);
    expect(forecastHit(flat, 100, 99.81)).toBe(true);
    expect(forecastHit(flat, 100, 100.3)).toBe(false);
  });

  test("a non-positive entry price never hits", () => {
    expect(forecastHit(up, 0, 10)).toBe(false);
  });
});

describe("resolveDueForecasts", () => {
  test("resolves due forecasts against the current price and stores the hit", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const due = await insertForecast(db, {
      agentId: agent.id,
      asset: "WETH",
      horizonMin: 60,
      direction: "up",
      expectedMovePct: 1,
      confidence: 0.7,
      priceAtForecast: 2000,
      resolveAt: NOW - 1,
      createdAt: NOW - 60 * 60_000,
    });
    const notDue = await insertForecast(db, {
      agentId: agent.id,
      asset: "WETH",
      horizonMin: 60,
      direction: "up",
      expectedMovePct: 1,
      confidence: 0.7,
      priceAtForecast: 2000,
      resolveAt: NOW + 60_000,
      createdAt: NOW,
    });

    const market = fakeMarket({ WETH: 2100 }); // +5%, a hit for "up"
    const res = await resolveDueForecasts({ db, market, clock: fixedClock() });
    expect(res).toEqual({ due: 1, resolved: 1, failed: 0 });

    const row = await db.query.forecasts.findFirst({ where: (f, { eq }) => eq(f.id, due) });
    expect(row?.resolvedPrice).toBe(2100);
    expect(row?.hit).toBe(true);
    expect(row?.agentId).toBe(agent.id);
    expect(row?.episodeId).toBeNull();

    const untouched = await db.query.forecasts.findFirst({ where: (f, { eq }) => eq(f.id, notDue) });
    expect(untouched?.resolvedPrice).toBeNull();
  });

  test("a miss is stored as hit=false, and a failed price read leaves the row for the next pass", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    const missId = await insertForecast(db, {
      agentId: agent.id,
      asset: "WETH",
      horizonMin: 60,
      direction: "down",
      expectedMovePct: 1,
      confidence: 0.6,
      priceAtForecast: 2000,
      resolveAt: NOW - 1,
      createdAt: NOW - 3_600_000,
    });
    const retryId = await insertForecast(db, {
      agentId: agent.id,
      asset: "cbBTC",
      horizonMin: 60,
      direction: "flat",
      expectedMovePct: 1,
      confidence: 0.6,
      priceAtForecast: 60000,
      resolveAt: NOW - 2,
      createdAt: NOW - 3_600_000,
    });

    const market = fakeMarket({ WETH: 2010 });
    market.failAsset("cbBTC");
    const res = await resolveDueForecasts({ db, market, clock: fixedClock() });
    expect(res).toEqual({ due: 2, resolved: 1, failed: 1 });

    const miss = await db.query.forecasts.findFirst({ where: (f, { eq }) => eq(f.id, missId) });
    expect(miss?.hit).toBe(false);
    const retry = await db.query.forecasts.findFirst({ where: (f, { eq }) => eq(f.id, retryId) });
    expect(retry?.resolvedPrice).toBeNull();
  });
});
