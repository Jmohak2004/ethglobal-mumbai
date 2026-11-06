import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StrategyConfig } from "@arena/shared";
import {
  claimTickRequests,
  closeDb,
  createAgent,
  createDb,
  getAgentRuntime,
  hasPendingTickRequest,
  insertPaperLedger,
  listPaperLedger,
  migrate,
  paperLedgerTotals,
  requestTick,
  updateAgentRuntime,
  type Db,
} from "./index.ts";

let db: Db;
const OWNER = "0x00000000000000000000000000000000000000aa";

const config = {
  template: "momentum",
  assets: ["WETH"],
  sliders: {},
  limits: { maxTradeUsd: 1, maxOpenPositions: 1, maxAllocationUsd: 5, maxDailyLossUsd: 1, maxDrawdownPct: 20, cooldownSec: 60 },
  tickIntervalSec: 300,
  modelTier: "balanced",
  crashMode: "tighten_stops",
  commissionBps: 1000,
  autoTune: { enabled: false, maxDeltaPct: 0 },
  publicCommentary: "off",
  insightSources: [],
  fork: { forkable: false, priceUsd: 0 },
} as StrategyConfig;

beforeAll(async () => {
  db = createDb({ memory: true });
  await migrate(db);
  await migrate(db);
  await createAgent(db, {
    id: "a1",
    name: "a1",
    ownerAddress: OWNER,
    tradingWallet: "0x0000000000000000000000000000000000000001",
    config,
    configHash: `0x${"11".repeat(32)}`,
  });
});
afterAll(async () => closeDb(db));

describe("demo repos", () => {
  test("runtime merges patches", async () => {
    expect(await getAgentRuntime(db, "a1")).toEqual({});
    await updateAgentRuntime(db, "a1", { lastTickAt: 1, lastOutcome: "hold" });
    await updateAgentRuntime(db, "a1", { nextTickAt: 2, updatedAt: 3 });
    expect(await getAgentRuntime(db, "a1")).toEqual({ lastTickAt: 1, lastOutcome: "hold", nextTickAt: 2, updatedAt: 3 });
  });

  test("tick requests are claimed once and deduplicated", async () => {
    await requestTick(db, "a1", OWNER, 10);
    await requestTick(db, "a1", OWNER, 11);
    expect(await hasPendingTickRequest(db, "a1")).toBe(true);
    expect(await claimTickRequests(db, 20)).toEqual(["a1"]);
    expect(await claimTickRequests(db, 21)).toEqual([]);
    expect(await hasPendingTickRequest(db, "a1")).toBe(false);
  });

  test("paper ledger totals", async () => {
    await insertPaperLedger(db, { agentId: "a1", kind: "commission", amountUsd: 0.5, amount0g: null, note: null, ts: 1 });
    await insertPaperLedger(db, { agentId: "a1", kind: "topup", amountUsd: 0.2, amount0g: 1.5, note: null, ts: 2 });
    expect(await paperLedgerTotals(db, "a1")).toEqual({ commissionUsd: 0.5, topupUsd: 0.2, topup0g: 1.5, balanceUsd: 0.3 });
    expect((await listPaperLedger(db, "a1")).map((e) => e.kind)).toEqual(["topup", "commission"]);
  });
});
