// Risk reading (asOf for the crash guard) and the forecast hit rule as the worker stores it.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertForecast, insertRisk, listForecastsByAgent, type Db } from "@arena/db";
import { createRiskSource, toMs } from "./risk.ts";
import { resolveDueForecasts } from "./forecasts.ts";
import { fakeMarket, fixedClock, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

describe("risk reading", () => {
  test("an onchain reading keeps its level and converts asOf from seconds to ms", async () => {
    const db = await freshDb();
    const source = createRiskSource({ db, clock: fixedClock(), readOnchain: async () => ({ level: 2, asOf: 1_762_000_000 }) });
    expect(await source.reading()).toEqual({ level: "HALT", asOf: 1_762_000_000_000 });
    expect(await source.current()).toBe("HALT");
  });

  test("when the chain read fails, the latest database row is used", async () => {
    const db = await freshDb();
    await insertRisk(db, { level: "CAUTION", reasonCode: 2, asOf: 1000 });
    const source = createRiskSource({
      db,
      clock: fixedClock(),
      readOnchain: async () => {
        throw new Error("rpc down");
      },
    });
    expect(await source.reading()).toEqual({ level: "CAUTION", asOf: 1000 });
  });

  test("with no state at all the level is NORMAL and asOf is unknown", async () => {
    const db = await freshDb();
    const source = createRiskSource({ db, clock: fixedClock() });
    expect(await source.reading()).toEqual({ level: "NORMAL", asOf: null });
  });

  test("a reading is cached for 30 seconds", async () => {
    const db = await freshDb();
    const clock = fixedClock();
    let reads = 0;
    const source = createRiskSource({
      db,
      clock,
      readOnchain: async () => {
        reads += 1;
        return { level: 0, asOf: 1 };
      },
    });
    await source.current();
    await source.current();
    expect(reads).toBe(1);
    clock.advance(31_000);
    await source.current();
    expect(reads).toBe(2);
  });

  test("toMs treats values below 1e12 as seconds", () => {
    expect(toMs(1_762_000_000)).toBe(1_762_000_000_000);
    expect(toMs(1_762_000_000_000)).toBe(1_762_000_000_000);
  });
});

describe("forecast hit rule end to end", () => {
  test("a flat forecast is a hit only inside ±0.2%, and an up forecast needs 25% of its expected move", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { assets: ["WETH", "cbBTC"] });
    const base = { agentId: agent.id, horizonMin: 60, expectedMovePct: 1, confidence: 0.5, resolveAt: NOW - 1, createdAt: NOW - 3_600_000 };
    // WETH moves +0.3%, cbBTC moves +0.1%.
    const wethFlat = await insertForecast(db, { ...base, asset: "WETH", direction: "flat", priceAtForecast: 2000 });
    const wethUp = await insertForecast(db, { ...base, asset: "WETH", direction: "up", priceAtForecast: 2000 });
    const btcFlat = await insertForecast(db, { ...base, asset: "cbBTC", direction: "flat", priceAtForecast: 60000 });
    const btcUp = await insertForecast(db, { ...base, asset: "cbBTC", direction: "up", priceAtForecast: 60000 });

    const market = fakeMarket({ WETH: 2006, cbBTC: 60060 });
    await resolveDueForecasts({ db, market, clock: fixedClock() });
    const byId = new Map((await listForecastsByAgent(db, agent.id)).map((f) => [f.id, f]));
    expect(byId.get(wethFlat)?.hit).toBe(false); // +0.3% is outside the ±0.2% flat band
    expect(byId.get(wethUp)?.hit).toBe(true); // +0.3% clears 25% of the expected 1%
    expect(byId.get(btcFlat)?.hit).toBe(true); // +0.1% is inside the flat band
    expect(byId.get(btcUp)?.hit).toBe(false); // +0.1% does not clear 25% of 1%
  });

  test("the old direction-only rule would have counted these as hits; the stored result does not", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    // +0.1%: the direction is right, but the move is less than 25% of the expected 1%.
    const id = await insertForecast(db, {
      agentId: agent.id, asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 1, confidence: 0.5,
      priceAtForecast: 2000, resolveAt: NOW - 1, createdAt: NOW - 3_600_000,
    });
    await resolveDueForecasts({ db, market: fakeMarket({ WETH: 2002 }), clock: fixedClock() });
    expect((await listForecastsByAgent(db, agent.id)).find((f) => f.id === id)?.hit).toBe(false);
  });
});
