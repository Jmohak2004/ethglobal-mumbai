// Viem adapters for the provisioner: AgentRegistry reads and writes, and the USDC allowance. Every write waits
// for its receipt and throws when the transaction reverted, so a returned hash always means success.

import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { AGENT_REGISTRY_ABI } from "./abi.ts";
import type { ChainConfig } from "./chain.ts";
import type { AllowanceWriter, OnchainAgentRecord, RegistryWriter } from "./provisioner.ts";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function createViemRegistryWriter(opts: {
  chain: ChainConfig;
  registry: Hex;
  platformKey: Hex;
  operatorKey: Hex;
}): RegistryWriter {
  const { viemChain, rpcUrl } = opts.chain;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const platform = createWalletClient({ account: privateKeyToAccount(opts.platformKey), chain: viemChain, transport: http(rpcUrl) });
  const operatorAccount = privateKeyToAccount(opts.operatorKey);
  const operator = createWalletClient({ account: operatorAccount, chain: viemChain, transport: http(rpcUrl) });

  const writeAndWait = async (
    client: typeof platform,
    functionName: "register" | "updateConfig",
    args: readonly unknown[],
  ): Promise<Hex> => {
    const hash = await client.writeContract({ address: opts.registry, abi: AGENT_REGISTRY_ABI, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
    return hash;
  };

  return {
    operator: operatorAccount.address,

    async exists(agentIdBytes32) {
      return (await publicClient.readContract({
        address: opts.registry,
        abi: AGENT_REGISTRY_ABI,
        functionName: "exists",
        args: [agentIdBytes32],
      })) as boolean;
    },

    async configHashOf(agentIdBytes32) {
      const agent = (await publicClient.readContract({
        address: opts.registry,
        abi: AGENT_REGISTRY_ABI,
        functionName: "getAgent",
        args: [agentIdBytes32],
      })) as { owner: Hex; configHash: Hex };
      return agent.owner.toLowerCase() === ZERO_ADDRESS ? null : agent.configHash;
    },

    async register(agentIdBytes32, record: OnchainAgentRecord) {
      return writeAndWait(platform, "register", [agentIdBytes32, record]);
    },

    async updateConfig(agentIdBytes32, configHash) {
      return writeAndWait(operator, "updateConfig", [agentIdBytes32, configHash]);
    },
  };
}

export function createViemAllowanceWriter(opts: { chain: ChainConfig; usdc: Hex }): AllowanceWriter {
  const { viemChain, rpcUrl } = opts.chain;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

  return {
    async ethBalance(address) {
      return publicClient.getBalance({ address });
    },

    async allowance(owner, spender) {
      return (await publicClient.readContract({
        address: opts.usdc,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender],
      })) as bigint;
    },

    async approve(account: LocalAccount, spender, amountUsd6) {
      const wallet = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
      const hash = await wallet.writeContract({
        address: opts.usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, amountUsd6],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`USDC approve reverted (tx ${hash})`);
      return hash;
    },
  };
}
