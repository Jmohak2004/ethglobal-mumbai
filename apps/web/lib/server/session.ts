// Wallet sign-in sessions. Server-only.
// Flow: GET nonce -> wallet signs buildSignInMessage(...) -> POST verify sets an httpOnly cookie:
// base64url(JSON{a,e}) "." HMAC-SHA256(SESSION_SECRET). 24 h expiry. Nonces are single-use, 5 min.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { isAddress, verifyMessage } from "viem";

import { parseSignInMessage } from "@/lib/auth-message";
import { ApiError } from "@/lib/server/errors";
import { isProduction, sessionSecret } from "@/lib/server/env";
import { DEMO_OWNER } from "@/lib/templates";

export const SESSION_COOKIE = "arena_session";
const SESSION_TTL_MS = 24 * 3600_000;
const NONCE_TTL_MS = 5 * 60_000;
const MESSAGE_SKEW_MS = 5 * 60_000;

type NonceStore = Map<string, number>;
const g = globalThis as typeof globalThis & { __arenaNonces?: NonceStore };
const nonceStore = (): NonceStore => (g.__arenaNonces ??= new Map());

export interface Session {
  /** Lowercase 0x address. */
  address: `0x${string}`;
  expiresAt: number;
}

export function issueNonce(): { nonce: string; expiresAt: number } {
  const now = Date.now();
  const store = nonceStore();
  for (const [k, exp] of store) if (exp <= now) store.delete(k);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = now + NONCE_TTL_MS;
  store.set(nonce, expiresAt);
  return { nonce, expiresAt };
}

function consumeNonce(nonce: string): boolean {
  const store = nonceStore();
  const exp = store.get(nonce);
  store.delete(nonce);
  return exp !== undefined && exp > Date.now();
}

function requireSecret(): string {
  const secret = sessionSecret();
  if (!secret) throw new ApiError(503, "UNAVAILABLE", "Wallet sign-in is not configured (SESSION_SECRET is missing or short)");
  return secret;
}

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(address: string, now = Date.now()): { token: string; expiresAt: number } {
  const secret = requireSecret();
  const expiresAt = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ a: address.toLowerCase(), e: expiresAt })).toString("base64url");
  return { token: `${payload}.${mac(payload, secret)}`, expiresAt };
}

export function readSessionToken(token: string | undefined, now = Date.now()): Session | null {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(token.slice(dot + 1));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: { a?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { a?: unknown; e?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.a !== "string" || typeof parsed.e !== "number" || parsed.e <= now || !isAddress(parsed.a)) return null;
  return { address: parsed.a.toLowerCase() as `0x${string}`, expiresAt: parsed.e };
}

function cookieValue(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

/** The session on this request, or null. Never throws. */
export function getSession(req: Request): Session | null {
  return readSessionToken(cookieValue(req));
}

/** The session on this request, or a typed 401. */
export function requireSession(req: Request): Session {
  const s = getSession(req);
  if (!s) throw new ApiError(401, "UNAUTHENTICATED", "Sign in with your wallet first");
  return s;
}

/**
 * Owner gate for owner-only reads and writes. Passes when the session address is the owner. The demo
 * override (`demo` flag, ?owner=1 in the UI) is honoured only outside production and only for the demo owner.
 */
export function assertOwnerAccess(req: Request, ownerAddress: string, opts: { demo?: boolean } = {}): { demo: boolean } {
  if (opts.demo && !isProduction() && ownerAddress.toLowerCase() === DEMO_OWNER.toLowerCase()) return { demo: true };
  const s = requireSession(req);
  if (s.address !== ownerAddress.toLowerCase()) {
    throw new ApiError(403, "FORBIDDEN", "Only the agent owner can view this");
  }
  return { demo: false };
}

export async function setSessionCookie(address: string): Promise<number> {
  const { token, expiresAt } = createSessionToken(address);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return expiresAt;
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isProduction(), path: "/", maxAge: 0 });
}

/** Host the wallet must have signed for (proxy-aware). */
export function requestHost(req: Request): string {
  const raw = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return raw.split(",")[0]?.trim() ?? "";
}

/** Checks the signed message against the nonce, domain, time window and signature. Consumes the nonce. */
export async function verifySignIn(input: { address: string; message: string; signature: string }, host: string): Promise<void> {
  requireSecret();
  const fields = parseSignInMessage(input.message);
  if (!fields) throw new ApiError(400, "VALIDATION", "message is not an ARENA sign-in message");
  if (fields.address.toLowerCase() !== input.address.toLowerCase()) {
    throw new ApiError(400, "VALIDATION", "address does not match the signed message");
  }
  if (fields.domain !== host) throw new ApiError(401, "UNAUTHENTICATED", "message was signed for a different site");
  const issued = Date.parse(fields.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MESSAGE_SKEW_MS) {
    throw new ApiError(401, "UNAUTHENTICATED", "sign-in message expired, try again");
  }
  if (!consumeNonce(fields.nonce)) throw new ApiError(401, "UNAUTHENTICATED", "nonce unknown or already used, try again");
  const ok = await verifyMessage({
    address: input.address as `0x${string}`,
    message: input.message,
    signature: input.signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) throw new ApiError(401, "UNAUTHENTICATED", "signature does not match the address");
}
