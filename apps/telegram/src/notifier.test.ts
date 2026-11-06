import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDb,
  createTopup,
  insertAttestation,
  insertEpisode,
  insertFills,
  insertGuardrailBlock,
  insertRisk,
  subscribeTelegram,
  upsertOrder,
  upsertStats,
  type Db,
} from "@arena/db";
import type { BudgetTier, Episode } from "@arena/shared";
import { RiskReason } from "@arena/shared";
import { createNotifier, type Notifier } from "./notifier.ts";
import { createStateStore, type StateStore } from "./state.ts";
import { DAY, HOUR, LINKS, OWNER, T0, forbiddenHits, hash, seedDb } from "./test-fixtures.ts";

const OTHER_WALLET = `0x${"c".repeat(40)}`;
const OWNER_CHAT = "111";
const PUBLIC_CHAT = "333";
const STRANGER_CHAT = "222";

interface Sent {
  chat: string;
  html: string;
}

function episode(id: string, agentId: string, ts: number, budgetTier: BudgetTier, withForecast = false): Episode {
  return {
    id,
    agentId,
    ts,
    riskLevel: "NORMAL",
    budgetTier,
    market: [],
    decision: withForecast
      ? {
          forecast: { asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 0.8, confidence: 0.64 },
          proposal: { action: "hold", rationale: "internal reasoning" },
        }
      : null,
    inference: null,
    verdict: { kind: "noop", reasons: ["hold"] },
    flashOrderIds: [],
    zgStorageRoot: null,
    error: null,
  };
}

let db: Db;
let state: StateStore;
let sent: Sent[];
let clock: { t: number };
let notifier: Notifier;

beforeEach(async () => {
  db = await seedDb();
  state = createStateStore(null);
  sent = [];
  clock = { t: T0 };
  notifier = createNotifier({
    db,
    state,
    links: LINKS,
    send: (chat, html) => sent.push({ chat, html }),
    now: () => clock.t,
    log: () => undefined,
  });
});

afterEach(async () => {
  await closeDb(db);
});

const toChat = (chat: string) => sent.filter((s) => s.chat === chat);

describe("notifier: owner alerts", () => {
  test("first tick only baselines cursors, so history is not replayed", async () => {
    state.state.links[OWNER_CHAT] = OWNER;
    await upsertOrder(db, {
      id: "flash-old",
      agentId: "agent-mom",
      funderAddress: OWNER,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
      status: "filled",
      raw: {},
      createdAt: T0 - HOUR,
      updatedAt: T0 - HOUR,
    });
    await notifier.tick();
    expect(sent).toHaveLength(0);
    expect(state.state.cursors?.orders).toBe(T0);
  });

  test("routes new owner events in full, and never sends another agent's events to a stranger", async () => {
    state.state.links[OWNER_CHAT] = OWNER;
    await notifier.tick();

    // Budget tier: a previous episode before the cursor is "healthy", the new one is "low".
    await insertEpisode(db, episode("ep-prev", "agent-mom", T0 - HOUR, "healthy"));

    clock.t = T0 + 10_000;
    await upsertOrder(db, {
      id: "flash-1",
      agentId: "agent-mom",
      funderAddress: OWNER,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
      status: "filled",
      raw: {},
      createdAt: T0 + 1000,
      updatedAt: T0 + 1000,
    });
    await insertFills(db, [
      {
        id: "fill-1",
        orderId: "flash-1",
        price: 3148.5,
        qty: 0.00025,
        notionalUsd: 0.79,
        feeUsd: 0,
        integratorFeeUsd: 0,
        txId: hash(7),
        ts: T0 + 2000,
      },
    ]);
    await insertGuardrailBlock(db, { agentId: "agent-mom", reasons: ["daily loss limit reached"], ts: T0 + 3000 });
    await insertEpisode(db, episode("ep-new", "agent-mom", T0 + 4000, "low"));
    await createTopup(db, {
      agentId: "agent-mom",
      usdcAmount: 1.5,
      baseTx: hash(11),
      zgTransferTx: hash(12),
      depositTx: null,
      firstPaidRequestId: null,
      ts: T0 + 5000,
    });
    await insertAttestation(db, { kind: "perf", txHash: hash(9), payload: { agents: ["agent-mom"] }, asOf: T0 + 6000 });

    // Another agent's order, owned by someone else. Must not reach the owner chat or the stranger.
    await upsertOrder(db, {
      id: "flash-other",
      agentId: "agent-brk",
      funderAddress: OTHER_WALLET,
      side: "sell",
      asset: "cbBTC",
      orderType: "market",
      notionalUsd: 2,
      status: "filled",
      raw: {},
      createdAt: T0 + 7000,
      updatedAt: T0 + 7000,
    });

    await notifier.tick();

    const owner = toChat(OWNER_CHAT).map((s) => s.html);
    expect(owner).toHaveLength(6);
    expect(owner[0]).toContain("Order placed");
    expect(owner[1]).toContain("Filled");
    expect(owner[1]).toContain(`${LINKS.basescanUrl}/tx/${hash(7)}`);
    expect(owner[2]).toContain("Blocked by guardrails");
    expect(owner[2]).toContain("daily loss limit reached");
    expect(owner[3]).toContain("healthy → low");
    expect(owner[4]).toContain("Top-up");
    expect(owner[5]).toContain("New CRE attestation");
    expect(toChat(STRANGER_CHAT)).toHaveLength(0);
    expect(sent.some((s) => s.html.includes("Breakout"))).toBe(false);
  });

  test("a second tick sends nothing new", async () => {
    state.state.links[OWNER_CHAT] = OWNER;
    await notifier.tick();
    clock.t = T0 + 10_000;
    await insertGuardrailBlock(db, { agentId: "agent-mom", reasons: ["cap"], ts: T0 + 3000 });
    await notifier.tick();
    const count = sent.length;
    expect(count).toBe(1);
    clock.t = T0 + 20_000;
    await notifier.tick();
    expect(sent).toHaveLength(count);
  });
});

describe("notifier: public followers", () => {
  test("risk-level changes are broadcast to public followers and owner chats", async () => {
    state.state.links[OWNER_CHAT] = OWNER;
    await subscribeTelegram(db, { chatId: PUBLIC_CHAT, agentId: "agent-brk", level: "public" });
    await notifier.tick();
    expect(sent).toHaveLength(0);

    clock.t = T0 + 10_000;
    await insertRisk(db, {
      id: "risk-halt",
      level: "HALT",
      reasonCode: RiskReason.PriceDrop,
      asOf: T0 + 9000,
      txHash: null,
    });
    await notifier.tick();

    expect(toChat(PUBLIC_CHAT)).toHaveLength(1);
    expect(toChat(OWNER_CHAT)).toHaveLength(1);
    expect(toChat(PUBLIC_CHAT)[0]!.html).toContain("NORMAL → 🔴 HALT");
    expect(forbiddenHits(toChat(PUBLIC_CHAT)[0]!.html)).toEqual([]);
  });

  test("public followers never get owner alerts", async () => {
    await subscribeTelegram(db, { chatId: PUBLIC_CHAT, agentId: "agent-mom", level: "public" });
    await notifier.tick();
    clock.t = T0 + 10_000;
    await upsertOrder(db, {
      id: "flash-x",
      agentId: "agent-mom",
      funderAddress: OWNER,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.5,
      status: "filled",
      raw: {},
      createdAt: T0 + 1000,
      updatedAt: T0 + 1000,
    });
    await notifier.tick();
    expect(toChat(PUBLIC_CHAT)).toHaveLength(0);
  });

  test("one digest per follow per UTC day, with a rank delta and delayed market view, stats only", async () => {
    await subscribeTelegram(db, { chatId: PUBLIC_CHAT, agentId: "agent-brk", level: "public" });
    await insertEpisode(db, episode("ep-old-view", "agent-brk", T0 - 2 * HOUR, "healthy", true));
    await notifier.tick();
    expect(state.state.lastDigestDay).toBe("2026-11-06");

    // Breakout overtakes Momentum, so its rank moves from #2 to #1.
    await upsertStats(db, [
      {
        entityId: "agent-brk",
        kind: "agent",
        name: "[demo] Breakout Charlie",
        template: "breakout",
        mode: "paper",
        realizedPnlUsd: 20,
        realizedPnlPct: 12,
        volumeUsd: 1,
        trades: 1,
        winRateBps: 5000,
        maxDrawdownBps: 0,
        forecastHitRateBps: 5000,
        daysActive: 1,
        verified: null,
        selfFunded: false,
      },
    ]);

    clock.t = T0 + DAY;
    await notifier.tick();

    const digests = toChat(PUBLIC_CHAT).filter((s) => s.html.includes("Daily digest"));
    expect(digests).toHaveLength(1);
    const text = digests[0]!.html;
    expect(text).toContain("Breakout Charlie");
    expect(text).toContain("Rank #1 (▲1)");
    expect(text).toContain("Market view</b> (delayed 1h): WETH ↑ up over 60m");
    expect(text).not.toContain("internal reasoning");
    expect(forbiddenHits(text)).toEqual([]);

    // Same day: no second digest.
    clock.t = T0 + DAY + HOUR;
    await notifier.tick();
    expect(toChat(PUBLIC_CHAT).filter((s) => s.html.includes("Daily digest"))).toHaveLength(1);
    expect(toChat(OWNER_CHAT)).toHaveLength(0);
  });
});
