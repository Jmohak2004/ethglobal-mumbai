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
  if (env.CHAIN === "base") {
    return { name: "base", viemChain: base, rpcUrl: env.BASE_RPC_URL, tokens: BASE_TOKENS };
  }
  return { name: "baseSepolia", viemChain: baseSepolia, rpcUrl: env.BASE_SEPOLIA_RPC_URL, tokens: BASE_SEPOLIA_TOKENS };
}

export function publicClientFor(config: ChainConfig): PublicClient {
  return createPublicClient({ chain: config.viemChain, transport: http(config.rpcUrl) }) as PublicClient;
}
