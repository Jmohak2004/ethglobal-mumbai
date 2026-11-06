import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertInference, insertPaperLedger, type Db } from "@arena/db";
import type { ZeroGAccount } from "@arena/zerog";
import { createBudgetSource } from "./budget.ts";
import { fixedClock, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

/** 0.4 0G billed today: with a 1 0G seed, the balance is 0.6 and the runway 1.5 days (low). */
async function billToday(db: Db, agentId: string): Promise<void> {
  await insertInference(
    db,
    { requestId: "req-budget-1", model: "glm-test", provider: null, billing: "0.4", teeVerified: null, latencyMs: 0, payer: "platform" },
    { agentId, purpose: "decision", ts: NOW },
  );
}

describe("createBudgetSource: paper agents", () => {
  test("simulated top-ups add to the estimated balance and lift the tier", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    await billToday(db, agent.id);
    const budget = createBudgetSource({ db, clock: fixedClock(), seedCredit0G: 1, isPaper: () => true });

    const before = await budget.forAgent(agent);
    expect(before.balance).toBeCloseTo(0.6);
    expect(before.tier).toBe("low");
    expect(before.source).toBe("estimate");

    await insertPaperLedger(db, { agentId: agent.id, kind: "topup", amountUsd: 0.9, amount0g: 5, note: "paper top-up", ts: NOW });
    const after = await budget.forAgent(agent);
    expect(after.balance).toBeCloseTo(5.6);
    expect(after.tier).toBe("healthy");
  });

  test("paper agents never read the platform account balance", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    const account = { getBalance: async () => ({ totalBalance: "100" }) } as unknown as Pick<ZeroGAccount, "getBalance">;
    const budget = createBudgetSource({ db, clock: fixedClock(), seedCredit0G: 1, account, isPaper: () => true });
    expect((await budget.forAgent(agent)).balance).toBe(1);
  });

  test("live agents keep the account balance and ignore paper top-ups", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await insertPaperLedger(db, { agentId: agent.id, kind: "topup", amountUsd: 1, amount0g: 6, note: "paper top-up", ts: NOW });
    const account = { getBalance: async () => ({ totalBalance: "100" }) } as unknown as Pick<ZeroGAccount, "getBalance">;
    const withAccount = createBudgetSource({ db, clock: fixedClock(), seedCredit0G: 1, account, isPaper: () => false });
    expect(await withAccount.forAgent(agent)).toMatchObject({ balance: 100, source: "account" });

    const estimate = createBudgetSource({ db, clock: fixedClock(), seedCredit0G: 1, isPaper: () => false });
    expect((await estimate.forAgent(agent)).balance).toBe(1);
  });
});
