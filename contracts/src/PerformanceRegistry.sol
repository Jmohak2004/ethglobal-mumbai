// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverBase} from "./IReceiver.sol";

/// @notice Receives CRE WF1 performance reports. Report payload: abi.encode(PerfEntry[]).
/// Field order and types must match packages/shared/src/onchain.ts (PERF_ENTRY_ABI).
contract PerformanceRegistry is ReceiverBase {
    struct PerfEntry {
        bytes32 agentId;
        int256 realizedPnlUsd6;
        uint256 volumeUsd6;
        uint32 trades;
        uint16 winRateBps;
        uint16 maxDrawdownBps;
        uint16 forecastHitRateBps;
        int256 hwmUsd6;
        uint256 commissionOwedCumulativeUsd6;
        uint64 asOf;
    }

    mapping(bytes32 => PerfEntry) private _performance;

    uint256 public lastReportAt;
    uint256 public reportCount;

    event PerformanceReported(
        bytes32 indexed agentId,
        uint64 asOf,
        int256 realizedPnlUsd6,
        uint256 commissionOwedCumulativeUsd6
    );
    event StaleEntrySkipped(bytes32 indexed agentId, uint64 entryAsOf, uint64 storedAsOf);

    constructor(address forwarder_) ReceiverBase(forwarder_) {}

    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        PerfEntry[] memory entries = abi.decode(report, (PerfEntry[]));

        lastReportAt = block.timestamp;
        reportCount += 1;

        for (uint256 i; i < entries.length; ++i) {
            PerfEntry memory e = entries[i];
            uint64 storedAsOf = _performance[e.agentId].asOf;

            if (e.asOf <= storedAsOf) {
                emit StaleEntrySkipped(e.agentId, e.asOf, storedAsOf);
                continue;
            }

            _performance[e.agentId] = e;
            emit PerformanceReported(e.agentId, e.asOf, e.realizedPnlUsd6, e.commissionOwedCumulativeUsd6);
        }
    }

    function getPerformance(bytes32 agentId) external view returns (PerfEntry memory) {
        return _performance[agentId];
    }

    function commissionOwedCumulative(bytes32 agentId) external view returns (uint256) {
        return _performance[agentId].commissionOwedCumulativeUsd6;
    }
}
