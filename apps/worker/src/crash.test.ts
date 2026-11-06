import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertFills, upsertOrder, type Db } from "@arena/db";
import { createOrderControl, type FlashClient, type MessageSigner } from "@arena/flash";
import type { Agent } from "@arena/shared";
import { createCrashGuard, runHaltActions, cancelPendingEntries, formatPrice, HALT_REASON } from "./crash.ts";
import { loadAgentState } from "./execution.ts";
import {
  fakeMarket,
  fakeOrderControl,
  fakeRisk,
  FakeExecutor,
  deps,
  memoryDb,
  NOW,
  seedAgent,
} from "./test-fixtures.ts";

const ENTRY_ID = "0b1e6c2a-1f3d-4c5b-8a9e-7d6c5b4a3f21";
const STOP_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

/** A filled live buy with a recorded stop, so the HALT path has a position to protect. */
async function openLivePosition(db: Db, agent: Agent, id: string, stopLossPrice: number) {
  await upsertOrder(db, {
    id,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: "buy",
    asset: "WETH",
    orderType: "limit",
    notionalUsd: 0.8,
    status: "ORDER_STATUS_FILLED",
    raw: { attachedBracket: { stopLossPrice } },
    createdAt: T0,
    updatedAt: T0,
  });
  await insertFills(db, [
    { id: `${id}:fill`, orderId: id, price: 2000, qty: 0.0004, notionalUsd: 0.8, feeUsd: 0, integratorFeeUsd: 0, txId: "0xaa", ts: T0 },
  ]);
}

type FlashCall = { op: "cancel" | "patch"; orderId: string; body: Record<string, unknown> };

/** Flash REST stand-in: GET /orders/{id} returns the stored trigger, and cancel and PATCH are recorded. No network. */
function fakeFlash(orders: Record<string, { trigger: { triggerType: "lower" | "upper"; crossPrice: string } }>) {
  const calls: FlashCall[] = [];
  const client = {
    async getOrder(orderId: string) {
      const order = orders[orderId];
      if (!order) throw new Error(`unknown order ${orderId}`);
      return { order: { id: orderId, status: "ORDER_STATUS_FILLED", ...order }, fills: [] };
    },
    async cancelOrder(orderId: string, body: Record<string, unknown>) {
      calls.push({ op: "cancel", orderId, body });
      return { ok: true };
    },
    async patchOrder(orderId: string, body: Record<string, unknown>) {
      calls.push({ op: "patch", orderId, body });
      return { ok: true };
    },
  };
  return { client: client as unknown as FlashClient, calls };
}

/** EIP-191 stand-in: a fixed 65-byte signature, and a record of every message it was asked to sign. */
function fakeMessageSigner(address: `0x${string}`) {
  const signature = `0x${"ab".repeat(65)}` as const;
  const signed: string[] = [];
  const signer: MessageSigner = {
    address,
    async signMessage(message: string) {
      signed.push(message);
      return signature;
    },
  };
  return { signer, signed, signature };
}

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const T0 = NOW - 60 * 60_000;

/** A filled paper buy of 0.0004 WETH at 2000 (about $0.80, inside the $1 trade cap) with a 1900 stop. */
async function openPosition(db: Db, agent: Agent, stopLossPrice = 1900, id = "buy-filled") {
  await upsertOrder(db, {
    id,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: "buy",
    asset: "WETH",
    orderType: "limit",
    notionalUsd: 0.8,
    status: "simulated_fill",
    raw: { paper: true, attachedBracket: { takeProfitPrice: 2100, stopLossPrice } },
    createdAt: T0,
    updatedAt: T0,
  });
  await insertFills(db, [
    { id: `${id}:fill`, orderId: id, price: 2000, qty: 0.0004, notionalUsd: 0.8, feeUsd: 0, integratorFeeUsd: 0, txId: null, ts: T0 },
  ]);
}

/** An entry that has not filled yet. */
async function pendingEntry(db: Db, agent: Agent, id = "buy-pending", raw: Record<string, unknown> = { paper: true }) {
  await upsertOrder(db, {
    id,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: "buy",
    asset: "WETH",
    orderType: "limit",
    notionalUsd: 0.8,
    status: "ORDER_STATUS_PENDING",
    raw,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
  });
}

async function orderStatus(db: Db, id: string) {
  return (await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.status;
}

async function episodesFor(db: Db, agentId: string) {
  return db.query.episodes.findMany({ where: (e, { eq }) => eq(e.agentId, agentId) });
}

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

describe("HALT transition (paper)", () => {
  test("cancels pending entries, tightens the stop once, and does nothing again for the same report", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    await openPosition(db, agent);
    await pendingEntry(db, agent);
    const risk = fakeRisk("HALT", 5000);
    const d = deps({ db, risk, market: fakeMarket({ WETH: 2000 }) });
    const guard = createCrashGuard({ deps: d, loadAgents: async () => [agent] });

    const summary = await guard.check();
    expect(summary).not.toBeNull();
    expect(summary?.cancelled).toBe(1);
    expect(summary?.stopsTightened).toBe(1);
    expect(summary?.failures).toBe(0);

    expect(await orderStatus(db, "buy-pending")).toBe("ORDER_STATUS_CANCELLED");
    const stopped = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "buy-filled") });
    expect((stopped?.raw as { attachedBracket: { stopLossPrice: number } }).attachedBracket.stopLossPrice).toBeCloseTo(1980, 6);

    const episodes = await episodesFor(db, agent.id);
    expect(episodes).toHaveLength(2);
    for (const e of episodes) {
      expect(e.riskLevel).toBe("HALT");
      expect(e.verdict.kind).toBe("noop");
      expect((e.verdict as { reasons: string[] }).reasons[0]).toContain(HALT_REASON);
    }

    // The same report read again does nothing.
    expect(await guard.check()).toBeNull();
    expect(await episodesFor(db, agent.id)).toHaveLength(2);

    // A reset, then a new report while still in HALT: the actions run again, but nothing is left to change.
    risk.level = "NORMAL";
    expect(await guard.check()).toBeNull();
    risk.level = "HALT";
    risk.asOf = 6000;
    const again = await guard.check();
    expect(again).not.toBeNull();
    expect(again?.cancelled).toBe(0);
    expect(again?.stopsTightened).toBe(0);
    expect(await episodesFor(db, agent.id)).toHaveLength(2);
  });

  test("a CAUTION reading changes nothing beyond the policy engine", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    await openPosition(db, agent);
    await pendingEntry(db, agent);
    const guard = createCrashGuard({
      deps: deps({ db, risk: fakeRisk("CAUTION", 5000), market: fakeMarket({ WETH: 2000 }) }),
      loadAgents: async () => [agent],
    });
    expect(await guard.check()).toBeNull();
    expect(await orderStatus(db, "buy-pending")).toBe("ORDER_STATUS_PENDING");
    expect(await episodesFor(db, agent.id)).toHaveLength(0);
  });

  test("a stop that is already tighter than mark x 0.99 is left alone", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    await openPosition(db, agent, 1990);
    const summary = await runHaltActions(deps({ db, market: fakeMarket({ WETH: 2000 }) }), [agent], { level: "HALT", asOf: 1 });
    expect(summary.stopsTightened).toBe(0);
    const row = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "buy-filled") });
    expect((row?.raw as { attachedBracket: { stopLossPrice: number } }).attachedBracket.stopLossPrice).toBe(1990);
  });

  test("only active agents are acted on", async () => {
    const db = await freshDb();
    const paused = await seedAgent(db, { mode: "paper", status: "paused" });
    await pendingEntry(db, paused);
    const guard = createCrashGuard({
      deps: deps({ db, risk: fakeRisk("HALT", 5000), market: fakeMarket({ WETH: 2000 }) }),
      loadAgents: async () => [paused],
    });
    const summary = await guard.check();
    expect(summary?.agents).toBe(0);
    expect(await orderStatus(db, "buy-pending")).toBe("ORDER_STATUS_PENDING");
  });
});

describe("HALT with crashMode flatten", () => {
  test("sells the position to USDC through the policy engine and the executor", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper", config: { crashMode: "flatten" } });
    await openPosition(db, agent);
    const executor = new FakeExecutor();
    const summary = await runHaltActions(deps({ db, executor, market: fakeMarket({ WETH: 2000 }) }), [agent], {
      level: "HALT",
      asOf: 5000,
    });

    expect(summary.flattened).toBe(1);
    expect(summary.failures).toBe(0);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.intent.side).toBe("sell");
    expect(executor.calls[0]?.intent.asset).toBe("WETH");

    const orders = await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, agent.id) });
    expect(orders.some((o) => o.side === "sell")).toBe(true);

    const state = await loadAgentState(db, agent, NOW);
    expect(state.fifo.openPositions.filter((p) => p.qty > 1e-9)).toEqual([]);

    const flatten = (await episodesFor(db, agent.id)).find((e) => e.decision?.proposal.action === "sell");
    expect(flatten?.decision?.proposal.rationale).toContain(HALT_REASON);
    expect(["approve", "clamp"]).toContain(flatten?.verdict.kind ?? "");
    expect(flatten?.flashOrderIds).toHaveLength(1);
  });

  test("a policy rejection of the exit is recorded as the verdict and nothing is sent", async () => {
    const db = await freshDb();
    // The agent no longer trades WETH, so the policy engine rejects the exit. The rejection is recorded.
    const agent = await seedAgent(db, { mode: "paper", config: { crashMode: "flatten", assets: ["cbBTC"] } });
    await openPosition(db, agent);
    const executor = new FakeExecutor();
    const summary = await runHaltActions(deps({ db, executor, market: fakeMarket({ WETH: 2000 }) }), [agent], {
      level: "HALT",
      asOf: 5000,
    });
    expect(summary.flattened).toBe(0);
    expect(executor.calls).toHaveLength(0);
    const flatten = (await episodesFor(db, agent.id)).find((e) => e.decision?.proposal.action === "sell");
    expect(flatten?.verdict.kind).toBe("reject");
  });
});

describe("live orders", () => {
  test("without Flash order control, a live cancel is recorded as an error and the order is left as it was", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await pendingEntry(db, agent, "buy-live", { quoteId: "q-1" });
    const summary = await runHaltActions(deps({ db, market: fakeMarket({ WETH: 2000 }) }), [agent], { level: "HALT", asOf: 1 });
    expect(summary.cancelled).toBe(0);
    expect(summary.failures).toBe(1);
    expect(await orderStatus(db, "buy-live")).toBe("ORDER_STATUS_PENDING");
    const [episode] = await episodesFor(db, agent.id);
    expect(episode?.error).toContain("not configured");
  });

  test("with order control, a live HALT cancels the pending entry and tightens the stop", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await pendingEntry(db, agent, "buy-live", { quoteId: "q-1" });
    await openLivePosition(db, agent, "buy-live-filled", 1900);
    const control = fakeOrderControl();
    const summary = await runHaltActions(
      deps({ db, market: fakeMarket({ WETH: 2000 }), orderControlFor: async () => control }),
      [agent],
      { level: "HALT", asOf: 1 },
    );
    expect(summary.cancelled).toBe(1);
    expect(summary.stopsTightened).toBe(1);
    expect(control.cancels).toEqual(["buy-live"]);
    expect(control.stops).toEqual([{ orderId: "buy-live-filled", stopLossPrice: "1980" }]);
    expect(await orderStatus(db, "buy-live")).toBe("ORDER_STATUS_CANCELLED");
  });

  test("a rejected live cancel is recorded as an error and the order stays pending", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await pendingEntry(db, agent, "buy-live", { quoteId: "q-1" });
    const control = fakeOrderControl();
    control.failOn.add("buy-live");
    const summary = await runHaltActions(
      deps({ db, market: fakeMarket({ WETH: 2000 }), orderControlFor: async () => control }),
      [agent],
      { level: "HALT", asOf: 1 },
    );
    expect(summary.cancelled).toBe(0);
    expect(summary.failures).toBe(1);
    expect(await orderStatus(db, "buy-live")).toBe("ORDER_STATUS_PENDING");
  });

  test("a rejected live stop change is recorded as an error and the stored stop does not move", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await openLivePosition(db, agent, "buy-live-filled", 1900);
    const control = fakeOrderControl();
    control.failOn.add("buy-live-filled");
    const summary = await runHaltActions(
      deps({ db, market: fakeMarket({ WETH: 2000 }), orderControlFor: async () => control }),
      [agent],
      { level: "HALT", asOf: 1 },
    );
    expect(summary.stopsTightened).toBe(0);
    expect(summary.failures).toBe(1);
    const row = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "buy-live-filled") });
    expect((row?.raw as { attachedBracket: { stopLossPrice: number } }).attachedBracket.stopLossPrice).toBe(1900);
  });

  test("a successful live stop change is sent with the raised level as a plain decimal", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await openLivePosition(db, agent, "buy-live-filled", 1900);
    const control = fakeOrderControl();
    const summary = await runHaltActions(
      deps({ db, market: fakeMarket({ WETH: 2000 }), orderControlFor: async () => control }),
      [agent],
      { level: "HALT", asOf: 1 },
    );
    expect(summary.stopsTightened).toBe(1);
    expect(control.stops).toHaveLength(1);
    expect(control.stops[0]?.orderId).toBe("buy-live-filled");
    expect(control.stops[0]?.stopLossPrice).toBe("1980");
  });

  test("the HALT live path signs every Flash message with the agent's message signer", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await pendingEntry(db, agent, ENTRY_ID, { quoteId: "q-1" });
    await openLivePosition(db, agent, STOP_ID, 1900);
    const flash = fakeFlash({ [STOP_ID]: { trigger: { triggerType: "lower", crossPrice: "1900" } } });
    const signer = fakeMessageSigner(agent.tradingWallet);
    const summary = await runHaltActions(
      deps({ db, market: fakeMarket({ WETH: 2000 }), orderControlFor: async () => createOrderControl(flash.client, signer.signer) }),
      [agent],
      { level: "HALT", asOf: 1 },
    );
    expect(summary.failures).toBe(0);
    expect(summary.cancelled).toBe(1);
    expect(summary.stopsTightened).toBe(1);

    const [cancel, patch] = flash.calls;
    expect(flash.calls.map((c) => c.op)).toEqual(["cancel", "patch"]);
    expect(cancel?.orderId).toBe(ENTRY_ID);
    expect(cancel?.body).toEqual({ cancelMessage: `Definitive Flash v1 — Cancel Order\nOrder: ${ENTRY_ID}`, userSignature: signer.signature });
    expect(patch?.orderId).toBe(STOP_ID);
    expect(patch?.body.updateMessage).toContain("Trigger Lower Cross Price: 1980");
    expect(patch?.body.trigger).toEqual({ triggerType: "lower", crossPrice: "1980" });
    expect(patch?.body.userSignature).toBe(signer.signature);
    // The signer saw exactly the two messages Flash received, in order, and nothing else.
    expect(signer.signed).toEqual([String(cancel?.body.cancelMessage), String(patch?.body.updateMessage)]);
  });
});

describe("formatPrice", () => {
  test("writes plain decimals with no exponent and no trailing zeros", () => {
    expect(formatPrice(1980)).toBe("1980");
    expect(formatPrice(1980.5)).toBe("1980.5");
    expect(formatPrice(0.00001234)).toBe("0.00001234");
  });
});

describe("cancelPendingEntries", () => {
  test("cancels only buys that are still pending for this agent", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    const other = await seedAgent(db, { mode: "paper" });
    await pendingEntry(db, agent, "mine");
    await pendingEntry(db, other, "theirs");
    await openPosition(db, agent);
    const result = await cancelPendingEntries(deps({ db }), agent, NOW);
    expect(result.cancelled.map((c) => c.orderId)).toEqual(["mine"]);
    expect(result.failed).toEqual([]);
    expect(await orderStatus(db, "theirs")).toBe("ORDER_STATUS_PENDING");
    expect(await orderStatus(db, "buy-filled")).toBe("simulated_fill");
  });
});
