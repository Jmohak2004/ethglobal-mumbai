// Report encodings shared by contracts (Solidity), CRE workflows and the worker.
// All USD amounts are fixed-point with 6 decimals (USDC units). Percent/ratios are bps.
import { encodeAbiParameters, keccak256, toBytes, decodeAbiParameters } from "viem";

/** Agents are UUIDs offchain and bytes32 onchain: keccak256(utf8(uuid)). Humans use their address left-padded. */
export function agentIdToBytes32(agentId: string): `0x${string}` {
  return keccak256(toBytes(agentId));
}

export const USD6 = 1_000_000;
export const toUsd6 = (usd: number): bigint => BigInt(Math.round(usd * USD6));
export const fromUsd6 = (v: bigint): number => Number(v) / USD6;

/**
 * PerformanceRegistry report: abi.encode(PerfEntry[])
 * struct PerfEntry {
 *   bytes32 agentId; int256 realizedPnlUsd6; uint256 volumeUsd6; uint32 trades;
 *   uint16 winRateBps; uint16 maxDrawdownBps; uint16 forecastHitRateBps;
 *   int256 hwmUsd6; uint256 commissionOwedCumulativeUsd6; uint64 asOf;
 * }
 */
export const PERF_ENTRY_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "agentId", type: "bytes32" },
      { name: "realizedPnlUsd6", type: "int256" },
      { name: "volumeUsd6", type: "uint256" },
      { name: "trades", type: "uint32" },
      { name: "winRateBps", type: "uint16" },
      { name: "maxDrawdownBps", type: "uint16" },
      { name: "forecastHitRateBps", type: "uint16" },
      { name: "hwmUsd6", type: "int256" },
      { name: "commissionOwedCumulativeUsd6", type: "uint256" },
      { name: "asOf", type: "uint64" },
    ],
  },
] as const;

export interface PerfEntry {
  agentId: `0x${string}`;
  realizedPnlUsd6: bigint;
  volumeUsd6: bigint;
  trades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  forecastHitRateBps: number;
  hwmUsd6: bigint;
  commissionOwedCumulativeUsd6: bigint;
  asOf: bigint;
}

export const encodePerfReport = (entries: PerfEntry[]) => encodeAbiParameters(PERF_ENTRY_ABI, [entries]);
export const decodePerfReport = (data: `0x${string}`) => decodeAbiParameters(PERF_ENTRY_ABI, data)[0];

/** RiskOracle report: abi.encode(uint8 level, uint16 reasonCode, uint64 asOf). */
export const RISK_REPORT_ABI = [
  { name: "level", type: "uint8" },
  { name: "reasonCode", type: "uint16" },
  { name: "asOf", type: "uint64" },
] as const;

export const encodeRiskReport = (level: number, reasonCode: number, asOf: bigint) =>
  encodeAbiParameters(RISK_REPORT_ABI, [level, reasonCode, asOf]);

/** Commission owed is computed on the high-water mark of cumulative realized PnL. */
export function commissionOwedCumulative(hwmUsd6: bigint, commissionBps: number): bigint {
  if (hwmUsd6 <= 0n) return 0n;
  return (hwmUsd6 * BigInt(commissionBps)) / 10_000n;
}
