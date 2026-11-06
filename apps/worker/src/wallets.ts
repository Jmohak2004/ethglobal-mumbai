// Agent trading wallets. Dev only: LocalWalletProvider derives keys from a mnemonic or a single key.
// Production uses Privy server wallets with policies (PRD 7.4), which is only a stub here.

import { createHash } from "node:crypto";
import type { OrderSigner } from "@arena/flash";
import { mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { concatHex, keccak256, toHex, type Hex } from "viem";

export interface WalletProvider {
  /** Signer for Flash EIP-712 orders. Only called for live orders. */
  signerFor(agent: { id: string }): Promise<OrderSigner>;
  /** The trading address that funds this agent's orders. */
  addressFor(agent: { id: string }): Promise<`0x${string}`>;
  /** The local key behind the trading wallet. Only providers that hold keys implement it (dev). */
  localAccountFor?(agent: { id: string }): LocalAccount;
  /** The agent's 0G wallet. Derived in a namespace separate from the trading wallets. Absent when unsupported. */
  zgAddressFor?(agent: { id: string }): Promise<`0x${string}`>;
}

/** BIP-44 account branch for 0G wallets. Trading wallets use branch 0 (viem's default), so the two never collide. */
export const ZG_WALLET_ACCOUNT_INDEX = 1;

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
  private readonly zgAccountFor: (agentId: string) => LocalAccount;

  constructor(opts: { mnemonic?: string; privateKey?: Hex }) {
    if (opts.mnemonic) {
      const mnemonic = opts.mnemonic.trim();
      // Throws on an invalid mnemonic, which is what we want at startup.
      mnemonicToAccount(mnemonic, { addressIndex: 0 });
      this.accountFor = (agentId) => mnemonicToAccount(mnemonic, { addressIndex: accountIndexFor(agentId) });
      this.zgAccountFor = (agentId) =>
        mnemonicToAccount(mnemonic, {
          path: `m/44'/60'/${ZG_WALLET_ACCOUNT_INDEX}'/0/${accountIndexFor(agentId)}`,
        });
    } else if (opts.privateKey) {
      const account = privateKeyToAccount(opts.privateKey);
      this.accountFor = () => account;
      // One shared key cannot give separate 0G wallets, so each agent's 0G key is hashed from it.
      // Dev only: anyone holding the dev key can derive these keys.
      const key = opts.privateKey;
      this.zgAccountFor = (agentId) =>
        privateKeyToAccount(keccak256(concatHex([key, toHex(`arena-zg-wallet:${agentId}`)])));
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

  localAccountFor(agent: { id: string }): LocalAccount {
    return this.accountFor(agent.id);
  }

  async zgAddressFor(agent: { id: string }): Promise<`0x${string}`> {
    return this.zgAccountFor(agent.id).address;
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
