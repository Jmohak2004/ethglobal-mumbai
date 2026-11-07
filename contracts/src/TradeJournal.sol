// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned, ZeroAddress} from "./Owned.sol";

error NotRecorder(address caller);
error AlreadyRecorded(bytes32 fillId);
error InvalidSide(uint8 side);
error EmptyBatch();

/// @notice Onchain journal for paper fills. Paper trades never reach a chain, so the platform operator (the
/// recorder) posts each simulated fill here. The TradeRecorded event is the record; the per-fill flag only stops
/// the same fill from being journaled twice.
contract TradeJournal is Owned {
    struct Trade {
        /// @dev keccak256 of the agent id, or bytes32(0) for a human's manual fill.
        bytes32 agentId;
        /// @dev Trading wallet for an agent fill, the human's wallet otherwise.
        address funder;
        /// @dev keccak256 of the offchain fill id.
        bytes32 fillId;
        string asset;
        /// @dev 0 = buy, 1 = sell.
        uint8 side;
        uint256 notionalUsd6;
        uint256 priceUsd18;
        /// @dev keccak256 of the Flash quote id the price came from, or bytes32(0) when there was none.
        bytes32 quoteIdHash;
        bool paper;
        /// @dev Unix milliseconds, the same unit as fills.ts.
        uint64 ts;
    }

    /// @notice Account allowed to call record(). The platform operator key.
    address public recorder;
    /// @notice True once a fill id has been journaled.
    mapping(bytes32 => bool) public recorded;

    event RecorderUpdated(address indexed recorder);
    event TradeRecorded(
        bytes32 indexed agentId,
        address indexed funder,
        bytes32 indexed fillId,
        string asset,
        uint8 side,
        uint256 notionalUsd6,
        uint256 priceUsd18,
        bytes32 quoteIdHash,
        bool paper,
        uint64 ts
    );

    constructor(address recorder_) Owned(msg.sender) {
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
        emit RecorderUpdated(recorder_);
    }

    modifier onlyRecorder() {
        if (msg.sender != recorder) revert NotRecorder(msg.sender);
        _;
    }

    /// @notice Journal a batch of paper fills. Reverts on the whole batch if any fill id was already journaled.
    function record(Trade[] calldata trades) external onlyRecorder {
        if (trades.length == 0) revert EmptyBatch();
        for (uint256 i; i < trades.length; ++i) {
            Trade calldata t = trades[i];
            if (t.side > 1) revert InvalidSide(t.side);
            if (recorded[t.fillId]) revert AlreadyRecorded(t.fillId);
            recorded[t.fillId] = true;
            emit TradeRecorded(
                t.agentId,
                t.funder,
                t.fillId,
                t.asset,
                t.side,
                t.notionalUsd6,
                t.priceUsd18,
                t.quoteIdHash,
                t.paper,
                t.ts
            );
        }
    }

    /// @notice Owner-only: change the recorder account.
    function setRecorder(address newRecorder) external onlyOwner {
        if (newRecorder == address(0)) revert ZeroAddress();
        recorder = newRecorder;
        emit RecorderUpdated(newRecorder);
    }
}
