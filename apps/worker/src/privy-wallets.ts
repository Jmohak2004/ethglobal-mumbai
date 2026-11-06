// Privy server wallets (PRD 7.4). One Ethereum wallet per agent. It is created once, its Privy id is stored in the
// agent's provisioning jsonb, and later calls look it up by that id. Signing goes through Privy's RPC endpoint:
//   eth_signTypedData_v4  Flash orders (OrderSigner)
//   personal_sign         Flash cancel and update messages (MessageSigner)
//   eth_sendTransaction   USDC approve (TradingSender)
// Policies (allowed typed data, approvals, transfers) are configured in the Privy dashboard, see docs/SETUP.md.
// This module only passes PRIVY_POLICY_ID when it creates a wallet.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { getProvisioning, updateProvisioning, type Db, type ProvisioningState } from "@arena/db";
import type { MessageSigner, OrderSigner, SignableTypedData } from "@arena/flash";
import { getAddress, toHex, type Hex } from "viem";
import type { TradingSender, TxRequest, WalletProvider } from "./wallets.ts";

export interface PrivyWalletRecord {
  id: string;
  address: string;
}

/** Optional per-call authorization. Present only when PRIVY_AUTHORIZATION_KEY is set. */
export interface PrivyAuthorization {
  authorization_context?: { authorization_private_keys: string[] };
}

export interface PrivyTypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primary_type: string;
  message: Record<string, unknown>;
}

/**
 * The part of the @privy-io/node client this provider calls (PrivyClient.wallets()). The real client satisfies it.
 * Typed narrowly so the tests can fake it without the network.
 */
export interface PrivyServerClient {
  wallets(): {
    create(input: {
      chain_type: "ethereum";
      display_name?: string;
      owner?: { public_key: string };
      policy_ids?: string[];
      idempotency_key?: string;
    }): Promise<PrivyWalletRecord>;
    get(walletId: string): Promise<PrivyWalletRecord>;
    ethereum(): {
      signMessage(walletId: string, input: PrivyAuthorization & { message: Uint8Array }): Promise<{ signature: string }>;
      signTypedData(
        walletId: string,
        input: PrivyAuthorization & { caip2?: string; params: { typed_data: PrivyTypedData } },
      ): Promise<{ signature: string }>;
      sendTransaction(
        walletId: string,
        input: PrivyAuthorization & {
          caip2: string;
          params: { transaction: { to: string; data: string; value?: string } };
        },
      ): Promise<{ hash: string }>;
    };
  };
}

/** Where the Privy wallet id is kept. Production stores it in the agent's provisioning jsonb (privyStoreFromDb). */
export interface PrivyWalletStore {
  walletIdFor(agentId: string): Promise<string | null>;
  saveWalletId(agentId: string, walletId: string): Promise<void>;
}

export interface PrivyWalletProviderOptions {
  client: PrivyServerClient;
  store: PrivyWalletStore;
  /** CAIP-2 chain for signing and sending, e.g. eip155:84532 (Base Sepolia) or eip155:8453 (Base). */
  caip2: string;
  /** Privy policy id attached to each new wallet (PRIVY_POLICY_ID). */
  policyId?: string;
  /** Base64 PKCS8 P-256 private key (PRIVY_AUTHORIZATION_KEY). Owns new wallets and signs every wallet call. */
  authorizationKey?: string;
}

/** Privy's JSON key for the stored wallet id. It sits in the provisioning jsonb next to the other step fields. */
const PRIVY_WALLET_FIELD = "privyWalletId";

/** Privy stores the wallet id in the agent's provisioning jsonb. The db type does not name the field, so this reads and writes it by key. */
export function privyStoreFromDb(db: Db): PrivyWalletStore {
  return {
    async walletIdFor(agentId) {
      const state = await getProvisioning(db, agentId);
      const value = (state as Record<string, unknown> | null)?.[PRIVY_WALLET_FIELD];
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    async saveWalletId(agentId, walletId) {
      const patch: Record<string, string> = { [PRIVY_WALLET_FIELD]: walletId };
      await updateProvisioning(db, agentId, patch as ProvisioningState);
    },
  };
}

/** The P-256 public key Privy expects as a wallet owner (base64 SPKI DER), derived from the authorization private key. */
export function authorizationPublicKey(privateKeyPkcs8Base64: string): string {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyPkcs8Base64, "base64"), format: "der", type: "pkcs8" });
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

/** EIP-712 domain fields in the order viem and wallets expect. Only the fields the domain actually has. */
const DOMAIN_FIELDS: Array<{ name: string; type: string }> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

/** JSON form of a value: bigints become decimal strings, recursively. Other values pass through. */
function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v)]));
  }
  return value;
}

/**
 * Converts Flash typed data to Privy's eth_signTypedData_v4 body. Integers are sent as decimal strings (the EIP-712
 * JSON form) and EIP712Domain is listed in types, as the standard JSON form expects.
 */
export function toPrivyTypedData(td: SignableTypedData): PrivyTypedData {
  const domain = jsonValue(td.domain) as Record<string, unknown>;
  const domainTypes = DOMAIN_FIELDS.filter((f) => (td.domain as Record<string, unknown>)[f.name] !== undefined);
  return {
    domain,
    types: { EIP712Domain: domainTypes, ...td.types },
    primary_type: td.primaryType,
    message: jsonValue(td.message) as Record<string, unknown>,
  };
}

/** Privy returns a 65-byte signature as hex. Anything else is an error, not a value to forward. */
function signatureHex(signature: string): Hex {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new Error("Privy returned a signature that is not 65 bytes of hex");
  return hex as Hex;
}

export class PrivyWalletProvider implements WalletProvider {
  private readonly known = new Map<string, PrivyWalletRecord>();
  private readonly pending = new Map<string, Promise<PrivyWalletRecord>>();
  private readonly authorization: PrivyAuthorization;
  private readonly ownerKey: string | undefined;

  constructor(private readonly opts: PrivyWalletProviderOptions) {
    this.authorization = opts.authorizationKey
      ? { authorization_context: { authorization_private_keys: [opts.authorizationKey] } }
      : {};
    this.ownerKey = opts.authorizationKey ? authorizationPublicKey(opts.authorizationKey) : undefined;
  }

  async addressFor(agent: { id: string }): Promise<`0x${string}`> {
    const wallet = await this.walletFor(agent.id);
    return getAddress(wallet.address);
  }

  async signerFor(agent: { id: string }): Promise<OrderSigner> {
    const wallet = await this.walletFor(agent.id);
    return {
      address: getAddress(wallet.address),
      signTypedData: async (td) => {
        const res = await this.opts.client
          .wallets()
          .ethereum()
          .signTypedData(wallet.id, {
            ...this.authorization,
            caip2: this.opts.caip2,
            params: { typed_data: toPrivyTypedData(td) },
          });
        return signatureHex(res.signature);
      },
    };
  }

  async messageSignerFor(agent: { id: string }): Promise<MessageSigner> {
    const wallet = await this.walletFor(agent.id);
    return {
      address: getAddress(wallet.address),
      signMessage: async (message) => {
        // Raw UTF-8 bytes, so a message that happens to start with 0x is still signed as text.
        const res = await this.opts.client
          .wallets()
          .ethereum()
          .signMessage(wallet.id, { ...this.authorization, message: new TextEncoder().encode(message) });
        return signatureHex(res.signature);
      },
    };
  }

  async tradingSenderFor(agent: { id: string }): Promise<TradingSender> {
    const wallet = await this.walletFor(agent.id);
    return {
      address: getAddress(wallet.address),
      sendTransaction: async (tx: TxRequest) => {
        const transaction: { to: string; data: string; value?: string } = { to: tx.to, data: tx.data };
        if (tx.value !== undefined && tx.value > 0n) transaction.value = toHex(tx.value);
        const res = await this.opts.client
          .wallets()
          .ethereum()
          .sendTransaction(wallet.id, { ...this.authorization, caip2: this.opts.caip2, params: { transaction } });
        return res.hash as Hex;
      },
    };
  }

  /**
   * The agent's Privy wallet: cached after the first call, else looked up by its stored id, else created once.
   * Concurrent first calls share one lookup or creation.
   */
  private walletFor(agentId: string): Promise<PrivyWalletRecord> {
    const known = this.known.get(agentId);
    if (known) return Promise.resolve(known);
    const inFlight = this.pending.get(agentId);
    if (inFlight) return inFlight;
    const task = this.resolveWallet(agentId).finally(() => this.pending.delete(agentId));
    this.pending.set(agentId, task);
    return task;
  }

  private async resolveWallet(agentId: string): Promise<PrivyWalletRecord> {
    const wallets = this.opts.client.wallets();
    const storedId = await this.opts.store.walletIdFor(agentId);
    let wallet: PrivyWalletRecord;
    if (storedId) {
      wallet = await wallets.get(storedId);
    } else {
      wallet = await wallets.create({
        chain_type: "ethereum",
        display_name: `arena agent ${agentId}`,
        // The idempotency key makes a retry after a lost response return the same wallet, not a second one.
        idempotency_key: `arena-trading-wallet:${agentId}`,
        ...(this.ownerKey ? { owner: { public_key: this.ownerKey } } : {}),
        ...(this.opts.policyId ? { policy_ids: [this.opts.policyId] } : {}),
      });
      await this.opts.store.saveWalletId(agentId, wallet.id);
    }
    this.known.set(agentId, wallet);
    return wallet;
  }
}
