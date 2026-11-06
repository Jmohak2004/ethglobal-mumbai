// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverBase} from "./IReceiver.sol";

/// @notice Platform-wide risk level written by CRE WF2 (Crash Sentinel).
/// Report payload: abi.encode(uint8 level, uint16 reasonCode, uint64 asOf).
/// Levels: 0 = NORMAL, 1 = CAUTION, 2 = HALT.
contract RiskOracle is ReceiverBase {
    uint8 public constant MAX_LEVEL = 2;

    struct Risk {
        uint8 level;
        uint16 reasonCode;
        uint64 asOf;
        uint256 updatedAt;
    }

    Risk private _risk;

    error InvalidLevel(uint8 level);

    event RiskUpdated(uint8 level, uint16 reasonCode, uint64 asOf);
    event StaleReportSkipped(uint64 reportAsOf, uint64 storedAsOf);

    constructor(address forwarder_) ReceiverBase(forwarder_) {}

    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        (uint8 level, uint16 reasonCode, uint64 asOf) = abi.decode(report, (uint8, uint16, uint64));
        if (level > MAX_LEVEL) revert InvalidLevel(level);

        if (asOf <= _risk.asOf) {
            emit StaleReportSkipped(asOf, _risk.asOf);
            return;
        }

        _risk = Risk({level: level, reasonCode: reasonCode, asOf: asOf, updatedAt: block.timestamp});
        emit RiskUpdated(level, reasonCode, asOf);
    }

    function getRisk() external view returns (Risk memory) {
        return _risk;
    }
}
