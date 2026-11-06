// Owner and buyer wallet actions: fork, fund, withdraw. Client-only (wagmi actions with the app config).
// Every write waits for its receipt and refuses to report success on a reverted transaction.
import { keccak256, toBytes } from "viem";
import type { Config } from "wagmi";
import { readContract, switchChain, waitForTransactionReceipt, writeContract, getChainId } from "wagmi/actions";

import { ERC20_ABI, MARKETPLACE_ABI, TREASURY_ABI } from "@/lib/abi";
import { CHAIN, CONTRACTS, USDC_DECIMALS } from "@/lib/contracts";

export class NotDeployedError extends Error {
  constructor(what: string) {
    super(`${what} is not deployed on this network`);
    this.name = "NotDeployedError";
  }
}

/** Agent ids are UUIDs offchain and bytes32 onchain: keccak256(utf8(id)). Same as @arena/shared agentIdToBytes32. */
export const agentBytes32 = (agentId: string): `0x${string}` => keccak256(toBytes(agentId));

/** USD to USDC base units (6 decimals). */
export const usdcUnits = (usd: number): bigint => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));

export const fromUsdcUnits = (units: bigint): number => Number(units) / 10 ** USDC_DECIMALS;

async function ensureChain(config: Config): Promise<void> {
  if (getChainId(config) !== CHAIN.id) await switchChain(config, { chainId: CHAIN.id });
}

async function writeAndWait(
  config: Config,
  hash: `0x${string}`,
): Promise<`0x${string}`> {
  const receipt = await waitForTransactionReceipt(config, { hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted onchain");
  return hash;
}

async function approveUsdc(config: Config, spender: `0x${string}`, amount: bigint): Promise<void> {
  const hash = await writeContract(config, {
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    chainId: CHAIN.id,
  });
  await writeAndWait(config, hash);
}

/**
 * Fork: approve USDC for the marketplace (exact price, only if the allowance is short), then
 * StrategyMarketplace.fork. Returns the fork tx hash once it is mined and successful.
 */
export async function forkOnchain(config: Config, account: `0x${string}`, agentId: string, priceUsd: number): Promise<`0x${string}`> {
  const marketplace = CONTRACTS.marketplace;
  if (!marketplace) throw new NotDeployedError("StrategyMarketplace");
  await ensureChain(config);
  const price = usdcUnits(priceUsd);
  if (price > 0n) {
    const allowance = await readContract(config, {
      address: CONTRACTS.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account, marketplace],
      chainId: CHAIN.id,
    });
    if (allowance < price) await approveUsdc(config, marketplace, price);
  }
  const hash = await writeContract(config, {
    address: marketplace,
    abi: MARKETPLACE_ABI,
    functionName: "fork",
    args: [agentBytes32(agentId)],
    chainId: CHAIN.id,
  });
  return writeAndWait(config, hash);
}

/** Fund: USDC transfer from the connected wallet to the agent's trading wallet. */
export async function fundOnchain(config: Config, tradingWallet: `0x${string}`, amountUsd: number): Promise<`0x${string}`> {
  await ensureChain(config);
  const hash = await writeContract(config, {
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [tradingWallet, usdcUnits(amountUsd)],
    chainId: CHAIN.id,
  });
  return writeAndWait(config, hash);
}

/** Withdrawable USD for an agent, read from AgentTreasury (bounded by reserve). */
export async function readWithdrawable(config: Config, agentId: string): Promise<number> {
  const treasury = CONTRACTS.treasury;
  if (!treasury) throw new NotDeployedError("AgentTreasury");
  const units = await readContract(config, {
    address: treasury,
    abi: TREASURY_ABI,
    functionName: "withdrawable",
    args: [agentBytes32(agentId)],
    chainId: CHAIN.id,
  });
  return fromUsdcUnits(units);
}

/** Withdraw: AgentTreasury.withdraw(agentId, amount). The contract checks owner and the withdrawable bound. */
export async function withdrawOnchain(config: Config, agentId: string, amountUsd: number): Promise<`0x${string}`> {
  const treasury = CONTRACTS.treasury;
  if (!treasury) throw new NotDeployedError("AgentTreasury");
  await ensureChain(config);
  const hash = await writeContract(config, {
    address: treasury,
    abi: TREASURY_ABI,
    functionName: "withdraw",
    args: [agentBytes32(agentId), usdcUnits(amountUsd)],
    chainId: CHAIN.id,
  });
  return writeAndWait(config, hash);
}
