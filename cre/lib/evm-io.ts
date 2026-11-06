// Shared EVM read/write helpers for the CRE workflows (SDK-facing; not imported by unit tests).
import {
  EVMClient,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  prepareReportRequest,
  TxStatus,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import { ZERO_ADDRESS } from "./chains.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validates an address from config. Throws on malformed input. */
export function toAddress(value: string, name: string): Address {
  if (!ADDRESS_RE.test(value)) throw new Error(`config ${name} is not an address: ${value}`);
  return value as Address;
}

/** Throws if a receiver or feed address is still the zero placeholder. Deploy first, then update config. */
export function assertDeployed(value: string, name: string): Address {
  const addr = toAddress(value, name);
  if (addr.toLowerCase() === ZERO_ADDRESS) throw new Error(`config ${name} is still the zero placeholder (not deployed)`);
  return addr;
}

/** Unix seconds from the DON clock. runtime.now() is used instead of Date.now() for consensus. */
export function nowSeconds(runtime: Runtime<unknown>): bigint {
  return BigInt(Math.floor(runtime.now().getTime() / 1000));
}

/** EVMClient for a CRE chain-selector name (for example "ethereum-testnet-sepolia-base-1"). */
export function makeEvmClient(chainSelectorName: string, isTestnet: boolean): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName, isTestnet });
  if (!network) throw new Error(`CRE network not found: ${chainSelectorName} (isTestnet=${isTestnet})`);
  return new EVMClient(network.chainSelector.selector);
}

/** Read-only contract call at the latest block. Returns raw ABI-encoded return data. */
export function callView(runtime: Runtime<unknown>, evm: EVMClient, to: Address, data: Hex): Hex {
  const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: ZERO_ADDRESS, to, data }) }).result();
  return bytesToHex(reply.data);
}

/** Typed view call: encodes args, calls, decodes the first return value. */
export function readFn<const TAbi extends Abi>(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  to: Address,
  abi: TAbi,
  functionName: string,
  args: readonly unknown[] = [],
): any {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const raw = callView(runtime, evm, to, data);
  return decodeFunctionResult({ abi, functionName, data: raw } as never);
}

/**
 * Writes a PerformanceRegistry or RiskOracle report through the CRE forwarder path:
 * runtime.report() signs the payload, evmClient.writeReport() submits it to the receiver.
 * Fails on a non-success tx status or when the receiver's onReport reverted.
 */
export function writeReportTo(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  receiver: Address,
  encodedPayload: Hex,
  gasLimit: string,
): Hex {
  const report = runtime.report(prepareReportRequest(encodedPayload)).result();
  const write = evm
    .writeReport(runtime, { receiver, report, gasConfig: { gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: status=${write.txStatus} ${write.errorMessage ?? ""}`);
  }
  if (write.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
    throw new Error(`receiver onReport reverted for ${receiver}`);
  }
  const txHash = write.txHash ?? new Uint8Array(32);
  return bytesToHex(txHash);
}
