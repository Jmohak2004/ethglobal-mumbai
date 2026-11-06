// Converts Flash EIP-712 payloads (strings for integers) into the shape viem and wagmi sign.
// Mirrors normalizeTypedData in @arena/flash (signing.ts), which is not importable from the browser bundle
// because the package index pulls in server-only modules. Client-safe, pure.
import type { TypedDataJson } from "@/lib/types";

export interface SignableTypedData {
  domain: { chainId?: number; name?: string; version?: string; verifyingContract?: `0x${string}`; salt?: `0x${string}` };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const INT = /^u?int\d*$/;

function coerce(type: string, value: unknown, types: SignableTypedData["types"]): unknown {
  if (type.endsWith("]")) {
    const elem = type.slice(0, type.lastIndexOf("["));
    if (!Array.isArray(value)) throw new TypeError(`expected array for ${type}`);
    return value.map((v) => coerce(elem, v, types));
  }
  if (INT.test(type)) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && /^(0x[0-9a-fA-F]+|-?\d+)$/.test(value)) return BigInt(value);
    throw new TypeError(`cannot convert ${JSON.stringify(value)} to ${type}`);
  }
  const struct = types[type];
  if (struct && typeof value === "object" && value !== null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of struct) if (f.name in src) out[f.name] = coerce(f.type, src[f.name], types);
    return out;
  }
  return value;
}

export function toSignable(td: TypedDataJson): SignableTypedData {
  const types: SignableTypedData["types"] = {};
  for (const [name, fields] of Object.entries(td.types)) {
    if (name === "EIP712Domain") continue;
    types[name] = fields.map((f) => ({ name: f.name, type: f.type }));
  }
  if (!types[td.primaryType]) throw new TypeError(`primaryType ${td.primaryType} is missing from types`);
  const domain = { ...td.domain } as SignableTypedData["domain"] & Record<string, unknown>;
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  const message = coerce(td.primaryType, td.message, types) as Record<string, unknown>;
  return { domain, types, primaryType: td.primaryType, message };
}
