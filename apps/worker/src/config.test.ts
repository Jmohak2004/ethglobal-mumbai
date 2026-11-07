import { describe, expect, test } from "bun:test";
import { loadWorkerEnv } from "./env.ts";
import { accountIndexFor, LocalWalletProvider, UnconfiguredWalletProvider } from "./wallets.ts";
import { createLogger } from "./logger.ts";
import { english, generateMnemonic } from "viem/accounts";

// Generated per run, so no mnemonic is kept in the repository.
const TEST_MNEMONIC = generateMnemonic(english);

describe("loadWorkerEnv", () => {
  test("defaults keep the worker in paper mode on Base Sepolia", () => {
    const env = loadWorkerEnv({});
    expect(env.EXECUTION_MODE).toBe("paper");
    expect(env.CHAIN).toBe("baseSepolia");
    expect(env.WORKER_MAX_CONCURRENCY).toBe(3);
    expect(env.AGENT_SEED_CREDIT_0G).toBe(1);
    expect(env.RELAYER_MAX_REQUEST_USD).toBe(2);
    expect(env.ZG_DEPOSIT_RECIPIENT).toBeUndefined();
  });

  test("blank values are treated as unset", () => {
    const env = loadWorkerEnv({ TREASURY_ADDRESS: "  ", ZG_ROUTER_URL: "", OPERATOR_PRIVATE_KEY: "" });
    expect(env.TREASURY_ADDRESS).toBeUndefined();
    expect(env.ZG_ROUTER_URL).toBeUndefined();
    expect(env.OPERATOR_PRIVATE_KEY).toBeUndefined();
  });

  test("malformed addresses and keys fail at startup", () => {
    expect(() => loadWorkerEnv({ TREASURY_ADDRESS: "0x1234" })).toThrow();
    expect(() => loadWorkerEnv({ RELAYER_ZG_PRIVATE_KEY: "0xabc" })).toThrow();
    expect(() => loadWorkerEnv({ CHAIN: "mainnet" })).toThrow();
  });
});

describe("wallets", () => {
  test("a mnemonic gives each agent a stable, distinct account", async () => {
    const wallets = new LocalWalletProvider({ mnemonic: TEST_MNEMONIC });
    const a1 = await wallets.addressFor({ id: "agent-a" });
    const a2 = await wallets.addressFor({ id: "agent-a" });
    const b = await wallets.addressFor({ id: "agent-b" });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    const signer = await wallets.signerFor({ id: "agent-a" });
    expect(signer.address).toBe(a1);
  });

  test("the account index is stable and within the non-hardened range", () => {
    expect(accountIndexFor("agent-a")).toBe(accountIndexFor("agent-a"));
    expect(accountIndexFor("agent-a")).toBeLessThan(2 ** 31);
  });

  test("a bad mnemonic is rejected at construction", () => {
    expect(() => new LocalWalletProvider({ mnemonic: "not a real mnemonic phrase" })).toThrow();
  });

  test("with no key material, construction fails", () => {
    expect(() => new LocalWalletProvider({})).toThrow("DEV_AGENT_MNEMONIC");
  });

  test("the message signer is the trading address, and signs EIP-191 over the exact text", async () => {
    const wallets = new LocalWalletProvider({ mnemonic: TEST_MNEMONIC });
    const message = await wallets.messageSignerFor({ id: "agent-a" });
    expect(message.address).toBe(await wallets.addressFor({ id: "agent-a" }));
    const signature = await message.signMessage("Definitive Flash v1 — Cancel Order\nOrder: x");
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  test("local approvals need a configured chain sender, and fail clearly without one", async () => {
    const wallets = new LocalWalletProvider({ mnemonic: TEST_MNEMONIC });
    const sender = await wallets.tradingSenderFor({ id: "agent-a" });
    expect(sender.address).toBe(await wallets.addressFor({ id: "agent-a" }));
    await expect(sender.sendTransaction({ to: `0x${"11".repeat(20)}`, data: "0x" })).rejects.toThrow("no sendTransaction");
  });

  test("an unconfigured provider fails every wallet call with its reason", async () => {
    const wallets = new UnconfiguredWalletProvider("WALLET_PROVIDER=local needs DEV_AGENT_MNEMONIC");
    await expect(wallets.addressFor({ id: "agent-a" })).rejects.toThrow("DEV_AGENT_MNEMONIC");
    await expect(wallets.signerFor({ id: "agent-a" })).rejects.toThrow("DEV_AGENT_MNEMONIC");
    await expect(wallets.messageSignerFor({ id: "agent-a" })).rejects.toThrow("DEV_AGENT_MNEMONIC");
  });
});

describe("wallet provider selection", () => {
  test("WALLET_PROVIDER defaults to local", () => {
    expect(loadWorkerEnv({}).WALLET_PROVIDER).toBe("local");
  });

  test("WALLET_PROVIDER=privy needs both Privy credentials at startup", () => {
    expect(() => loadWorkerEnv({ WALLET_PROVIDER: "privy" })).toThrow();
    expect(() => loadWorkerEnv({ WALLET_PROVIDER: "privy", PRIVY_APP_ID: "app" })).toThrow();
    const env = loadWorkerEnv({ WALLET_PROVIDER: "privy", PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" });
    expect(env.WALLET_PROVIDER).toBe("privy");
  });

  test("an unknown WALLET_PROVIDER is rejected", () => {
    expect(() => loadWorkerEnv({ WALLET_PROVIDER: "turnkey" })).toThrow();
  });
});

describe("logger", () => {
  test("writes one JSON line per event with agent and request ids, and redacts secret-looking keys", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line), now: () => 0 }).child({ agent: "ag-1", req: "rq-1" });
    log.info("tick decided", { verdict: "approve", apiKey: "sk-secret", mgmtKey: "mk-x", privateKey: "0xabc" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.msg).toBe("tick decided");
    expect(parsed.agent).toBe("ag-1");
    expect(parsed.req).toBe("rq-1");
    expect(parsed.verdict).toBe("approve");
    expect(parsed.apiKey).toBe("[redacted]");
    expect(parsed.mgmtKey).toBe("[redacted]");
    expect(parsed.privateKey).toBe("[redacted]");
    expect(lines[0]).not.toContain("sk-secret");
  });

  test("levels below the minimum are dropped", () => {
    const lines: string[] = [];
    const log = createLogger({ minLevel: "warn", write: (line) => lines.push(line) });
    log.info("quiet");
    log.warn("loud");
    expect(lines).toHaveLength(1);
  });
});
