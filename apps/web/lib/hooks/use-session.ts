"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { getJson, postJson } from "@/lib/api";
import { buildSignInMessage } from "@/lib/auth-message";
import { useToast } from "@/components/ui/toast";
import type { SessionInfo } from "@/lib/types";

const SESSION_KEY = ["session"] as const;

export interface SessionState {
  /** Connected wallet (lowercase), or null. */
  address: `0x${string}` | null;
  /** Server session address (lowercase), or null. Independent of the wallet connection. */
  signedAddress: `0x${string}` | null;
  /** True when the server session matches the connected wallet. */
  signedIn: boolean;
  /** The first /api/auth/me check has finished. */
  ready: boolean;
  /** Prompts the connected wallet to sign the sign-in message, then sets the session cookie. Throws on failure. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Wallet session. Signing the sign-in message once gives an httpOnly cookie for 24 h. With `prompt`, the
 * wallet is asked to sign once per connected address (not on every render; a rejected prompt is not repeated).
 */
export function useSession(opts: { prompt?: boolean } = {}): SessionState {
  const { address: rawAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: SESSION_KEY, queryFn: () => getJson<SessionInfo>("/api/auth/me") });

  const address = isConnected && rawAddress ? (rawAddress.toLowerCase() as `0x${string}`) : null;
  const signedAddress = me.data?.address ?? null;
  const signedIn = address !== null && signedAddress === address;

  const signIn = useCallback(async () => {
    if (!rawAddress) throw new Error("Connect a wallet first");
    const { nonce } = await getJson<{ nonce: string }>("/api/auth/nonce");
    const message = buildSignInMessage({
      domain: window.location.host,
      address: rawAddress,
      nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await signMessageAsync({ message });
    await postJson("/api/auth/verify", { address: rawAddress, message, signature });
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
  }, [rawAddress, qc, signMessageAsync]);

  const signOut = useCallback(async () => {
    await postJson("/api/auth/logout", {});
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
  }, [qc]);

  const attempted = useRef<string | null>(null);
  const prompt = opts.prompt === true;
  useEffect(() => {
    if (!prompt || !address || !me.isSuccess || signedIn) return;
    if (attempted.current === address) return;
    attempted.current = address;
    signIn().catch(() => toast({ title: "Sign-in cancelled", description: "Use Sign in when you are ready.", tone: "default" }));
  }, [prompt, address, me.isSuccess, signedIn, signIn, toast]);

  return { address, signedAddress, signedIn, ready: me.isSuccess, signIn, signOut };
}
