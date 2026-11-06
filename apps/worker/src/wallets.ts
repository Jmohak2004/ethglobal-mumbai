// Agent trading wallets. Dev only: LocalWalletProvider derives keys from a mnemonic or a single key.
// Production uses Privy server wallets with policies (PRD 7.4), which is only a stub here.

import { createHash } from "node:crypto";
import type { OrderSigner } from "@arena/flash";
import { mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import type { Hex } from "viem";

export interface WalletProvider {
  /** Signer for Flash EIP-712 orders. Only called for live orders. */
  signerFor(agent: { id: string }): Promise<OrderSigner>;
  /** The trading address that funds this agent's orders. */
  addressFor(agent: { id: string }): Promise<`0x${string}`>;
}

/** Stable BIP-32 index (non-hardened) for an agent id, so the same agent always gets the same account. */
export function accountIndexFor(agentId: string): number {
  return createHash("sha256").update(agentId).digest().readUInt32BE(0) & 0x7fffffff;
}

/** Wraps a viem local account as a Flash order signer. Same cast as @arena/flash localSigner. */
export function accountSigner(account: LocalAccount): OrderSigner {
  return {
    address: account.address,
    signTypedData: (td) => account.signTypedData(td as Parameters<typeof account.signTypedData>[0]),
  };
}

export class LocalWalletProvider implements WalletProvider {
  private readonly accountFor: (agentId: string) => LocalAccount;

  constructor(opts: { mnemonic?: string; privateKey?: Hex }) {
    if (opts.mnemonic) {
      const mnemonic = opts.mnemonic.trim();
      // Throws on an invalid mnemonic, which is what we want at startup.
      mnemonicToAccount(mnemonic, { addressIndex: 0 });
      this.accountFor = (agentId) => mnemonicToAccount(mnemonic, { addressIndex: accountIndexFor(agentId) });
    } else if (opts.privateKey) {
      const account = privateKeyToAccount(opts.privateKey);
      this.accountFor = () => account;
    } else {
      throw new Error("LocalWalletProvider needs DEV_AGENT_MNEMONIC or DEV_AGENT_PRIVATE_KEY");
    }
  }

  async addressFor(agent: { id: string }): Promise<`0x${string}`> {
    return this.accountFor(agent.id).address;
  }

  async signerFor(agent: { id: string }): Promise<OrderSigner> {
    return accountSigner(this.accountFor(agent.id));
  }
}

/**
 * Production wallets: Privy server wallets, one per agent, with policy rules that allow only
 * eth_signTypedData_v4 for the Flash order domain, approvals to Permit2 and AgentTreasury, and transfers
 * to the owner (PRD 7.4). Not implemented yet. Requires PRIVY_APP_ID and PRIVY_APP_SECRET.
 */
export class PrivyWalletProvider implements WalletProvider {
  async addressFor(): Promise<`0x${string}`> {
    throw new Error("Privy wallets are not configured");
  }

  async signerFor(): Promise<OrderSigner> {
    throw new Error("Privy wallets are not configured");
  }
}
