// Local wallet provider's Flash sender, against fakes. No RPC: the send and the Base mainnet client are recorded.

import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { flashSenderOf, LocalWalletProvider, type FlashChainClient, type TxRequest } from "./wallets.ts";

const HASH: Hex = `0x${"ab".repeat(32)}`;
const TO: Hex = `0x${"44".repeat(20)}`;

describe("LocalWalletProvider flash sender", () => {
  test("sends from the agent's local account through the Base mainnet send, then waits for the receipt", async () => {
    const sends: Array<TxRequest & { from: Hex }> = [];
    const waited: Hex[] = [];
    const chain: FlashChainClient = {
      async ethBalance() {
        return 5n;
      },
      async waitForReceipt(hash) {
        waited.push(hash);
        return "success";
      },
    };
    const provider = new LocalWalletProvider({
      privateKey: generatePrivateKey(),
      flash: {
        chain,
        sendTransaction: async (account, tx) => {
          sends.push({ from: account.address, ...tx });
          return HASH;
        },
      },
    });
    const agent = { id: "agent-a" };

    const sender = await provider.flashSenderFor(agent);
    expect(sender.address).toBe(await provider.addressFor(agent));
    expect(await sender.ethBalance()).toBe(5n);
    expect(await sender.sendAndWait({ to: TO, data: "0x", value: 0n })).toEqual({ hash: HASH, status: "success" });

    expect(sends).toEqual([{ from: sender.address, to: TO, data: "0x", value: 0n }]);
    expect(waited).toEqual([HASH]);
  });

  test("without a Base mainnet client, Flash sends fail with a clear error", async () => {
    const provider = new LocalWalletProvider({ privateKey: generatePrivateKey() });
    await expect(provider.flashSenderFor({ id: "agent-a" })).rejects.toThrow("no flash chain is configured");
  });
});

describe("flashSenderOf", () => {
  test("a receipt that never arrives names the hash that was sent", async () => {
    const chain: FlashChainClient = {
      async ethBalance() {
        return 1n;
      },
      async waitForReceipt() {
        throw new Error("timed out");
      },
    };
    const sender = flashSenderOf(TO, async () => HASH, chain);
    await expect(sender.sendAndWait({ to: TO, data: "0x" })).rejects.toThrow(`tx ${HASH} was sent on Base mainnet`);
  });
});
