// Onchain reads and receipt checks for the fork / treasury flows. Server-only.
import { createPublicClient, http, parseEventLogs } from "viem";
import { baseSepolia } from "viem/chains";

import { CHAIN, CONTRACTS } from "@/lib/contracts";
import { MARKETPLACE_ABI, TREASURY_ABI } from "@/lib/abi";
import { env } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";
import { fromUsd6 } from "@arena/shared";

function makeClient() {
  const e = env();
  return createPublicClient({
    chain: CHAIN,
    transport: http(CHAIN.id === baseSepolia.id ? e.BASE_SEPOLIA_RPC_URL : e.BASE_RPC_URL),
  });
}

let client: ReturnType<typeof makeClient> | undefined;

export function publicClient() {
  client ??= makeClient();
  return client;
}

/**
 * Checks that txHash is a successful StrategyMarketplace.fork by `buyer` for `agentIdBytes32`, and
 * returns the configHash and price the contract emitted.
 */
export async function verifyForkTx(input: {
  txHash: `0x${string}`;
  agentIdBytes32: `0x${string}`;
  buyer: `0x${string}`;
}): Promise<{ configHash: `0x${string}`; priceUsd6: bigint }> {
  const marketplace = CONTRACTS.marketplace;
  if (!marketplace) throw new ApiError(503, "NOT_DEPLOYED", "StrategyMarketplace is not deployed");

  let receipt;
  try {
    receipt = await publicClient().getTransactionReceipt({ hash: input.txHash });
  } catch {
    throw new ApiError(409, "CONFLICT", "Transaction is not mined yet. Retry in a few seconds.");
  }
  if (receipt.status !== "success") throw new ApiError(422, "VALIDATION", "Fork transaction reverted");

  const events = parseEventLogs({ abi: MARKETPLACE_ABI, eventName: "Forked", logs: receipt.logs });
  const match = events.find(
    (ev) =>
      ev.address.toLowerCase() === marketplace.toLowerCase() &&
      ev.args.agentId.toLowerCase() === input.agentIdBytes32.toLowerCase() &&
      ev.args.buyer.toLowerCase() === input.buyer.toLowerCase(),
  );
  if (!match) throw new ApiError(422, "VALIDATION", "Transaction has no Forked event for this agent and buyer");
  return { configHash: match.args.configHash, priceUsd6: match.args.priceUsd6 };
}

/** On-chain treasury balances for an agent, or null when the treasury is not deployed or the read fails. */
export async function readTreasuryAccount(
  agentIdBytes32: `0x${string}`,
): Promise<{ balanceUsd: number; withdrawableUsd: number } | null> {
  const treasury = CONTRACTS.treasury;
  if (!treasury) return null;
  try {
    const [account, withdrawable] = await Promise.all([
      publicClient().readContract({ address: treasury, abi: TREASURY_ABI, functionName: "getAccount", args: [agentIdBytes32] }),
      publicClient().readContract({ address: treasury, abi: TREASURY_ABI, functionName: "withdrawable", args: [agentIdBytes32] }),
    ]);
    return { balanceUsd: fromUsd6(account.balance), withdrawableUsd: fromUsd6(withdrawable) };
  } catch (err) {
    console.warn("[arena] treasury read failed:", (err as Error).message);
    return null;
  }
}
