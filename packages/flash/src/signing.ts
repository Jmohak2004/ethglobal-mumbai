// Signing helpers for Flash EVM orders. Nothing here sends a transaction: buildApprovalTx returns calldata only.

import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FlashTypedDataSchema, type FlashTypedData, type QuoteResponse } from "./types.ts";

/** Canonical Permit2 contract (listed in the Flash EVM overview; the docs do not qualify it by chain). */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Typed data in the shape viem's signTypedData expects: uint/int values are bigint, chainId is a number. */
export interface SignableTypedData {
  domain: { chainId?: number; name?: string; version?: string; verifyingContract?: Address; salt?: Hex };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Any signer: a local key, a Privy/Turnkey wallet adapter, or a test double. */
export interface OrderSigner {
  address: `0x${string}`;
  signTypedData(typedData: SignableTypedData): Promise<`0x${string}`>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${field}: unsafe integer ${value}; send it as a string`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|-?\d+)$/.test(value)) return BigInt(value);
  throw new TypeError(`${field}: cannot convert ${JSON.stringify(value)} to an integer`);
}

function coerceValue(
  type: string,
  value: unknown,
  types: Record<string, readonly { name: string; type: string }[]>,
  path: string,
): unknown {
  if (type.endsWith("]")) {
    const elem = type.slice(0, type.lastIndexOf("["));
    if (!Array.isArray(value)) throw new TypeError(`${path}: expected array`);
    return value.map((v, i) => coerceValue(elem, v, types, `${path}[${i}]`));
  }
  if (/^u?int\d*$/.test(type)) return toBigInt(value, path);
  const struct = types[type];
  if (struct) {
    if (typeof value !== "object" || value === null) throw new TypeError(`${path}: expected object`);
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const field of struct) {
      if (field.name in src) out[field.name] = coerceValue(field.type, src[field.name], types, `${path}.${field.name}`);
    }
    return out;
  }
  return value;
}

/**
 * Parses Flash typed data (JSON string or object), removes EIP712Domain from `types` (viem derives it from
 * `domain`), converts chainId to a number, and converts integer message fields to bigint.
 */
export function normalizeTypedData(input: string | FlashTypedData | Record<string, unknown>): SignableTypedData {
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const parsed = FlashTypedDataSchema.parse(raw);

  const types: SignableTypedData["types"] = {};
  for (const [name, fields] of Object.entries(parsed.types)) {
    if (name === "EIP712Domain") continue;
    types[name] = fields.map((f) => ({ name: f.name, type: f.type }));
  }
  if (!types[parsed.primaryType]) throw new TypeError(`primaryType ${parsed.primaryType} is not in types`);

  const domain = { ...parsed.domain } as Record<string, unknown>;
  if (domain.chainId !== undefined) {
    domain.chainId = Number(toBigInt(domain.chainId, "domain.chainId"));
  }

  const message = coerceValue(parsed.primaryType, parsed.message, types, "message") as Record<string, unknown>;
  return {
    domain: domain as SignableTypedData["domain"],
    types,
    primaryType: parsed.primaryType,
    message,
  };
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/** Local signer backed by a raw private key (viem privateKeyToAccount). Dev/test use. Key never leaves this closure. */
export function localSigner(privateKey: Hex): OrderSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: (td) =>
      account.signTypedData(td as Parameters<typeof account.signTypedData>[0]),
  };
}

/** Signs Flash typed data (JSON string or object) with the funder's signer. Returns 0x-prefixed hex. */
export async function signFlashOrder(
  orderTypedData: string | FlashTypedData | Record<string, unknown>,
  signer: OrderSigner,
): Promise<`0x${string}`> {
  return signer.signTypedData(normalizeTypedData(orderTypedData));
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalRequirements {
  /** ERC-20 approve the funder must send onchain before the order can execute. Once per token per wallet. */
  approveTx: { to: Address; data: Hex } | null;
  /** Wrap of the native gas asset, when the spent asset is native. Onchain tx. */
  wrapTx: { to: Address; data: Hex; value: string } | null;
  /** Unsigned setup txs (quote.setupTxs), to be signed and submitted via POST /setup-transaction in order. */
  setupTxs: string[];
  /** Attached bracket's approveTx, if the bracket needs its own approval. */
  bracketApproveTx: { to: Address; data: Hex } | null;
  /** Permit2 typed data (JSON string) to sign. Present only when a new permit is needed. */
  permitTypedData: string | null;
  /** Attached bracket Permit2 typed data (JSON string). */
  bracketPermitTypedData: string | null;
  /** Spender the permit is granted to: Permit2 when a permit is needed. */
  permit2Address: Address | null;
  /** True when at least one onchain tx must be sent before the order can execute. */
  requiresOnchainTx: boolean;
  /** True when a Permit2 signature is needed in addition to the order signature. */
  requiresPermitSignature: boolean;
}

/**
 * Describes the onchain and signing steps the quote requires. The docs define three cases:
 * (1) approveTx non-null: ERC-20 approve must be mined first (direct settlement path);
 * (2) permitTypedData non-null: sign it (Permit2 path); it is echoed as evmPermitTypedData with evmPermitSignature;
 * (3) both null, orderTypedData present: only the order signature is needed.
 */
export function approvalRequirements(quote: QuoteResponse): ApprovalRequirements {
  const evm = quote.evm;
  const bracket = quote.attachedBracket?.evm ?? null;
  const approveTx = evm?.approveTx ? { to: evm.approveTx.to as Address, data: evm.approveTx.data as Hex } : null;
  const bracketApproveTx = bracket?.approveTx
    ? { to: bracket.approveTx.to as Address, data: bracket.approveTx.data as Hex }
    : null;
  const wrap = quote.wrap?.evmTx ?? null;
  const wrapTx = wrap ? { to: wrap.to as Address, data: wrap.data as Hex, value: wrap.value } : null;
  const setupTxs = quote.setupTxs ?? [];
  const permitTypedData = evm?.permitTypedData ?? null;
  const bracketPermitTypedData = bracket?.permitTypedData ?? null;
  const requiresPermitSignature = Boolean(permitTypedData || bracketPermitTypedData);

  return {
    approveTx,
    wrapTx,
    setupTxs,
    bracketApproveTx,
    permitTypedData,
    bracketPermitTypedData,
    permit2Address: requiresPermitSignature ? PERMIT2_ADDRESS : null,
    requiresOnchainTx: Boolean(approveTx || wrapTx || setupTxs.length || bracketApproveTx),
    requiresPermitSignature,
  };
}

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/**
 * Calldata for ERC-20 approve(spender, amount). Does not send anything. The caller decides the amount:
 * the docs' direct path approves an unlimited amount, the Permit2 path needs at least the order amount.
 */
export function buildApprovalTx(token: Address, spender: Address, amount: bigint): { to: Address; data: Hex } {
  if (amount < 0n) throw new RangeError("approval amount must be >= 0");
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
  };
}
