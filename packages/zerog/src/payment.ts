import { ZG_PAYMENT_LAYER } from "@arena/shared";
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi } from "ethers";

/**
 * Payment Layer deposit ABI.
 *
 * Source: verified implementation (PaymentVault, v0.8.24) behind the mainnet proxy
 * 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32, read via chainscan.0g.ai.
 * `depositFor(address user)` credits msg.value (native 0G) to `user`'s balance.
 *
 * TODO(testnet): the Galileo proxy 0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939 points at an
 * UNVERIFIED implementation. The same ABI is assumed. Confirm with a zero-value dry run
 * (eth_call) or against the verified source before depositing real testnet funds.
 */
export const PAYMENT_LAYER_DEPOSIT_ABI = ["function depositFor(address user) payable"] as const;
export const DEFAULT_DEPOSIT_FUNCTION = "depositFor";

export interface DepositOptions {
  rpcUrl: string;
  /** Depositing wallet (the agent's own 0G wallet). Never log this. */
  privateKey: string;
  network: "mainnet" | "testnet";
  /** Amount in neuron (wei-equivalent for 0G, 1e18 neuron = 1 0G). */
  amountWei: bigint;
  /** Account to credit. Defaults to the signer's address. */
  recipient?: string;
  /** Override the default Payment Layer address for `network`. */
  contractAddress?: string;
  /** Override the ABI if the deposit function differs (see TODO above). */
  abi?: InterfaceAbi;
  /** Override the deposit function name. Must accept `(address user)` and be payable. */
  functionName?: string;
}

export interface DepositResult {
  txHash: string;
  blockNumber: number | null;
  recipient: string;
}

export async function depositToPaymentLayer(opts: DepositOptions): Promise<DepositResult> {
  if (opts.amountWei <= 0n) throw new RangeError("depositToPaymentLayer: amountWei must be > 0");

  const provider = new JsonRpcProvider(opts.rpcUrl);
  const wallet = new Wallet(opts.privateKey, provider);
  const address = opts.contractAddress ?? ZG_PAYMENT_LAYER[opts.network];
  const contract = new Contract(address, opts.abi ?? PAYMENT_LAYER_DEPOSIT_ABI, wallet);

  const recipient = opts.recipient ?? (await wallet.getAddress());
  const deposit = contract.getFunction(opts.functionName ?? DEFAULT_DEPOSIT_FUNCTION);
  const tx = await deposit(recipient, { value: opts.amountWei });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Payment Layer deposit reverted (tx ${tx.hash})`);
  }
  return { txHash: tx.hash, blockNumber: receipt.blockNumber, recipient };
}
