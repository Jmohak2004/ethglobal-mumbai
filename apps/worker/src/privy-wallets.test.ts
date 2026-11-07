// Privy server wallet provider against a fake @privy-io/node client. No network: every call is recorded.

import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { closeDb, getProvisioning, getAgent, updateProvisioning, type Db } from "@arena/db";
import type { SignableTypedData } from "@arena/flash";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import type { AllowanceWriter, ProvisionDeps } from "./provisioner.ts";
import { provisionAgent } from "./provisioner.ts";
import { silentLogger } from "./logger.ts";
import { fixedClock, memoryDb, seedAgent } from "./test-fixtures.ts";
import {
  authorizationPublicKey,
  PrivyWalletProvider,
  privyStoreFromDb,
  toPrivyTypedData,
  type PrivyServerClient,
  type PrivyWalletStore,
} from "./privy-wallets.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const CAIP2 = "eip155:84532";
const VERIFIER = `0x${"5e".repeat(20)}` as const;
const SIGNATURE = `0x${"cd".repeat(65)}` as const;
const HASH = `0x${"ef".repeat(32)}` as const;

/** Fake Privy wallets: each create gets the next id and a distinct address. Every call is recorded. */
function fakePrivy() {
  const created: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const signed: Array<{ op: "personal_sign" | "eth_signTypedData_v4" | "eth_sendTransaction"; walletId: string; input: Record<string, unknown> }> = [];
  let next = 0;
  const addressOf = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(20)}`;
  const client: PrivyServerClient = {
    wallets: () => ({
      async create(input) {
        created.push(input as Record<string, unknown>);
        next += 1;
        return { id: `wal_${next}`, address: addressOf(next) };
      },
      async get(walletId) {
        fetched.push(walletId);
        return { id: walletId, address: addressOf(Number(walletId.replace("wal_", ""))) };
      },
      ethereum: () => ({
        async signMessage(walletId, input) {
          signed.push({ op: "personal_sign", walletId, input: input as unknown as Record<string, unknown> });
          return { signature: SIGNATURE };
        },
        async signTypedData(walletId, input) {
          signed.push({ op: "eth_signTypedData_v4", walletId, input: input as unknown as Record<string, unknown> });
          return { signature: SIGNATURE };
        },
        async sendTransaction(walletId, input) {
          signed.push({ op: "eth_sendTransaction", walletId, input: input as unknown as Record<string, unknown> });
          return { hash: HASH };
        },
      }),
    }),
  };
  return { client, created, fetched, signed };
}

/** The provider's store, backed by a plain map, so tests can see what was saved. */
function memoryStore(initial: Record<string, string> = {}): { store: PrivyWalletStore; saved: Map<string, string> } {
  const saved = new Map(Object.entries(initial));
  return {
    saved,
    store: {
      async walletIdFor(agentId) {
        return saved.get(agentId) ?? null;
      },
      async saveWalletId(agentId, walletId) {
        saved.set(agentId, walletId);
      },
    },
  };
}

const FLASH_TYPED_DATA: SignableTypedData = {
  domain: { name: "Definitive Flash", version: "1", chainId: 84532, verifyingContract: VERIFIER },
  types: {
    Order: [
      { name: "size", type: "uint256" },
      { name: "side", type: "uint8" },
    ],
  },
  primaryType: "Order",
  message: { size: 1_000_000n, side: 1 },
};

describe("PrivyWalletProvider wallet lifecycle", () => {
  test("creates one Ethereum wallet per agent, once, with the policy and the stored id", async () => {
    const privy = fakePrivy();
    const { store, saved } = memoryStore();
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2, policyId: "pol_arena" });

    const first = await provider.addressFor({ id: "agent-a" });
    const again = await provider.addressFor({ id: "agent-a" });
    const signer = await provider.signerFor({ id: "agent-a" });
    await provider.messageSignerFor({ id: "agent-a" });

    expect(first).toBe(`0x${"01".repeat(20)}`);
    expect(again).toBe(first);
    expect(signer.address).toBe(first);
    expect(privy.created).toEqual([
      {
        chain_type: "ethereum",
        display_name: "arena agent agent-a",
        idempotency_key: "arena-trading-wallet:agent-a",
        policy_ids: ["pol_arena"],
      },
    ]);
    expect(saved.get("agent-a")).toBe("wal_1");
    expect(privy.fetched).toEqual([]);
  });

  test("a stored Privy id is looked up, never created again", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_7" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });

    const address = await provider.addressFor({ id: "agent-a" });
    expect(privy.created).toEqual([]);
    expect(privy.fetched).toEqual(["wal_7"]);
    expect(address).toBe(`0x${"07".repeat(20)}`);
  });

  test("concurrent first calls for one agent share a single creation", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore();
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const [a, s, m] = await Promise.all([
      provider.addressFor({ id: "agent-a" }),
      provider.signerFor({ id: "agent-a" }),
      provider.messageSignerFor({ id: "agent-a" }),
    ]);
    expect(privy.created).toHaveLength(1);
    expect(s.address).toBe(a);
    expect(m.address).toBe(a);
  });

  test("each agent gets its own wallet", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore();
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const a = await provider.addressFor({ id: "agent-a" });
    const b = await provider.addressFor({ id: "agent-b" });
    expect(a).not.toBe(b);
    expect(privy.created).toHaveLength(2);
  });
});

describe("PrivyWalletProvider signing", () => {
  test("OrderSigner.signTypedData sends eth_signTypedData_v4 with decimal integers and an explicit EIP712Domain", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const signer = await provider.signerFor({ id: "agent-a" });

    const signature = await signer.signTypedData(FLASH_TYPED_DATA);

    expect(signature).toBe(SIGNATURE);
    expect(privy.signed).toEqual([
      {
        op: "eth_signTypedData_v4",
        walletId: "wal_1",
        input: {
          caip2: CAIP2,
          params: {
            typed_data: {
              domain: { name: "Definitive Flash", version: "1", chainId: 84532, verifyingContract: VERIFIER },
              types: {
                EIP712Domain: [
                  { name: "name", type: "string" },
                  { name: "version", type: "string" },
                  { name: "chainId", type: "uint256" },
                  { name: "verifyingContract", type: "address" },
                ],
                Order: [
                  { name: "size", type: "uint256" },
                  { name: "side", type: "uint8" },
                ],
              },
              primary_type: "Order",
              message: { size: "1000000", side: 1 },
            },
          },
        },
      },
    ]);
  });

  test("MessageSigner.signMessage sends personal_sign over the exact UTF-8 bytes, even for text that starts with 0x", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const message = await provider.messageSignerFor({ id: "agent-a" });

    const text = "0xDefinitive Flash v1 — Cancel Order\nOrder: 0b1e";
    expect(await message.signMessage(text)).toBe(SIGNATURE);
    const [call] = privy.signed;
    expect(call?.op).toBe("personal_sign");
    expect(call?.walletId).toBe("wal_1");
    const bytes = (call?.input as { message: Uint8Array }).message;
    expect(new TextDecoder().decode(bytes)).toBe(text);
  });

  test("the trading sender sends eth_sendTransaction on the configured CAIP-2 chain, with value only when it is set", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const sender = await provider.tradingSenderFor({ id: "agent-a" });
    const usdc = `0x${"36".repeat(20)}` as const;
    const data = `0x095ea7b3${"00".repeat(64)}` as const;

    expect(await sender.sendTransaction({ to: usdc, data })).toBe(HASH);
    expect(await sender.sendTransaction({ to: usdc, data, value: 1000n })).toBe(HASH);

    expect(privy.signed).toEqual([
      { op: "eth_sendTransaction", walletId: "wal_1", input: { caip2: CAIP2, params: { transaction: { to: usdc, data } } } },
      { op: "eth_sendTransaction", walletId: "wal_1", input: { caip2: CAIP2, params: { transaction: { to: usdc, data, value: "0x3e8" } } } },
    ]);
  });

  test("a signature that is not 65 bytes of hex is rejected, not forwarded", async () => {
    const privy = fakePrivy();
    const bad: PrivyServerClient = {
      wallets: () => ({
        ...privy.client.wallets(),
        ethereum: () => ({
          ...privy.client.wallets().ethereum(),
          async signMessage() {
            return { signature: "0x1234" };
          },
        }),
      }),
    };
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: bad, store, caip2: CAIP2 });
    const message = await provider.messageSignerFor({ id: "agent-a" });
    await expect(message.signMessage("x")).rejects.toThrow("65 bytes");
  });
});

describe("PrivyWalletProvider authorization key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  test("the derived public key is the base64 SPKI form Privy takes as a wallet owner", () => {
    expect(authorizationPublicKey(pkcs8)).toBe(spki);
  });

  test("with an authorization key, new wallets are owned by its public key and every call is authorized by it", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore();
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2, authorizationKey: pkcs8 });
    const signer = await provider.signerFor({ id: "agent-a" });
    await signer.signTypedData(FLASH_TYPED_DATA);

    expect(privy.created[0]).toMatchObject({ owner: { public_key: spki } });
    expect(privy.signed[0]?.input).toMatchObject({ authorization_context: { authorization_private_keys: [pkcs8] } });
  });

  test("without one, wallets have no owner and calls carry no authorization", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore();
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    await provider.addressFor({ id: "agent-a" });
    expect(privy.created[0]).not.toHaveProperty("owner");
    expect(privy.created[0]).not.toHaveProperty("policy_ids");
  });
});

describe("toPrivyTypedData", () => {
  test("converts bigints recursively and keeps hex and numbers as they are", () => {
    const body = toPrivyTypedData({
      domain: { chainId: 1 },
      types: { Batch: [{ name: "items", type: "uint256[]" }] },
      primaryType: "Batch",
      message: { items: [1n, 2n] },
    });
    expect(body.message).toEqual({ items: ["1", "2"] });
    expect(body.types).toEqual({ EIP712Domain: [{ name: "chainId", type: "uint256" }], Batch: [{ name: "items", type: "uint256[]" }] });
  });
});

describe("privyStoreFromDb", () => {
  test("the Privy wallet id lives in the agent's provisioning jsonb, next to the other steps", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    await updateProvisioning(db, agent.id, { allowanceAt: 123 });

    const store = privyStoreFromDb(db);
    expect(await store.walletIdFor(agent.id)).toBeNull();
    await store.saveWalletId(agent.id, "wal_42");
    expect(await store.walletIdFor(agent.id)).toBe("wal_42");

    const state = await getProvisioning(db, agent.id);
    expect(state).toMatchObject({ allowanceAt: 123, privyWalletId: "wal_42" });
  });
});

describe("provisioning with a Privy trading wallet", () => {
  const USDC = `0x${"36".repeat(20)}` as const;
  const TREASURY_ADDR = `0x${"77".repeat(20)}` as const;
  const ZERO = `0x${"00".repeat(20)}` as const;

  test("creates the wallet, stores its id, and sends the USDC approve from it as eth_sendTransaction", async () => {
    const db = await memoryDb();
    dbs.push(db);
    // Active: paused agents get no allowance (provisioner step g), and this test is about the approve.
    const agent = await seedAgent(db, { tradingWallet: ZERO, zgWallet: null, status: "active" });
    const privy = fakePrivy();
    const wallets = new PrivyWalletProvider({ client: privy.client, store: privyStoreFromDb(db), caip2: CAIP2 });

    const approves: Array<{ spender: string; amount: bigint }> = [];
    const allowance: AllowanceWriter = {
      ethBalance: async () => 10n ** 15n,
      allowance: async () => 0n,
      approve: async (from, spender, amount) => {
        approves.push({ spender, amount });
        // The same calldata the viem allowance writer builds: approve(spender, amount) on USDC.
        const data = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [spender, amount] });
        return from.sendTransaction({ to: USDC, data });
      },
    };
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
      treasury: TREASURY_ADDR,
    };

    const result = await provisionAgent(deps, agent);

    expect(result.status).toBe("ok");
    expect(result.steps.wallet).toBe("done");
    expect(result.steps.allowance).toBe("done");
    const stored = await getAgent(db, agent.id);
    expect(stored?.tradingWallet).toBe(getAddress(`0x${"01".repeat(20)}`));
    expect(await getProvisioning(db, agent.id)).toMatchObject({ privyWalletId: "wal_1" });
    expect(privy.created).toHaveLength(1);
    expect(approves).toEqual([{ spender: TREASURY_ADDR, amount: 5_000_000n }]);
    expect(privy.signed).toEqual([
      {
        op: "eth_sendTransaction",
        walletId: "wal_1",
        input: {
          caip2: CAIP2,
          params: {
            transaction: {
              to: USDC,
              data: `0x095ea7b3${TREASURY_ADDR.slice(2).padStart(64, "0")}${(5_000_000n).toString(16).padStart(64, "0")}`,
            },
          },
        },
      },
    ]);
  });
});

describe("PrivyWalletProvider Base mainnet (Flash) calls", () => {
  test("Flash typed data is signed on the chain named in its domain, even when the provider chain is Base Sepolia", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    const signer = await provider.signerFor({ id: "agent-a" });

    await signer.signTypedData({ ...FLASH_TYPED_DATA, domain: { ...FLASH_TYPED_DATA.domain, chainId: 8453 } });

    expect(privy.signed).toHaveLength(1);
    expect(privy.signed[0]?.input.caip2).toBe("eip155:8453");
  });

  test("Flash approvals are sent on eip155:8453 and their receipts are read from the Base mainnet client", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const waited: string[] = [];
    const provider = new PrivyWalletProvider({
      client: privy.client,
      store,
      caip2: CAIP2,
      flash: {
        async ethBalance() {
          return 1n;
        },
        async waitForReceipt(hash) {
          waited.push(hash);
          return "success";
        },
      },
    });
    const usdc = `0x${"36".repeat(20)}` as const;
    const data = `0x095ea7b3${"00".repeat(64)}` as const;
    const sender = await provider.flashSenderFor({ id: "agent-a" });

    expect(await sender.sendAndWait({ to: usdc, data, value: 1000n })).toEqual({ hash: HASH, status: "success" });

    expect(privy.signed).toEqual([
      {
        op: "eth_sendTransaction",
        walletId: "wal_1",
        input: { caip2: "eip155:8453", params: { transaction: { to: usdc, data, value: "0x3e8" } } },
      },
    ]);
    expect(waited).toEqual([HASH]);
  });

  test("a Privy provider without a Base mainnet client fails Flash sends with a clear error", async () => {
    const privy = fakePrivy();
    const { store } = memoryStore({ "agent-a": "wal_1" });
    const provider = new PrivyWalletProvider({ client: privy.client, store, caip2: CAIP2 });
    await expect(provider.flashSenderFor({ id: "agent-a" })).rejects.toThrow("no flash chain is configured");
  });
});
