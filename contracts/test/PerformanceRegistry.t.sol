// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./utils/Fixture.sol";
import {PerformanceRegistry} from "../src/PerformanceRegistry.sol";
import {IReceiver, IERC165, NotForwarder} from "../src/IReceiver.sol";
import {NotOwner} from "../src/Owned.sol";

contract PerformanceRegistryTest is Fixture {
    event PerformanceReported(
        bytes32 indexed agentId,
        uint64 asOf,
        int256 realizedPnlUsd6,
        uint256 commissionOwedCumulativeUsd6
    );
    event StaleEntrySkipped(bytes32 indexed agentId, uint64 entryAsOf, uint64 storedAsOf);

    /// @dev abi.encode(PerfEntry[]) of one entry, produced from the TypeScript PERF_ENTRY_ABI layout
    /// (`cast abi-encode` with the same tuple types). Values: agentId 0x11..11, realizedPnl -5e6,
    /// volume 250e6, trades 7, winRate 6250, maxDD 1200, forecast 5000, hwm 12e6, owed 1.2e6, asOf 1700000000.
    bytes internal constant TS_ENCODED_REPORT =
        hex"000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000011111111111111111111111111111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb3b4c0000000000000000000000000000000000000000000000000000000000ee6b2800000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000004b000000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000b71b000000000000000000000000000000000000000000000000000000000000124f80000000000000000000000000000000000000000000000000000000006553f100";

    function setUp() public override {
        super.setUp();
        vm.warp(1000);
    }

    function test_onlyForwarderCanDeliver() public {
        PerformanceRegistry.PerfEntry[] memory entries = new PerformanceRegistry.PerfEntry[](0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NotForwarder.selector, stranger));
        perf.onReport("", abi.encode(entries));
    }

    function test_decodesTypeScriptEncodedReport() public {
        vm.prank(forwarder);
        perf.onReport(hex"", TS_ENCODED_REPORT);

        bytes32 agentId = 0x1111111111111111111111111111111111111111111111111111111111111111;
        PerformanceRegistry.PerfEntry memory p = perf.getPerformance(agentId);
        assertEq(p.agentId, agentId);
        assertEq(p.realizedPnlUsd6, -5_000_000);
        assertEq(p.volumeUsd6, 250_000_000);
        assertEq(p.trades, 7);
        assertEq(p.winRateBps, 6250);
        assertEq(p.maxDrawdownBps, 1200);
        assertEq(p.forecastHitRateBps, 5000);
        assertEq(p.hwmUsd6, 12_000_000);
        assertEq(p.commissionOwedCumulativeUsd6, 1_200_000);
        assertEq(p.asOf, 1_700_000_000);
        assertEq(perf.commissionOwedCumulative(agentId), 1_200_000);
    }

    function test_storesEntriesAndTracksReports() public {
        PerformanceRegistry.PerfEntry[] memory entries = new PerformanceRegistry.PerfEntry[](2);
        entries[0] = _perfEntry(AGENT_1, 25 * int256(USD), 25 * int256(USD), 2_500_000, 1000);
        entries[1] = _perfEntry(AGENT_2, -5 * int256(USD), 0, 0, 1000);

        vm.warp(5000);
        _deliverPerf(entries);

        assertEq(perf.reportCount(), 1);
        assertEq(perf.lastReportAt(), 5000);
        assertEq(perf.getPerformance(AGENT_1).commissionOwedCumulativeUsd6, 2_500_000);
        assertEq(perf.getPerformance(AGENT_2).realizedPnlUsd6, -5 * int256(USD));
        assertEq(perf.getPerformance(AGENT_3).asOf, 0);
    }

    function test_emitsPerformanceReported() public {
        vm.expectEmit(true, false, false, true, address(perf));
        emit PerformanceReported(AGENT_1, 1000, 25 * int256(USD), 2_500_000);
        _deliverPerf(_perfEntry(AGENT_1, 25 * int256(USD), 25 * int256(USD), 2_500_000, 1000));
    }

    function test_staleEntriesAreSkippedWithoutRevert() public {
        _deliverPerf(_perfEntry(AGENT_1, 40 * int256(USD), 40 * int256(USD), 4_000_000, 2000));

        // Older asOf is skipped.
        vm.expectEmit(true, false, false, true, address(perf));
        emit StaleEntrySkipped(AGENT_1, 1500, 2000);
        _deliverPerf(_perfEntry(AGENT_1, 99 * int256(USD), 99 * int256(USD), 9_900_000, 1500));

        // Equal asOf is skipped too.
        vm.expectEmit(true, false, false, true, address(perf));
        emit StaleEntrySkipped(AGENT_1, 2000, 2000);
        _deliverPerf(_perfEntry(AGENT_1, 99 * int256(USD), 99 * int256(USD), 9_900_000, 2000));

        PerformanceRegistry.PerfEntry memory p = perf.getPerformance(AGENT_1);
        assertEq(p.asOf, 2000);
        assertEq(p.commissionOwedCumulativeUsd6, 4_000_000);
        assertEq(perf.reportCount(), 3);
    }

    function test_newerEntryReplacesStored() public {
        _deliverPerf(_perfEntry(AGENT_1, 10 * int256(USD), 10 * int256(USD), 1_000_000, 1000));
        _deliverPerf(_perfEntry(AGENT_1, 30 * int256(USD), 30 * int256(USD), 3_000_000, 1001));

        assertEq(perf.getPerformance(AGENT_1).asOf, 1001);
        assertEq(perf.commissionOwedCumulative(AGENT_1), 3_000_000);
    }

    function test_forwarderCanBeRotated() public {
        address newForwarder = makeAddr("newForwarder");

        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        perf.setForwarder(newForwarder);

        perf.setForwarder(newForwarder);
        assertEq(perf.forwarder(), newForwarder);

        PerformanceRegistry.PerfEntry[] memory entries = new PerformanceRegistry.PerfEntry[](0);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(NotForwarder.selector, forwarder));
        perf.onReport("", abi.encode(entries));

        vm.prank(newForwarder);
        perf.onReport("", abi.encode(entries));
        assertEq(perf.reportCount(), 1);
    }

    function test_supportsReceiverAndErc165() public view {
        assertTrue(perf.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(perf.supportsInterface(type(IERC165).interfaceId));
        assertFalse(perf.supportsInterface(0xffffffff));
        assertEq(type(IReceiver).interfaceId, IReceiver.onReport.selector);
    }
}
