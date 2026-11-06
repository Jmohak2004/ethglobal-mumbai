import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createAgent, getAgent, getZgKeySecret, updateConfig, type Db } from "@arena/db";
import { configHash } from "@arena/policy";
import { agentIdToBytes32, toUsd6, type Agent, type StrategyConfig } from "@arena/shared";
import type { CreatedKey, CreateCappedKeyInput } from "@arena/zerog";
import type { Hex } from "viem";
import { english, generatePrivateKey, generateMnemonic } from "viem/accounts";
import { loadWorkerEnv } from "./env.ts";
import { getAgentZgKey, backoffMs, GAS_RETRY_MS, provisionAgent, provisionPass, provisioningRequirements, TEMPLATE_INDEX, type AllowanceWriter, type OnchainAgentRecord, type ProvisionDeps, type RegistryWriter, type ZgKeyMinter } from "./provisioner.ts";
import { silentLogger } from "./logger.ts";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./secrets.ts";
import { fixedClock, memoryDb, seedAgent } from "./test-fixtures.ts";
import { LocalWalletProvider, ZG_WALLET_ACCOUNT_INDEX, accountIndexFor, type TradingSender, type WalletProvider } from "./wallets.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const TREASURY = "0x7777777777777777777777777777777777777777" as const;
const ENC_KEY = parseEncryptionKey("11".repeat(32));
const OTHER_ENC_KEY = parseEncryptionKey("22".repeat(32));
const OPERATOR = `0x${"aa".repeat(20)}` as const;
const txHash = (label: string, n: number): Hex => `0x${(label.charCodeAt(0) * 1000 + n).toString(16).padStart(64, "0")}` as Hex;

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

/** Records every 0G key request and returns a fresh secret for each. */
class FakeZgMinter implements ZgKeyMinter {
  readonly calls: CreateCappedKeyInput[] = [];
  readonly secrets: string[] = [];
  async createCappedKey(input: CreateCappedKeyInput): Promise<CreatedKey> {
    this.calls.push(input);
    const key = `sk-secret-${this.calls.length}-${crypto.randomUUID()}`;
    this.secrets.push(key);
    return { key, keyId: `key-${this.calls.length}`, expiresAt: null, raw: {} };
  }
}

/** Keeps an in-memory AgentRegistry. Can be told to fail the next register. */
class FakeRegistry implements RegistryWriter {
  readonly operator = OPERATOR as Hex;
  readonly onchain = new Map<Hex, OnchainAgentRecord>();
  readonly registers: Array<{ id: Hex; record: OnchainAgentRecord }> = [];
  readonly updates: Array<{ id: Hex; configHash: Hex }> = [];
  failRegister: string | null = null;

  async exists(id: Hex): Promise<boolean> {
    return this.onchain.has(id);
  }
  async configHashOf(id: Hex): Promise<Hex | null> {
    return this.onchain.get(id)?.configHash ?? null;
  }
  async register(id: Hex, record: OnchainAgentRecord): Promise<Hex> {
    if (this.failRegister) throw new Error(this.failRegister);
    this.registers.push({ id, record });
    this.onchain.set(id, record);
    return txHash("r", this.registers.length);
  }
  async updateConfig(id: Hex, hash: Hex): Promise<Hex> {
    this.updates.push({ id, configHash: hash });
    const record = this.onchain.get(id);
    if (record) this.onchain.set(id, { ...record, configHash: hash });
    return txHash("u", this.updates.length);
  }
}

/** Tracks ETH for gas and the USDC allowance per (owner, spender). */
class FakeAllowance implements AllowanceWriter {
  readonly eth = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly approvals: Array<{ owner: string; spender: string; amount: bigint }> = [];

  async ethBalance(address: Hex): Promise<bigint> {
    return this.eth.get(address.toLowerCase()) ?? 0n;
  }
  async allowance(owner: Hex, spender: Hex): Promise<bigint> {
    return this.allowances.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n;
  }
  async approve(from: TradingSender, spender: Hex, amountUsd6: bigint): Promise<Hex> {
    const owner = from.address.toLowerCase();
    this.approvals.push({ owner, spender: spender.toLowerCase(), amount: amountUsd6 });
    this.allowances.set(`${owner}:${spender.toLowerCase()}`, amountUsd6);
    return txHash("a", this.approvals.length);
  }
}

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

/** A trading agent with no wallet yet, the state the web app creates. */
async function unprovisionedAgent(db: Db, overrides: Partial<Parameters<typeof seedAgent>[1]> = {}): Promise<Agent> {
  return seedAgent(db, { tradingWallet: ZERO, zgWallet: null, status: "paused", ...overrides });
}

describe("provisioning: happy path", () => {
  let db: Db;
  let agent: Agent;
  let clock: ReturnType<typeof fixedClock>;
  let wallets: LocalWalletProvider;
  let minter: FakeZgMinter;
  let registry: FakeRegistry;
  let allowance: FakeAllowance;
  let deps: ProvisionDeps;
  let tradingAddress: string;

  beforeEach(async () => {
    db = await freshDb();
    agent = await unprovisionedAgent(db, { template: "momentum" });
    clock = fixedClock();
    wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    minter = new FakeZgMinter();
    registry = new FakeRegistry();
    allowance = new FakeAllowance();
    tradingAddress = wallets.localAccountFor({ id: agent.id }).address;
    // Gas for the trading wallet, so the approve can go through.
    allowance.eth.set(tradingAddress.toLowerCase(), 10n ** 16n);
    deps = {
      db,
      clock,
      logger: silentLogger,
      wallets,
      zgAccount: minter,
      encryptionKey: ENC_KEY,
      zgCreditLimit: 2,
      registry,
      allowance,
      treasury: TREASURY,
    };
  });

  test("runs every step once and records each one", async () => {
    const result = await provisionAgent(deps, agent);

    expect(result.status).toBe("ok");
    expect(result.error).toBeNull();
    expect(result.steps).toEqual({
      wallet: "done",
      zgWallet: "done",
      zgKey: "done",
      registration: "done",
      configSync: "already",
      allowance: "done",
    });

    const stored = await getAgent(db, agent.id);
    const zgAddress = (await wallets.zgAddressFor({ id: agent.id })).toLowerCase() as Hex;
    expect(stored?.tradingWallet).toBe(tradingAddress.toLowerCase() as Hex);
    expect(stored?.zgWallet).toBe(zgAddress);

    expect(minter.calls).toEqual([{ name: `agent-${agent.id}`, creditLimit: 2, resetPeriod: "daily" }]);
    expect(registry.registers).toHaveLength(1);
    expect(allowance.approvals).toEqual([{ owner: tradingAddress.toLowerCase(), spender: TREASURY.toLowerCase(), amount: toUsd6(5) }]);

    const state = (await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning;
    expect(state?.walletAt).toBeDefined();
    expect(state?.zgWalletAt).toBeDefined();
    expect(state?.zgKeyId).toBe("key-1");
    expect(state?.registeredTx).toBe(txHash("r", 1));
    expect(state?.allowanceTx).toBe(txHash("a", 1));
    expect(state?.allowanceCapUsd6).toBe(toUsd6(5).toString());
    expect(state?.error).toBeNull();
  });

  test("registers the agent with its onchain record", async () => {
    await provisionAgent(deps, agent);
    const first = registry.registers[0];
    if (!first) throw new Error("no registration");
    const { id, record } = first;

    expect(id).toBe(agentIdToBytes32(agent.id));
    expect(record).toEqual({
      owner: agent.ownerAddress,
      tradingWallet: tradingAddress.toLowerCase() as Hex,
      operator: OPERATOR,
      zgWallet: (await wallets.zgAddressFor({ id: agent.id })).toLowerCase() as Hex,
      creator: agent.ownerAddress,
      configHash: agent.configHash,
      forkedFrom: `0x${"0".repeat(64)}`,
      template: TEMPLATE_INDEX.momentum,
      commissionBps: agent.config.commissionBps,
      forkPriceUsd6: toUsd6(agent.config.fork.priceUsd),
      forkable: agent.config.fork.forkable,
      active: true,
    });
  });

  test("a rerun repeats nothing: no second key, registration, approve or wallet write", async () => {
    await provisionAgent(deps, agent);
    const before = await getAgent(db, agent.id);
    const second = await provisionAgent(deps, agent);

    expect(second.status).toBe("ok");
    expect(second.steps).toEqual({
      wallet: "already",
      zgWallet: "already",
      zgKey: "already",
      registration: "already",
      configSync: "already",
      allowance: "already",
    });
    expect(minter.calls).toHaveLength(1);
    expect(registry.registers).toHaveLength(1);
    expect(registry.updates).toHaveLength(0);
    expect(allowance.approvals).toHaveLength(1);
    expect(await getAgent(db, agent.id)).toEqual(before);
  });

  test("a stale caller copy of the agent does not re-derive the wallet", async () => {
    await provisionAgent(deps, agent);
    // The caller still holds the pre-provisioning copy (zero trading wallet).
    const second = await provisionAgent(deps, { ...agent, tradingWallet: ZERO });
    expect(second.steps.wallet).toBe("already");
    expect((await getAgent(db, agent.id))?.tradingWallet).toBe(tradingAddress.toLowerCase() as Hex);
  });

  test("the minted 0G secret is stored encrypted and round-trips", async () => {
    await provisionAgent(deps, agent);
    const stored = await getZgKeySecret(db, agent.id);
    expect(stored?.keyId).toBe("key-1");
    expect(stored?.encryptedSecret).not.toContain(minter.secrets[0] ?? "");
    expect(await getAgentZgKey({ db, encryptionKey: ENC_KEY }, agent.id)).toBe(minter.secrets[0] ?? null);
  });

  test("a forked agent is registered with its source as forkedFrom and the source owner as creator", async () => {
    const source = await seedAgent(db, { tradingWallet: ZERO, zgWallet: null, status: "paused" });
    const forkOwner = "0x9999999999999999999999999999999999999999";
    const fork = await createAgent(db, {
      id: crypto.randomUUID(),
      name: "fork",
      ownerAddress: forkOwner,
      tradingWallet: ZERO,
      config: source.config,
      configHash: source.configHash,
      status: "paused",
      forkedFrom: source.id,
    });
    await provisionAgent(deps, { ...fork, forkedFrom: source.id });
    const record = registry.registers.find((r) => r.record.owner === forkOwner)?.record;
    expect(record?.creator).toBe(source.ownerAddress);
    expect(record?.forkedFrom).toBe(agentIdToBytes32(source.id));
  });
});

describe("provisioning: missing config skips steps", () => {
  test("with no 0G management key, registry or treasury, only the wallets are provisioned", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const wallets = new LocalWalletProvider({ privateKey: generatePrivateKey() });
    const minter = new FakeZgMinter();
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: null,
      treasury: null,
    };

    const result = await provisionAgent(deps, agent);
    expect(result.status).toBe("ok");
    expect(result.steps).toEqual({
      wallet: "done",
      zgWallet: "done",
      zgKey: "skipped",
      registration: "skipped",
      configSync: "skipped",
      allowance: "skipped",
    });
    expect(minter.calls).toHaveLength(0);
    expect(provisioningRequirements(deps)).toEqual({ zgWallet: true, zgKey: false, registration: false, allowance: false });
  });

  test("a 0G key is not minted without the encryption key", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const minter = new FakeZgMinter();
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets: new LocalWalletProvider({ privateKey: generatePrivateKey() }),
      zgAccount: minter,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: null,
      treasury: null,
    };
    const result = await provisionAgent(deps, agent);
    expect(result.steps.zgKey).toBe("skipped");
    expect(minter.calls).toHaveLength(0);
  });

  test("a wallet provider without 0G or local keys skips those steps", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const custodial: WalletProvider = {
      addressFor: async () => `0x${"ce".repeat(20)}`,
      signerFor: async () => {
        throw new Error("not used");
      },
      messageSignerFor: async () => {
        throw new Error("not used");
      },
    };
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets: custodial,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: new FakeAllowance(),
      treasury: TREASURY,
    };
    const result = await provisionAgent(deps, agent);
    expect(result.steps.zgWallet).toBe("skipped");
    expect(result.steps.allowance).toBe("skipped");
    expect(result.status).toBe("ok");
  });

  test("provisionPass only touches agents with a gap in this environment", async () => {
    const db = await freshDb();
    const pending = await unprovisionedAgent(db);
    await seedAgent(db, { tradingWallet: `0x${"be".repeat(20)}`, zgWallet: `0x${"bf".repeat(20)}` });
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets: new LocalWalletProvider({ privateKey: generatePrivateKey() }),
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: null,
      treasury: null,
    };
    const results = await provisionPass(deps);
    expect(results.map((r) => r.agentId)).toEqual([pending.id]);
  });
});

describe("provisioning: failures and retries", () => {
  test("a failed step is recorded, backs off, and succeeds on a later pass without repeating earlier steps", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const clock = fixedClock();
    const wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    const minter = new FakeZgMinter();
    const registry = new FakeRegistry();
    const allowance = new FakeAllowance();
    const address = wallets.localAccountFor({ id: agent.id }).address;
    allowance.eth.set(address.toLowerCase(), 1n);
    const deps: ProvisionDeps = {
      db,
      clock,
      logger: silentLogger,
      wallets,
      zgAccount: minter,
      encryptionKey: ENC_KEY,
      zgCreditLimit: 1,
      registry,
      allowance,
      treasury: TREASURY,
    };

    registry.failRegister = "rpc unavailable";
    const failed = await provisionAgent(deps, agent);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("rpc unavailable");
    expect(minter.calls).toHaveLength(1);
    expect((await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning).toMatchObject({
      error: "rpc unavailable",
      attempts: 1,
      nextAttemptAt: clock.now() + backoffMs(1),
    });

    // Inside the backoff window nothing is attempted.
    const cooling = await provisionAgent(deps, agent);
    expect(cooling.status).toBe("backoff");
    expect(minter.calls).toHaveLength(1);

    clock.advance(backoffMs(1));
    registry.failRegister = null;
    const recovered = await provisionAgent(deps, agent);
    expect(recovered.status).toBe("ok");
    expect(recovered.steps.zgKey).toBe("already");
    expect(recovered.steps.registration).toBe("done");
    expect(minter.calls).toHaveLength(1);
    expect(registry.registers).toHaveLength(1);
    const state = (await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning;
    expect(state?.error).toBeNull();
    expect(state?.attempts).toBe(0);
    expect(state?.nextAttemptAt).toBeNull();
  });

  test("backoff grows and is capped", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(50)).toBe(30 * 60_000);
  });

  test("an agent that does not exist is reported as failed, not thrown", async () => {
    const db = await freshDb();
    const ghost = { ...(await unprovisionedAgent(db)), id: "no-such-agent" };
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets: new LocalWalletProvider({ privateKey: generatePrivateKey() }),
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: null,
      treasury: null,
    };
    const result = await provisionAgent(deps, ghost);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("agent not found");
  });
});

describe("provisioning: needs gas", () => {
  test("with no ETH for gas the approve waits and retries after GAS_RETRY_MS, without failing", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const clock = fixedClock();
    const wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    const allowance = new FakeAllowance();
    const address = wallets.localAccountFor({ id: agent.id }).address;
    const deps: ProvisionDeps = {
      db,
      clock,
      logger: silentLogger,
      wallets,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance,
      treasury: TREASURY,
    };

    const waiting = await provisionAgent(deps, agent);
    expect(waiting.status).toBe("waiting");
    expect(waiting.steps.allowance).toBe("waiting");
    expect(waiting.error).toBeNull();
    expect(allowance.approvals).toHaveLength(0);
    const stateWaiting = (await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning;
    expect(stateWaiting).toMatchObject({ needsGas: true, error: null, nextAttemptAt: clock.now() + GAS_RETRY_MS });

    // Too early: the retry is not due yet.
    expect((await provisionAgent(deps, agent)).status).toBe("backoff");

    // Gas arrives. The next due pass approves exactly once.
    allowance.eth.set(address.toLowerCase(), 10n ** 15n);
    clock.advance(GAS_RETRY_MS);
    const done = await provisionAgent(deps, agent);
    expect(done.status).toBe("ok");
    expect(done.steps.allowance).toBe("done");
    expect(allowance.approvals).toEqual([{ owner: address.toLowerCase(), spender: TREASURY.toLowerCase(), amount: toUsd6(5) }]);
    const stateDone = (await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning;
    expect(stateDone?.needsGas).toBe(false);
    expect(stateDone?.nextAttemptAt).toBeNull();
  });

  test("an allowance already large enough on chain is recorded without spending gas", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    const allowance = new FakeAllowance();
    const address = wallets.localAccountFor({ id: agent.id }).address;
    allowance.allowances.set(`${address.toLowerCase()}:${TREASURY.toLowerCase()}`, toUsd6(10));
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance,
      treasury: TREASURY,
    };
    const result = await provisionAgent(deps, agent);
    expect(result.steps.allowance).toBe("already");
    expect(allowance.approvals).toHaveLength(0);
  });
});

describe("provisioning: config sync", () => {
  test("a changed config re-syncs the configHash onchain once, and a raised cap re-approves", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    const registry = new FakeRegistry();
    const allowance = new FakeAllowance();
    allowance.eth.set(wallets.localAccountFor({ id: agent.id }).address.toLowerCase(), 10n ** 16n);
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry,
      allowance,
      treasury: TREASURY,
    };
    await provisionAgent(deps, agent);
    expect(registry.registers).toHaveLength(1);

    // Auto-tune or an owner edit: a new config version with a new hash.
    const edited: StrategyConfig = {
      ...agent.config,
      commissionBps: 500,
      limits: { ...agent.config.limits, maxAllocationUsd: 7 },
    };
    const newHash = configHash(edited);
    await updateConfig(db, agent.id, { config: edited, configHash: newHash, changelog: "owner edit" });

    const synced = await provisionAgent(deps, (await getAgent(db, agent.id)) as Agent);
    expect(synced.steps.configSync).toBe("done");
    expect(synced.steps.allowance).toBe("done");
    expect(registry.updates).toEqual([{ id: agentIdToBytes32(agent.id), configHash: newHash }]);
    expect(allowance.approvals.at(-1)?.amount).toBe(toUsd6(7));

    const again = await provisionAgent(deps, (await getAgent(db, agent.id)) as Agent);
    expect(again.steps.configSync).toBe("already");
    expect(registry.updates).toHaveLength(1);
  });

  test("an agent already registered onchain is adopted, not registered twice", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    const wallets = new LocalWalletProvider({ mnemonic: generateMnemonic(english) });
    const registry = new FakeRegistry();
    const address = wallets.localAccountFor({ id: agent.id }).address;
    registry.onchain.set(agentIdToBytes32(agent.id), {
      owner: agent.ownerAddress,
      tradingWallet: address,
      operator: OPERATOR,
      zgWallet: ZERO,
      creator: agent.ownerAddress,
      configHash: agent.configHash,
      forkedFrom: `0x${"0".repeat(64)}`,
      template: 0,
      commissionBps: 1000,
      forkPriceUsd6: 0n,
      forkable: false,
      active: true,
    });
    const deps: ProvisionDeps = {
      db,
      clock: fixedClock(),
      logger: silentLogger,
      wallets,
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry,
      allowance: null,
      treasury: null,
    };
    const result = await provisionAgent(deps, agent);
    expect(result.steps.registration).toBe("already");
    expect(registry.registers).toHaveLength(0);
    const state = (await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agent.id) }))?.provisioning;
    expect(state?.registeredAt).toBeDefined();
    expect(state?.registeredTx).toBeNull();
    expect(state?.syncedConfigHash).toBe(agent.configHash);
  });
});

describe("0G secret encryption", () => {
  test("AES-256-GCM round-trips and each encryption uses a fresh IV", () => {
    const first = encryptSecret("sk-live-123", ENC_KEY);
    const second = encryptSecret("sk-live-123", ENC_KEY);
    expect(first).not.toBe(second);
    expect(first).not.toContain("sk-live-123");
    expect(first.startsWith("v1.")).toBe(true);
    expect(decryptSecret(first, ENC_KEY)).toBe("sk-live-123");
    expect(decryptSecret(second, ENC_KEY)).toBe("sk-live-123");
  });

  test("a wrong key, a tampered payload or a malformed payload is rejected", () => {
    const payload = encryptSecret("sk-live-123", ENC_KEY);
    expect(() => decryptSecret(payload, OTHER_ENC_KEY)).toThrow();
    const [v, iv, tag, data] = payload.split(".");
    const flipped = `${v}.${iv}.${tag}.${data?.slice(0, -2)}${data?.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => decryptSecret(flipped, ENC_KEY)).toThrow();
    expect(() => decryptSecret("plain-text-key", ENC_KEY)).toThrow("unrecognised");
  });

  test("the encryption key must be 32 bytes of hex, with or without 0x", () => {
    expect(parseEncryptionKey(`0x${"ab".repeat(32)}`)).toHaveLength(32);
    expect(parseEncryptionKey("ab".repeat(32))).toHaveLength(32);
    expect(() => parseEncryptionKey("ab".repeat(16))).toThrow("32 bytes");
    expect(() => loadWorkerEnv({ AGENT_KEY_ENCRYPTION_KEY: "xyz" })).toThrow();
  });

  test("getAgentZgKey is null for an agent without a key, and throws rather than fall back when the key is unavailable", async () => {
    const db = await freshDb();
    const agent = await unprovisionedAgent(db);
    expect(await getAgentZgKey({ db, encryptionKey: ENC_KEY }, agent.id)).toBeNull();

    const minter = new FakeZgMinter();
    await provisionAgent(
      {
        db,
        clock: fixedClock(),
        logger: silentLogger,
        wallets: new LocalWalletProvider({ privateKey: generatePrivateKey() }),
        zgAccount: minter,
        encryptionKey: ENC_KEY,
        zgCreditLimit: 1,
        registry: null,
        allowance: null,
        treasury: null,
      },
      agent,
    );
    await expect(getAgentZgKey({ db, encryptionKey: null }, agent.id)).rejects.toThrow("AGENT_KEY_ENCRYPTION_KEY");
  });
});

describe("wallet derivation", () => {
  test("the 0G wallet is a different address from the trading wallet, deterministic per agent", async () => {
    const mnemonic = generateMnemonic(english);
    const wallets = new LocalWalletProvider({ mnemonic });
    const agent = { id: "agent-x" };
    const trading = await wallets.addressFor(agent);
    const zg = await wallets.zgAddressFor?.(agent);
    expect(zg).toBeDefined();
    expect(zg).not.toBe(trading);
    expect(await wallets.zgAddressFor?.(agent)).toBe(zg);
    expect(await wallets.zgAddressFor?.({ id: "agent-y" })).not.toBe(zg);
    expect(ZG_WALLET_ACCOUNT_INDEX).not.toBe(0);
    expect(accountIndexFor("agent-x")).toBeGreaterThanOrEqual(0);
  });

  test("the same holds for a single shared dev key", async () => {
    const wallets = new LocalWalletProvider({ privateKey: generatePrivateKey() });
    const trading = await wallets.addressFor({ id: "agent-x" });
    const zg = await wallets.zgAddressFor?.({ id: "agent-x" });
    expect(zg).toBeDefined();
    expect(zg).not.toBe(trading);
    expect(zg).not.toBe(await wallets.zgAddressFor?.({ id: "agent-y" }));
  });
});

describe("provisioning requirements", () => {
  test("follow the configured environment", () => {
    const db = { query: {} } as unknown as Db;
    const base: ProvisionDeps = {
      db,
      clock: fixedClock(),
      wallets: new LocalWalletProvider({ privateKey: generatePrivateKey() }),
      zgAccount: null,
      encryptionKey: null,
      zgCreditLimit: 1,
      registry: null,
      allowance: null,
      treasury: null,
    };
    expect(provisioningRequirements(base)).toEqual({ zgWallet: true, zgKey: false, registration: false, allowance: false });
    expect(
      provisioningRequirements({
        ...base,
        zgAccount: new FakeZgMinter(),
        encryptionKey: ENC_KEY,
        allowance: new FakeAllowance(),
        treasury: TREASURY,
        registry: new FakeRegistry(),
      }),
    ).toEqual({ zgWallet: true, zgKey: true, registration: true, allowance: true });
  });
});
