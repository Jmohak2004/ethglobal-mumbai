// placeOrder's live path with Flash approvals. Fakes only: a scripted executor, a fake Base mainnet sender and a
// fake wallet provider. Nothing is signed for real, nothing is sent, and the Flash API is never called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@arena/db";
import { closeDb } from "@arena/db";
import {
  FlashApprovalRequiredError,
  type ApprovalRequirements,
  type ExecutionResult,
  type OrderSigner,
  type QuoteResponse,
} from "@arena/flash";
import type { Agent, ExecutionMode, OrderIntent } from "@arena/shared";
import type { Hex } from "viem";
import { FLASH_SETUP_UNSUPPORTED, placeOrder } from "./execution.ts";
import { deps, FakeExecutor, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";
import type { FlashSender, FlashTxResult, TxRequest, WalletProvider } from "./wallets.ts";

const INTENT: OrderIntent = { side: "buy", asset: "WETH", quoteAsset: "USDC", orderType: "market", notionalUsd: 100 };
const SIGNATURE: Hex = `0x${"cd".repeat(65)}`;
const WETH = `0x4200000000000000000000000000000000000006` as const;
const USDC_APPROVE = { to: `0x${"33".repeat(20)}`, data: `0x095ea7b3${"00".repeat(64)}` } as const;
const BRACKET_APPROVE = { to: WETH, data: `0x095ea7b3${"11".repeat(64)}` } as const;
const WRAP = { to: WETH, data: "0xd0e30db0", value: "1000" } as const;

let db: Db;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await closeDb(db);
});

/** The n-th transaction the fake Base mainnet sender mines (1-based), as a hash. */
function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Approval requirements with only the named parts set. requiresOnchainTx follows them, as in signing.ts. */
function requirements(
  parts: Partial<Pick<ApprovalRequirements, "approveTx" | "wrapTx" | "bracketApproveTx" | "setupTxs">>,
): ApprovalRequirements {
  const approveTx = parts.approveTx ?? null;
  const wrapTx = parts.wrapTx ?? null;
  const bracketApproveTx = parts.bracketApproveTx ?? null;
  const setupTxs = parts.setupTxs ?? [];
  return {
    approveTx,
    wrapTx,
    setupTxs,
    bracketApproveTx,
    permitTypedData: null,
    bracketPermitTypedData: null,
    permit2Address: null,
    requiresOnchainTx: Boolean(approveTx || wrapTx || bracketApproveTx || setupTxs.length),
    requiresPermitSignature: false,
  };
}

/** Live executor that answers each call from `steps`: "approval" throws FlashApprovalRequiredError, "submit" succeeds. */
class ScriptedExecutor {
  readonly modes: ExecutionMode[] = [];

  constructor(
    private readonly steps: Array<"approval" | "submit">,
    private readonly needs: ApprovalRequirements,
  ) {}

  async execute(_intent: OrderIntent, _signer: OrderSigner, mode: ExecutionMode): Promise<ExecutionResult> {
    this.modes.push(mode);
    const quote = { quoteId: `quote-${this.modes.length}` } as unknown as QuoteResponse;
    if (this.steps.shift() === "approval") throw new FlashApprovalRequiredError(this.needs, quote);
    return { paper: false, orderId: "flash-order-1", status: "submitted", quote, attachedBracketStatus: null };
  }
}

/** Base mainnet sender that records every tx. `revertAt` is the 0-based index of the tx that is mined as reverted. */
class FakeFlashSender implements FlashSender {
  readonly sent: TxRequest[] = [];
  balance = 10n ** 16n;
  revertAt = -1;

  constructor(readonly address: Hex) {}

  async ethBalance(): Promise<bigint> {
    return this.balance;
  }

  async sendAndWait(tx: TxRequest): Promise<FlashTxResult> {
    const index = this.sent.push(tx) - 1;
    return { hash: txHash(index + 1), status: index === this.revertAt ? "reverted" : "success" };
  }
}

/** Wallet provider for one agent. Counts Flash sender lookups; omits flashSenderFor when `flash` is null. */
function walletsFor(agent: Agent, flash: FlashSender | null): { wallets: WalletProvider; flashLookups: () => number } {
  let lookups = 0;
  const wallets: WalletProvider = {
    async signerFor() {
      return { address: agent.tradingWallet, signTypedData: async () => SIGNATURE };
    },
    async messageSignerFor() {
      throw new Error("not used by placeOrder");
    },
    async addressFor() {
      return agent.tradingWallet;
    },
    ...(flash
      ? {
          flashSenderFor: async () => {
            lookups += 1;
            return flash;
          },
        }
      : {}),
  };
  return { wallets, flashLookups: () => lookups };
}

describe("placeOrder: live orders that need Flash approvals", () => {
  test("approval required: approve is sent on the Base mainnet sender, the order is quoted again and submitted", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new ScriptedExecutor(["approval", "submit"], requirements({ approveTx: USDC_APPROVE }));
    const { wallets, flashLookups } = walletsFor(agent, sender);

    const placed = await placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW);

    expect(sender.sent).toEqual([USDC_APPROVE]);
    expect(executor.modes).toEqual(["live", "live"]);
    expect(flashLookups()).toBe(1);
    expect(placed.mode).toBe("live");
    expect(placed.orderId).toBe("flash-order-1");
    expect(placed.approvalTxs).toEqual([txHash(1)]);
    expect(placed.persist.record.raw).toMatchObject({ approvalTxs: [txHash(1)] });
  });

  test("wrap, then approve, then bracket approve: each is mined before the next is sent", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new ScriptedExecutor(
      ["approval", "submit"],
      requirements({ wrapTx: WRAP, approveTx: USDC_APPROVE, bracketApproveTx: BRACKET_APPROVE }),
    );
    const { wallets } = walletsFor(agent, sender);

    const placed = await placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW);

    expect(sender.sent).toEqual([{ to: WRAP.to, data: WRAP.data, value: 1000n }, USDC_APPROVE, BRACKET_APPROVE]);
    expect(placed.approvalTxs).toEqual([txHash(1), txHash(2), txHash(3)]);
    expect(executor.modes).toEqual(["live", "live"]);
  });

  test("quote setupTxs fail with a clear error before any approval is sent, and the order is not retried", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new ScriptedExecutor(["approval"], requirements({ approveTx: USDC_APPROVE, setupTxs: ["0x02f8"] }));
    const { wallets } = walletsFor(agent, sender);

    await expect(
      placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW),
    ).rejects.toThrow(FLASH_SETUP_UNSUPPORTED);
    expect(sender.sent).toEqual([]);
    expect(executor.modes).toEqual(["live"]);
  });

  test("zero Base mainnet ETH fails with a clear error and sends nothing", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    sender.balance = 0n;
    const executor = new ScriptedExecutor(["approval"], requirements({ approveTx: USDC_APPROVE }));
    const { wallets } = walletsFor(agent, sender);

    await expect(
      placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW),
    ).rejects.toThrow("needs gas on Base mainnet");
    expect(sender.sent).toEqual([]);
    expect(executor.modes).toEqual(["live"]);
  });

  test("a second approval request in the same call is an error, not a loop", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new ScriptedExecutor(["approval", "approval"], requirements({ approveTx: USDC_APPROVE }));
    const { wallets } = walletsFor(agent, sender);

    const err = await placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("not sending another approval round");
    expect((err as Error).message).toContain(txHash(1));
    expect(sender.sent).toEqual([USDC_APPROVE]);
    expect(executor.modes).toEqual(["live", "live"]);
  });

  test("a reverted approval stops the order, and the reverted hash is named in the error", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    sender.revertAt = 0;
    const executor = new ScriptedExecutor(["approval"], requirements({ approveTx: USDC_APPROVE }));
    const { wallets } = walletsFor(agent, sender);

    await expect(
      placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW),
    ).rejects.toThrow(`reverted on Base mainnet (tx ${txHash(1)})`);
    expect(executor.modes).toEqual(["live"]);
  });

  test("a wallet provider without a Flash sender fails with a clear error", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const executor = new ScriptedExecutor(["approval"], requirements({ approveTx: USDC_APPROVE }));
    const { wallets } = walletsFor(agent, null);

    await expect(
      placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW),
    ).rejects.toThrow("cannot send Flash approvals on Base mainnet");
    expect(executor.modes).toEqual(["live"]);
  });
});

describe("placeOrder: paper mode never sends", () => {
  test("a live agent on a paper platform gets a paper order and no Flash sender is touched", async () => {
    const agent = await seedAgent(db, { mode: "live" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new FakeExecutor();
    const { wallets, flashLookups } = walletsFor(agent, sender);

    const placed = await placeOrder(deps({ db, executionMode: "paper", wallets, executor }), agent, INTENT, 2000, NOW);

    expect(placed.mode).toBe("paper");
    expect(placed.approvalTxs).toEqual([]);
    expect(executor.calls.map((c) => c.mode)).toEqual(["paper"]);
    expect(flashLookups()).toBe(0);
    expect(sender.sent).toEqual([]);
  });

  test("a paper agent on a live platform gets a paper order and no Flash sender is touched", async () => {
    const agent = await seedAgent(db, { mode: "paper" });
    const sender = new FakeFlashSender(agent.tradingWallet);
    const executor = new FakeExecutor();
    const { wallets, flashLookups } = walletsFor(agent, sender);

    const placed = await placeOrder(deps({ db, executionMode: "live", wallets, executor }), agent, INTENT, 2000, NOW);

    expect(placed.mode).toBe("paper");
    expect(executor.calls.map((c) => c.mode)).toEqual(["paper"]);
    expect(flashLookups()).toBe(0);
    expect(sender.sent).toEqual([]);
  });
});
