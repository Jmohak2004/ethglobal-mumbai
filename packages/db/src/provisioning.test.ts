import { afterAll, describe, expect, test } from "bun:test";
import type { StrategyConfig } from "@arena/shared";
import {
  closeDb,
  createAgent,
  createDb,
  getAgent,
  getProvisioning,
  getZgKeySecret,
  insertZgKey,
  isPlaceholderWallet,
  listAgentsNeedingProvisioning,
  migrate,
  PLACEHOLDER_WALLET,
  provisioningGaps,
  setAgentWallets,
  setAgentStatus,
  updateProvisioning,
  type Db,
} from "./index.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const ZG = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}` as const;

function config(maxAllocationUsd = 5): StrategyConfig {
  return {
    template: "momentum",
    assets: ["WETH"],
    sliders: { sizePct: 0.2 },
    limits: {
      maxTradeUsd: 1,
      maxOpenPositions: 2,
      maxAllocationUsd,
      maxDailyLossUsd: 1,
      maxDrawdownPct: 15,
      cooldownSec: 900,
    },
    tickIntervalSec: 300,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: 1000,
    autoTune: { enabled: false, maxDeltaPct: 0 },
    publicCommentary: "off",
    insightSources: [],
    fork: { forkable: false, priceUsd: 0 },
  };
}

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = createDb({ memory: true });
  dbs.push(db);
  await migrate(db);
  return db;
}

async function newAgent(db: Db, id: string, opts: { tradingWallet?: string; status?: "active" | "paused" | "stopped"; maxAllocationUsd?: number } = {}) {
  const cfg = config(opts.maxAllocationUsd);
  return createAgent(db, {
    id,
    name: `agent ${id}`,
    ownerAddress: OWNER,
    tradingWallet: opts.tradingWallet ?? PLACEHOLDER_WALLET,
    config: cfg,
    configHash: HASH,
    status: opts.status ?? "active",
    createdAt: 1,
  });
}

describe("placeholder wallets", () => {
  test("the zero address, in any case or padding, counts as no wallet", () => {
    expect(isPlaceholderWallet(PLACEHOLDER_WALLET)).toBe(true);
    expect(isPlaceholderWallet(`0X${"0".repeat(40)}`)).toBe(true);
    expect(isPlaceholderWallet("")).toBe(true);
    expect(isPlaceholderWallet(null)).toBe(true);
    expect(isPlaceholderWallet(WALLET)).toBe(false);
  });
});

describe("provisioningGaps", () => {
  const agent = { tradingWallet: WALLET as `0x${string}`, zgWallet: ZG as `0x${string}`, configHash: HASH, config: config(5) };
  const complete = {
    zgKeyId: "k1",
    registeredAt: 1,
    syncedConfigHash: HASH,
    allowanceAt: 1,
    allowanceCapUsd6: "5000000",
  };
  const all = { zgWallet: true, zgKey: true, registration: true, allowance: true };

  test("a fully provisioned agent has no gaps", () => {
    expect(provisioningGaps(agent, complete, all)).toEqual([]);
  });

  test("steps the environment cannot perform are not gaps", () => {
    expect(provisioningGaps({ ...agent, zgWallet: null }, {}, {})).toEqual([]);
  });

  test("each missing step is named", () => {
    expect(provisioningGaps({ ...agent, tradingWallet: PLACEHOLDER_WALLET }, {}, {})).toEqual(["trading wallet"]);
    expect(provisioningGaps({ ...agent, zgWallet: null }, {}, { zgWallet: true })).toEqual(["0G wallet"]);
    expect(provisioningGaps(agent, {}, { zgKey: true })).toEqual(["0G key"]);
    expect(provisioningGaps(agent, {}, { registration: true })).toEqual(["registration"]);
    expect(provisioningGaps(agent, {}, { allowance: true })).toEqual(["allowance"]);
  });

  test("a changed configHash or allowance cap reopens config sync and allowance", () => {
    expect(provisioningGaps(agent, { ...complete, syncedConfigHash: `0x${"cd".repeat(32)}` }, all)).toEqual(["config sync"]);
    expect(provisioningGaps({ ...agent, config: config(7) }, complete, all)).toEqual(["allowance"]);
  });
});

describe("listAgentsNeedingProvisioning", () => {
  test("lists agents with a gap, skips provisioned and stopped agents", async () => {
    const db = await freshDb();
    await newAgent(db, "needs-wallet");
    await newAgent(db, "has-wallet", { tradingWallet: WALLET });
    await newAgent(db, "stopped-no-wallet", { status: "stopped" });

    const none = await listAgentsNeedingProvisioning(db, {});
    expect(none.map((a) => a.id)).toEqual(["needs-wallet"]);

    const withRegistration = await listAgentsNeedingProvisioning(db, { registration: true });
    expect(withRegistration.map((a) => a.id).sort()).toEqual(["has-wallet", "needs-wallet"]);
  });

  test("a paused agent still needs provisioning (the web app creates agents paused)", async () => {
    const db = await freshDb();
    await newAgent(db, "paused-agent", { status: "paused" });
    expect((await listAgentsNeedingProvisioning(db)).map((a) => a.id)).toEqual(["paused-agent"]);
  });
});

describe("setAgentWallets and updateProvisioning", () => {
  test("setAgentWallets stores lowercase addresses and leaves omitted fields alone", async () => {
    const db = await freshDb();
    await newAgent(db, "a1");
    const agent = await setAgentWallets(db, "a1", { tradingWallet: `0x${"Aa".repeat(20)}` });
    expect(agent?.tradingWallet).toBe(`0x${"aa".repeat(20)}`);
    expect(agent?.zgWallet).toBeNull();

    const both = await setAgentWallets(db, "a1", { zgWallet: ZG });
    expect(both?.tradingWallet).toBe(`0x${"aa".repeat(20)}`);
    expect(both?.zgWallet).toBe(ZG);

    const cleared = await setAgentWallets(db, "a1", { zgWallet: null });
    expect(cleared?.zgWallet).toBeNull();
  });

  test("updateProvisioning shallow-merges: earlier steps survive later patches, null clears a field", async () => {
    const db = await freshDb();
    await newAgent(db, "a1");
    expect(await getProvisioning(db, "a1")).toEqual({});

    await updateProvisioning(db, "a1", { walletAt: 100, error: "boom", attempts: 1 });
    const merged = await updateProvisioning(db, "a1", { zgKeyId: "key-1", registeredTx: HASH, error: null });
    expect(merged).toEqual({ walletAt: 100, zgKeyId: "key-1", registeredTx: HASH, error: null, attempts: 1 });
    expect(await getProvisioning(db, "a1")).toEqual(merged);
  });

  test("updateProvisioning on a missing agent throws", async () => {
    const db = await freshDb();
    await expect(updateProvisioning(db, "nope", { walletAt: 1 })).rejects.toThrow("agent not found");
  });

  test("status changes do not disturb provisioning", async () => {
    const db = await freshDb();
    await newAgent(db, "a1");
    await updateProvisioning(db, "a1", { walletAt: 5 });
    await setAgentStatus(db, "a1", "paused");
    expect((await getAgent(db, "a1"))?.status).toBe("paused");
    expect(await getProvisioning(db, "a1")).toEqual({ walletAt: 5 });
  });
});

describe("zg key secrets", () => {
  test("getZgKeySecret returns the newest key that has a stored secret", async () => {
    const db = await freshDb();
    await newAgent(db, "a1");
    expect(await getZgKeySecret(db, "a1")).toBeNull();

    await insertZgKey(db, { keyId: "old", agentId: "a1", creditLimit: 1, resetPeriod: "daily", createdAt: 10, encryptedSecret: "v1.old" });
    await insertZgKey(db, { keyId: "new", agentId: "a1", creditLimit: 1, resetPeriod: "daily", createdAt: 20, encryptedSecret: "v1.new" });
    await insertZgKey(db, { keyId: "no-secret", agentId: "a1", creditLimit: 1, resetPeriod: "daily", createdAt: 30 });

    expect(await getZgKeySecret(db, "a1")).toEqual({ keyId: "new", encryptedSecret: "v1.new" });
  });

  test("a key row without a secret stores no plaintext", async () => {
    const db = await freshDb();
    await newAgent(db, "a1");
    await insertZgKey(db, { keyId: "k", agentId: "a1", creditLimit: 1, resetPeriod: "daily", createdAt: 1 });
    const rows = await db.query.zgKeys.findMany({ where: (z, { eq }) => eq(z.agentId, "a1") });
    expect(rows[0]?.encryptedSecret).toBeNull();
  });

  test("setAgentWallets on an unknown agent returns null", async () => {
    const db = await freshDb();
    expect(await setAgentWallets(db, "missing", { tradingWallet: WALLET })).toBeNull();
  });
});
