import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import type { Episode, StrategyConfig } from "@arena/shared";
import * as schema from "./schema.ts";
import {
  ConfigVersionConflictError,
  closeDb,
  countForks,
  createAgent,
  createDb,
  createTopup,
  getAgent,
  getConfigVersion,
  getEpisode,
  getUser,
  insertEpisode,
  insertFills,
  insertForecast,
  insertFork,
  insertInference,
  insertLesson,
  insertRisk,
  latestRisk,
  leaderboard,
  listDueForecasts,
  listEpisodesByAgent,
  listFillsByAgent,
  listForecastsByAgent,
  listPublic,
  listByOwner,
  migrate,
  migrationStatements,
  resolveForecast,
  scoreForecast,
  setAgentStatus,
  sumBillingSince,
  subscribeTelegram,
  listTelegramSubscribers,
  listTelegramSubscriptions,
  topForAgent,
  unsubscribeTelegram,
  updateConfig,
  upsertOrder,
  upsertStats,
  upsertUser,
  insertGuardrailBlock,
  listGuardrailBlocks,
  listFillsByFunder,
  updateTopup,
  type Db,
  type StatsInput,
} from "./index.ts";
import { seedDemo } from "./seed.ts";

const OWNER = "0xAbCDEF0000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

function config(template: StrategyConfig["template"] = "momentum", commissionBps = 1000): StrategyConfig {
  return {
    template,
    assets: ["WETH", "cbBTC"],
    sliders: { sizePct: 0.2, tpPct: 3, slPct: 2 },
    limits: {
      maxTradeUsd: 1,
      maxOpenPositions: 2,
      maxAllocationUsd: 5,
      maxDailyLossUsd: 1,
      maxDrawdownPct: 15,
      cooldownSec: 900,
    },
    tickIntervalSec: 300,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps,
    autoTune: { enabled: false, maxDeltaPct: 0 },
    publicCommentary: "off",
    insightSources: [],
    fork: { forkable: true, priceUsd: 2 },
  };
}

let db: Db;
beforeEach(async () => {
  db = createDb({ memory: true });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
});

async function newAgent(
  opts: { id?: string; owner?: string; template?: StrategyConfig["template"]; createdAt?: number; mode?: "paper" | "live" } = {},
) {
  return createAgent(db, {
    id: opts.id,
    name: opts.id ?? "agent",
    ownerAddress: opts.owner ?? OWNER,
    tradingWallet: ADDR(100),
    config: config(opts.template ?? "momentum"),
    configHash: H(1),
    createdAt: opts.createdAt ?? 1_000,
    mode: opts.mode,
  });
}

function episode(agentId: string, ts: number, id = `ep-${agentId}-${ts}`, extra: Partial<Episode> = {}): Episode {
  return {
    id,
    agentId,
    ts,
    riskLevel: "NORMAL",
    budgetTier: "healthy",
    market: [{ asset: "WETH", priceUsd: 3000, indicators: { emaFast: 1, emaSlow: 1, rsi14: 50, atr14: 1, rocPct: 0, rangeHigh: 1, rangeLow: 1, volatilityPct: 1 } }],
    decision: null,
    inference: null,
    verdict: { kind: "noop", reasons: ["hold"] },
    flashOrderIds: [],
    zgStorageRoot: null,
    error: null,
    ...extra,
  };
}

function stats(overrides: Partial<StatsInput> & Pick<StatsInput, "entityId">): StatsInput {
  return {
    kind: "agent",
    name: overrides.entityId,
    template: "momentum",
    mode: "paper",
    realizedPnlUsd: 0,
    realizedPnlPct: 0,
    volumeUsd: 0,
    trades: 0,
    winRateBps: 0,
    maxDrawdownBps: 0,
    forecastHitRateBps: 0,
    daysActive: 0,
    verified: null,
    selfFunded: false,
    ...overrides,
  };
}

/** Raw SQL rows. PGlite returns { rows }, postgres-js returns an array. */
async function rawRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}

async function tableNames(): Promise<string[]> {
  const rows = await rawRows<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe("migrations", () => {
  test("migrate is idempotent and preserves data", async () => {
    await migrate(db);
    await upsertUser(db, { address: OWNER, displayName: "keep me" });
    await migrate(db);
    await migrate(db);
    expect((await getUser(db, OWNER))?.displayName).toBe("keep me");
    const expected = Object.values(schema).filter((v) => is(v, PgTable)).length;
    expect((await tableNames()).length).toBe(expected);
  });

  test("schema.sql has the same columns as schema.ts for every table", async () => {
    const tables = Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[];
    expect(tables.length).toBeGreaterThan(20);
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const rows = await rawRows<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${cfg.name}`,
      );
      const dbCols = rows.map((r) => r.column_name).sort();
      const tsCols = cfg.columns.map((c) => c.name).sort();
      expect({ table: cfg.name, cols: dbCols }).toEqual({ table: cfg.name, cols: tsCols });
    }
  });

  test("migration statements contain no comments and each starts with CREATE", () => {
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThan(40);
    for (const s of statements) {
      expect(s.startsWith("CREATE ")).toBe(true);
      expect(s.includes("--")).toBe(false);
    }
  });

  test("persistent PGlite data survives close and reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-db-"));
    try {
      const first = createDb({ pgliteDir: dir });
      await migrate(first);
      await upsertUser(first, { address: OWNER, displayName: "persisted" });
      await closeDb(first);

      const second = createDb({ pgliteDir: dir });
      await migrate(second);
      expect((await getUser(second, OWNER))?.displayName).toBe("persisted");
      await closeDb(second);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("agents", () => {
  test("create, get and owner listing", async () => {
    const created = await newAgent({ id: "agent-1" });
    expect(created.ownerAddress).toBe(OWNER.toLowerCase() as `0x${string}`);
    expect(created.configVersion).toBe(1);
    expect(created.status).toBe("active");
    expect(created.mode).toBe("paper");

    const fetched = await getAgent(db, "agent-1");
    expect(fetched).toEqual(created);
    expect(await getAgent(db, "missing")).toBeNull();

    expect((await listByOwner(db, OWNER)).map((a) => a.id)).toEqual(["agent-1"]);
    expect(await listByOwner(db, OTHER)).toEqual([]);
    expect((await getUser(db, OWNER))?.address).toBe(OWNER.toLowerCase());
  });

  test("updateConfig bumps the version, keeps history, and enforces expectedVersion", async () => {
    await newAgent({ id: "agent-1" });
    const v2 = await updateConfig(db, "agent-1", {
      config: config("breakout"),
      configHash: H(2),
      changelog: "auto-tune: sizePct +5%",
      expectedVersion: 1,
    });
    expect(v2.configVersion).toBe(2);
    expect(v2.configHash).toBe(H(2));
    expect(v2.config.template).toBe("breakout");

    const v1 = await getConfigVersion(db, "agent-1", 1);
    expect(v1?.configHash).toBe(H(1));
    expect(v1?.config.template).toBe("momentum");
    const stored2 = await getConfigVersion(db, "agent-1", 2);
    expect(stored2?.changelog).toBe("auto-tune: sizePct +5%");

    await expect(
      updateConfig(db, "agent-1", { config: config(), configHash: H(3), expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConfigVersionConflictError);
    expect((await getAgent(db, "agent-1"))?.configVersion).toBe(2);

    // The denormalized template follows the config.
    const pub = await listPublic(db);
    expect(pub[0]?.template).toBe("breakout");
  });

  test("listPublic hides stopped agents and returns no config", async () => {
    await newAgent({ id: "a-active" });
    await newAgent({ id: "a-stopped" });
    await setAgentStatus(db, "a-stopped", "stopped");
    const pub = await listPublic(db);
    expect(pub.map((p) => p.id)).toEqual(["a-active"]);
    expect(pub[0]).not.toHaveProperty("config");
    expect(pub[0]).not.toHaveProperty("ownerAddress");
  });

  test("setAgentStatus returns null for unknown ids", async () => {
    expect(await setAgentStatus(db, "nope", "paused")).toBeNull();
  });
});

describe("episodes", () => {
  test("insert, list newest first, paginate by beforeTs, and round-trip nullable jsonb", async () => {
    await newAgent({ id: "agent-1" });
    await insertEpisode(db, episode("agent-1", 1000, "e1"));
    await insertEpisode(db, episode("agent-1", 2000, "e2"));
    await insertEpisode(db, episode("agent-1", 3000, "e3", {
      inference: {
        requestId: "demo-zg-req-x",
        model: "m",
        provider: null,
        billing: "10",
        teeVerified: true,
        latencyMs: 5,
        payer: "agent",
      },
      verdict: { kind: "reject", reasons: ["cap"] },
      flashOrderIds: ["o1"],
    }));

    const page1 = await listEpisodesByAgent(db, "agent-1", { limit: 2 });
    expect(page1.map((e) => e.id)).toEqual(["e3", "e2"]);
    const page2 = await listEpisodesByAgent(db, "agent-1", { limit: 2, beforeTs: page1[1]!.ts });
    expect(page2.map((e) => e.id)).toEqual(["e1"]);

    const e3 = await getEpisode(db, "e3");
    expect(e3?.decision).toBeNull();
    expect(e3?.inference?.requestId).toBe("demo-zg-req-x");
    expect(e3?.verdict).toEqual({ kind: "reject", reasons: ["cap"] });
    expect(e3?.flashOrderIds).toEqual(["o1"]);

    // Stored zg_request_id column is the indexed copy of inference.requestId.
    const rows = await rawRows<{ zg_request_id: string | null }>(
      sql`select zg_request_id from episodes where id = 'e3'`,
    );
    expect(rows[0]?.zg_request_id).toBe("demo-zg-req-x");
  });

  test("insert is idempotent on id", async () => {
    await newAgent({ id: "agent-1" });
    await insertEpisode(db, episode("agent-1", 1000, "dup"));
    await insertEpisode(db, episode("agent-1", 1000, "dup"));
    expect((await listEpisodesByAgent(db, "agent-1")).length).toBe(1);
  });
});

describe("forecasts and lessons", () => {
  test("scoreForecast applies direction rules", () => {
    expect(scoreForecast({ direction: "up", expectedMovePct: 1 }, 100, 101)).toBe(true);
    expect(scoreForecast({ direction: "up", expectedMovePct: 1 }, 100, 99)).toBe(false);
    expect(scoreForecast({ direction: "down", expectedMovePct: 1 }, 100, 99)).toBe(true);
    expect(scoreForecast({ direction: "flat", expectedMovePct: 1 }, 100, 100.5)).toBe(true);
    expect(scoreForecast({ direction: "flat", expectedMovePct: 1 }, 100, 102)).toBe(false);
  });

  test("insert, list due, resolve once, and list by agent", async () => {
    await newAgent({ id: "agent-1" });
    const id = await insertForecast(db, {
      agentId: "agent-1",
      asset: "WETH",
      horizonMin: 60,
      direction: "up",
      expectedMovePct: 0.5,
      confidence: 0.7,
      priceAtForecast: 3000,
      resolveAt: 5000,
      createdAt: 1000,
    });
    expect(await listDueForecasts(db, 4999)).toEqual([]);
    const due = await listDueForecasts(db, 5000);
    expect(due.map((f) => f.id)).toEqual([id]);

    const resolved = await resolveForecast(db, id, 3030);
    expect(resolved?.hit).toBe(true);
    expect(resolved?.resolvedPrice).toBe(3030);

    // A second resolution does not overwrite the first.
    const again = await resolveForecast(db, id, 2000);
    expect(again?.resolvedPrice).toBe(3030);
    expect(again?.hit).toBe(true);

    expect(await listDueForecasts(db, 10_000)).toEqual([]);
    expect(await resolveForecast(db, "missing", 1)).toBeNull();
    expect((await listForecastsByAgent(db, "agent-1")).length).toBe(1);
  });

  test("topForAgent orders by confidence and respects asOf", async () => {
    await newAgent({ id: "agent-1" });
    const base = { agentId: "agent-1", evidenceEpisodeIds: [], appliesTo: ["WETH"], zgStorageRoot: null };
    await insertLesson(db, { ...base, id: "l1", ts: 100, lesson: "a", confidence: 0.5 });
    await insertLesson(db, { ...base, id: "l2", ts: 200, lesson: "b", confidence: 0.9 });
    await insertLesson(db, { ...base, id: "l3", ts: 300, lesson: "c", confidence: 0.7 });
    expect((await topForAgent(db, "agent-1", { k: 2 })).map((l) => l.id)).toEqual(["l2", "l3"]);
    expect((await topForAgent(db, "agent-1", { k: 5, asOf: 250 })).map((l) => l.id)).toEqual(["l2", "l1"]);
  });
});

describe("inference and billing", () => {
  test("sumBillingSince sums only the agent's calls after ts, as a decimal string", async () => {
    await newAgent({ id: "agent-1" });
    const trace = (requestId: string, billing: string | null) => ({
      requestId,
      model: "m",
      provider: null,
      billing,
      teeVerified: true,
      latencyMs: 1,
      payer: "agent" as const,
    });
    await insertInference(db, trace("r1", "100"), { agentId: "agent-1", ts: 1000 });
    await insertInference(db, trace("r2", "250"), { agentId: "agent-1", ts: 2000 });
    await insertInference(db, trace("r3", null), { agentId: "agent-1", ts: 2000 });
    await insertInference(db, trace("r4", "9999"), { agentId: null, userAddress: OWNER, ts: 2000 });
    expect(await sumBillingSince(db, "agent-1", 0)).toBe("350");
    expect(await sumBillingSince(db, "agent-1", 1500)).toBe("250");
    expect(await sumBillingSince(db, "agent-1", 9999)).toBe("0");
    // Idempotent on requestId.
    await insertInference(db, trace("r1", "100"), { agentId: "agent-1", ts: 1000 });
    expect(await sumBillingSince(db, "agent-1", 0)).toBe("350");
  });
});

describe("orders and fills", () => {
  test("upsertOrder updates status, insertFills is idempotent, and fills list by agent and funder", async () => {
    await newAgent({ id: "agent-1" });
    const order = {
      id: "flash-1",
      agentId: "agent-1",
      funderAddress: ADDR(100),
      side: "buy" as const,
      asset: "WETH",
      orderType: "limit" as const,
      notionalUsd: 1,
      status: "open",
      createdAt: 1000,
      updatedAt: 1000,
    };
    await upsertOrder(db, order);
    await upsertOrder(db, { ...order, status: "filled", updatedAt: 2000, raw: { ok: true } });

    const fill = {
      id: "fill-1",
      orderId: "flash-1",
      price: 3000,
      qty: 0.0003,
      notionalUsd: 1,
      feeUsd: 0.001,
      integratorFeeUsd: 0.001,
      txId: "0xtx",
      ts: 2000,
    };
    await insertFills(db, [fill]);
    await insertFills(db, [fill]);

    const byAgent = await listFillsByAgent(db, "agent-1");
    expect(byAgent).toEqual([fill]);
    expect((await listFillsByFunder(db, ADDR(100))).length).toBe(1);
    expect(await listFillsByAgent(db, "agent-other")).toEqual([]);

    const rows = await rawRows<{ status: string }>(sql`select status from orders where id = 'flash-1'`);
    expect(rows[0]?.status).toBe("filled");
  });
});

describe("treasury and top-ups", () => {
  test("createTopup then updateTopup records the relayer progress", async () => {
    await newAgent({ id: "agent-1" });
    const t = await createTopup(db, {
      agentId: "agent-1",
      usdcAmount: 0.5,
      baseTx: H(7),
      zgTransferTx: null,
      depositTx: null,
      firstPaidRequestId: null,
    });
    expect(t.status).toBe("pending");
    const updated = await updateTopup(db, t.id, { status: "credited", depositTx: H(8), firstPaidRequestId: "zg-req-1" });
    expect(updated?.status).toBe("credited");
    expect(updated?.depositTx).toBe(H(8));
    expect(updated?.baseTx).toBe(H(7));
    expect(await updateTopup(db, "missing", { status: "x" })).toBeNull();
  });
});

describe("risk and attestations", () => {
  test("latestRisk is null when empty, then returns the newest asOf", async () => {
    expect(await latestRisk(db)).toBeNull();
    await insertRisk(db, { level: "NORMAL", reasonCode: 0, asOf: 1000 });
    await insertRisk(db, { level: "HALT", reasonCode: 1, asOf: 3000, txHash: H(9) });
    await insertRisk(db, { level: "CAUTION", reasonCode: 2, asOf: 2000 });
    const latest = await latestRisk(db);
    expect(latest?.level).toBe("HALT");
    expect(latest?.reasonCode).toBe(1);
    expect(latest?.txHash).toBe(H(9));
  });
});

describe("leaderboard", () => {
  beforeEach(async () => {
    await newAgent({ id: "a-mom", template: "momentum" });
    await newAgent({ id: "a-brk", template: "breakout" });
    await newAgent({ id: "a-live", template: "momentum", mode: "live" });
    await upsertUser(db, { address: ADDR(50), displayName: "Human" });
    await upsertStats(db, [
      stats({ entityId: "a-mom", realizedPnlUsd: 5, template: "momentum", mode: "paper" }),
      stats({ entityId: "a-brk", realizedPnlUsd: -2, template: "breakout", mode: "paper" }),
      stats({ entityId: "a-live", realizedPnlUsd: 3, template: "momentum", mode: "live" }),
      stats({ entityId: ADDR(50), kind: "human", name: "Human", template: null, realizedPnlUsd: 4, mode: "live" }),
    ]);
  });

  test("sorted by realized PnL descending, with the default filter returning agents and humans", async () => {
    const rows = await leaderboard(db);
    expect(rows.map((r) => r.entityId)).toEqual(["a-mom", ADDR(50), "a-live", "a-brk"]);
    expect(rows[0]?.forkCount).toBe(0);
  });

  test("kind, template, mode and limit filters", async () => {
    expect((await leaderboard(db, { kind: "agent" })).map((r) => r.entityId)).toEqual(["a-mom", "a-live", "a-brk"]);
    expect((await leaderboard(db, { kind: "human" })).map((r) => r.entityId)).toEqual([ADDR(50)]);
    expect((await leaderboard(db, { kind: "all", limit: 2 })).map((r) => r.entityId)).toEqual(["a-mom", ADDR(50)]);
    expect((await leaderboard(db, { template: "momentum" })).map((r) => r.entityId)).toEqual(["a-mom", "a-live"]);
    expect((await leaderboard(db, { mode: "live" })).map((r) => r.entityId)).toEqual([ADDR(50), "a-live"]);
    expect((await leaderboard(db, { kind: "agent", template: "breakout", mode: "paper" })).map((r) => r.entityId)).toEqual([
      "a-brk",
    ]);
  });

  test("fork counts are computed from the forks table", async () => {
    await newAgent({ id: "a-fork", owner: OTHER, template: "momentum" });
    await insertFork(db, {
      agentId: "a-mom",
      buyer: OTHER,
      priceUsd: 2,
      txHash: H(11),
      configHash: H(1),
      newAgentId: "a-fork",
    });
    expect(await countForks(db, "a-mom")).toBe(1);
    const mom = (await leaderboard(db)).find((r) => r.entityId === "a-mom");
    expect(mom?.forkCount).toBe(1);
  });

  test("verified and selfFunded are mapped", async () => {
    await upsertStats(db, [
      stats({ entityId: "a-mom", realizedPnlUsd: 5, verified: { reportTx: H(12), asOf: 999 }, selfFunded: true }),
    ]);
    const mom = (await leaderboard(db)).find((r) => r.entityId === "a-mom");
    expect(mom?.verified).toEqual({ reportTx: H(12), asOf: 999 });
    expect(mom?.selfFunded).toBe(true);
    expect((await leaderboard(db)).find((r) => r.entityId === "a-brk")?.verified).toBeNull();
  });
});

describe("forks, guardrails, telegram", () => {
  test("insertFork is idempotent on txHash and records the buyer", async () => {
    await newAgent({ id: "src" });
    const first = await insertFork(db, {
      agentId: "src",
      buyer: OTHER,
      priceUsd: 1,
      txHash: H(20),
      configHash: H(1),
      createdAt: 500,
    });
    expect(first?.buyer).toBe(OTHER);
    expect(
      await insertFork(db, { agentId: "src", buyer: OTHER, priceUsd: 1, txHash: H(20), configHash: H(1) }),
    ).toBeNull();
    expect(await countForks(db, "src")).toBe(1);
    expect((await getUser(db, OTHER))?.address).toBe(OTHER);
  });

  test("guardrail blocks are stored newest first", async () => {
    await newAgent({ id: "agent-1" });
    await insertEpisode(db, episode("agent-1", 1000, "ep-block"));
    await insertGuardrailBlock(db, { agentId: "agent-1", episodeId: "ep-block", reasons: ["cap"], ts: 1000 });
    await insertGuardrailBlock(db, { agentId: "agent-1", reasons: ["loss"], ts: 2000 });
    const blocks = await listGuardrailBlocks(db, "agent-1");
    expect(blocks.map((b) => b.reasons)).toEqual([["loss"], ["cap"]]);
  });

  test("subscriptions can be added, updated, listed and removed", async () => {
    await newAgent({ id: "agent-1" });
    await subscribeTelegram(db, { chatId: "-100123", agentId: "agent-1", level: "digest" });
    await subscribeTelegram(db, { chatId: "-100123", agentId: "agent-1", level: "alerts" });
    expect(await listTelegramSubscribers(db, "agent-1")).toEqual(["-100123"]);
    expect(await listTelegramSubscribers(db, "agent-1", "digest")).toEqual([]);
    expect(await listTelegramSubscriptions(db, "-100123")).toEqual([{ agentId: "agent-1", level: "alerts" }]);
    expect(await unsubscribeTelegram(db, "-100123", "agent-1")).toBe(true);
    expect(await unsubscribeTelegram(db, "-100123", "agent-1")).toBe(false);
  });
});

describe("demo seed", () => {
  test("seeding twice adds nothing new", async () => {
    const first = await seedDemo(db);
    const second = await seedDemo(db);
    expect(first.agents).toBe(8);
    expect(first.humans).toBe(4);
    expect(second.leaderboardTop).toEqual(first.leaderboardTop);

    const agentRows = await rawRows<{ n: number }>(sql`select count(*)::int as n from agents`);
    expect(agentRows[0]?.n).toBe(8);
    const episodeRows = await rawRows<{ n: number }>(sql`select count(*)::int as n from episodes`);
    expect(episodeRows[0]?.n).toBe(6);

    const templates = new Set((await leaderboard(db, { kind: "agent", limit: 500 })).map((r) => r.template));
    expect(templates).toEqual(new Set(["momentum", "mean_reversion", "breakout", "smart_dca", "social_sentiment"]));
    expect((await getAgent(db, "demo-agent-momentum-fork"))?.forkedFrom).toBe("demo-agent-momentum");
    expect((await leaderboard(db, { kind: "agent" })).every((r) => r.name.startsWith("[demo]"))).toBe(true);
  });
});
