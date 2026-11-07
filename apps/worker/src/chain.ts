// Base chain selection (CHAIN env): viem chain, RPC, token registry and feed addresses.

import { BASE_SEPOLIA_TOKENS, BASE_TOKENS, type TokenInfo } from "@arena/shared";
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { WorkerEnv } from "./env.ts";

export interface ChainConfig {
  name: "base" | "baseSepolia";
  viemChain: Chain;
  rpcUrl: string;
  tokens: Record<string, TokenInfo>;
}

export function chainConfigFor(env: Pick<WorkerEnv, "CHAIN" | "BASE_RPC_URL" | "BASE_SEPOLIA_RPC_URL">): ChainConfig {
  if (env.CHAIN === "base") return flashChainFor(env);
  return { name: "baseSepolia", viemChain: baseSepolia, rpcUrl: env.BASE_SEPOLIA_RPC_URL, tokens: BASE_SEPOLIA_TOKENS };
}

/**
 * Base mainnet (chain 8453), where Flash trades and settles. It does not follow CHAIN: in the hybrid deployment the
 * contracts run on Base Sepolia while Flash orders and their approvals go to mainnet.
 */
export function flashChainFor(env: Pick<WorkerEnv, "BASE_RPC_URL">): ChainConfig {
  return { name: "base", viemChain: base, rpcUrl: env.BASE_RPC_URL, tokens: BASE_TOKENS };
}

/** CAIP-2 id of the Base chain, as Privy's RPC and policies name it: eip155:8453 (Base) or eip155:84532 (Base Sepolia). */
export function caip2For(chain: Pick<ChainConfig, "name">): string {
  return chain.name === "base" ? "eip155:8453" : "eip155:84532";
}

export function publicClientFor(config: ChainConfig): PublicClient {
  return createPublicClient({ chain: config.viemChain, transport: http(config.rpcUrl) }) as PublicClient;
}
