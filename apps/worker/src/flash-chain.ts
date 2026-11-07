// Base mainnet reads for Flash approvals: native balance and receipts. Sends are made by the wallet providers
// (createViemLocalSend for dev keys, Privy for server wallets), so this module never holds a key.

import type { Hex } from "viem";
import type { ChainConfig } from "./chain.ts";
import { publicClientFor } from "./chain.ts";
import type { FlashChainClient } from "./wallets.ts";

/** How long to wait for an approval receipt. Base blocks are ~2 s, so this is generous. */
export const FLASH_RECEIPT_TIMEOUT_MS = 180_000;

export function createViemFlashChain(config: ChainConfig): FlashChainClient {
  const client = publicClientFor(config);
  return {
    async ethBalance(address) {
      return client.getBalance({ address });
    },
    async waitForReceipt(hash: Hex) {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: FLASH_RECEIPT_TIMEOUT_MS });
      return receipt.status;
    },
  };
}
