// Report encodings. COPIED from packages/shared/src/onchain.ts so the bytes match the Solidity
// receivers byte-for-byte. If you change one copy, change the other and re-run `bun test`.
import { encodeAbiParameters, decodeAbiParameters, keccak256, pad, toBytes, type Hex } from "viem";
import type { PnlMetrics } from "./pnl.ts";

/** Agents are UUIDs offchain and bytes32 onchain: keccak256(utf8(uuid)). Humans use their address left-padded. */
export function agentIdToBytes32(agentId: string): `0x${string}` {
  return keccak256(toBytes(agentId));
}

/** Humans are keyed by their wallet address, left-padded to bytes32. */
export function humanAgentId(wallet: `0x${string}`): `0x${string}` {
  return pad(wallet, { size: 32 });
}

export const USD6 = 1_000_000;

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

export const encodeRiskReport = (level: number, reasonCode: number, asOf: bigint): Hex =>
  encodeAbiParameters(RISK_REPORT_ABI, [level, reasonCode, asOf]);

/** Commission owed is computed on the high-water mark of cumulative realized PnL. */
export function commissionOwedCumulative(hwmUsd6: bigint, commissionBps: number): bigint {
  if (hwmUsd6 <= 0n) return 0n;
  return (hwmUsd6 * BigInt(commissionBps)) / 10_000n;
}

/** Builds one PerfEntry from computed metrics. Enforces the uint16/uint32 bounds the ABI requires. */
export function toPerfEntry(params: {
  agentId: `0x${string}`;
  metrics: PnlMetrics;
  commissionBps: number;
  asOf: bigint;
}): PerfEntry {
  const { agentId, metrics, commissionBps, asOf } = params;
  const bounded = (v: number, max: number, name: string): number => {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name} out of range: ${v}`);
    return v;
  };
  return {
    agentId,
    realizedPnlUsd6: metrics.realizedPnlUsd6,
    volumeUsd6: metrics.volumeUsd6,
    trades: bounded(metrics.trades, 0xffff_ffff, "trades"),
    winRateBps: bounded(metrics.winRateBps, 10_000, "winRateBps"),
    maxDrawdownBps: bounded(metrics.maxDrawdownBps, 10_000, "maxDrawdownBps"),
    forecastHitRateBps: bounded(metrics.forecastHitRateBps, 10_000, "forecastHitRateBps"),
    hwmUsd6: metrics.hwmUsd6,
    commissionOwedCumulativeUsd6: commissionOwedCumulative(metrics.hwmUsd6, commissionBps),
    asOf,
  };
}
