// Agent wallets. The trading wallet signs Flash EIP-712 orders (OrderSigner), signs Flash cancel and update
// messages (MessageSigner, EIP-191), and sends approvals (TradingSender). LocalWalletProvider derives keys from a
// mnemonic or one key (dev only). PrivyWalletProvider (privy-wallets.ts) uses Privy server wallets (PRD 7.4).

import { createHash } from "node:crypto";
import type { MessageSigner, OrderSigner } from "@arena/flash";
import { mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { concatHex, keccak256, toHex, type Hex } from "viem";

/** A transaction the trading wallet sends. value defaults to 0. */
export interface TxRequest {
  to: Hex;
  data: Hex;
  value?: bigint;
}

/** The trading wallet as a transaction sender. sendTransaction resolves to the hash once the node accepted the tx. */
export interface TradingSender {
  readonly address: Hex;
  sendTransaction(tx: TxRequest): Promise<Hex>;
}

export interface WalletProvider {
  /** Signer for Flash EIP-712 orders. Only called for live orders. */
  signerFor(agent: { id: string }): Promise<OrderSigner>;
  /** EIP-191 signer for Flash cancel and update messages. Its address is the funder, the trading wallet. */
  messageSignerFor(agent: { id: string }): Promise<MessageSigner>;
  /** The trading address that funds this agent's orders. */
  addressFor(agent: { id: string }): Promise<`0x${string}`>;
  /** Sends transactions from the trading wallet (USDC approve). Absent when the provider cannot send. */
  tradingSenderFor?(agent: { id: string }): Promise<TradingSender>;
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

/** Wraps a viem local account as an EIP-191 message signer (personal_sign over the UTF-8 bytes). */
export function accountMessageSigner(account: LocalAccount): MessageSigner {
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
  };
}

export class LocalWalletProvider implements WalletProvider {
  private readonly accountFor: (agentId: string) => LocalAccount;
  private readonly zgAccountFor: (agentId: string) => LocalAccount;
  private readonly send: ((account: LocalAccount, tx: TxRequest) => Promise<Hex>) | undefined;

  /**
   * `sendTransaction` is the chain-aware send (the runtime passes a viem wallet client). Without it, approvals
   * from local wallets fail with a clear error, and everything else still works.
   */
  constructor(opts: {
    mnemonic?: string;
    privateKey?: Hex;
    sendTransaction?: (account: LocalAccount, tx: TxRequest) => Promise<Hex>;
  }) {
    this.send = opts.sendTransaction;
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

  async messageSignerFor(agent: { id: string }): Promise<MessageSigner> {
    return accountMessageSigner(this.accountFor(agent.id));
  }

  async tradingSenderFor(agent: { id: string }): Promise<TradingSender> {
    const account = this.accountFor(agent.id);
    const send = this.send;
    return {
      address: account.address,
      sendTransaction: async (tx) => {
        if (!send) throw new Error("local transactions need a chain: no sendTransaction is configured");
        return send(account, tx);
      },
    };
  }

  localAccountFor(agent: { id: string }): LocalAccount {
    return this.accountFor(agent.id);
  }

  async zgAddressFor(agent: { id: string }): Promise<`0x${string}`> {
    return this.zgAccountFor(agent.id).address;
  }
}

/**
 * Stands in when WALLET_PROVIDER=local and no dev key is set. Startup still succeeds, and each wallet call fails
 * with the same reason, the way missing keys fail elsewhere in the worker.
 */
export class UnconfiguredWalletProvider implements WalletProvider {
  constructor(private readonly reason: string) {}

  async signerFor(_agent: { id: string }): Promise<OrderSigner> {
    throw new Error(this.reason);
  }

  async messageSignerFor(_agent: { id: string }): Promise<MessageSigner> {
    throw new Error(this.reason);
  }

  async addressFor(_agent: { id: string }): Promise<`0x${string}`> {
    throw new Error(this.reason);
  }
}
