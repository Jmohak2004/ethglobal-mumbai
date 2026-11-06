// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./utils/Fixture.sol";
import {RiskOracle} from "../src/RiskOracle.sol";
import {IReceiver, IERC165, NotForwarder} from "../src/IReceiver.sol";

contract RiskOracleTest is Fixture {
    event RiskUpdated(uint8 level, uint16 reasonCode, uint64 asOf);
    event StaleReportSkipped(uint64 reportAsOf, uint64 storedAsOf);

    function test_defaultsToZero() public view {
        RiskOracle.Risk memory r = risk.getRisk();
        assertEq(r.level, 0);
        assertEq(r.reasonCode, 0);
        assertEq(r.asOf, 0);
        assertEq(r.updatedAt, 0);
    }

    function test_acceptsLevelsNormalCautionHalt() public {
        for (uint8 lvl = 0; lvl <= 2; lvl++) {
            _deliverRisk(lvl, 7, uint64(100 + lvl));
            RiskOracle.Risk memory r = risk.getRisk();
            assertEq(r.level, lvl);
            assertEq(r.reasonCode, 7);
            assertEq(r.asOf, 100 + lvl);
        }
    }

    function test_rejectsLevelAboveHalt() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.InvalidLevel.selector, uint8(3)));
        risk.onReport("", abi.encode(uint8(3), uint16(0), uint64(5)));
    }

    function testFuzz_levelAbove2Reverts(uint8 level) public {
        level = uint8(bound(level, 3, 255));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.InvalidLevel.selector, level));
        risk.onReport("", abi.encode(level, uint16(0), uint64(5)));
    }

    function test_staleReportIsSkipped() public {
        _deliverRisk(2, 42, 200);

        vm.expectEmit(false, false, false, true, address(risk));
        emit StaleReportSkipped(150, 200);
        _deliverRisk(0, 1, 150);

        // Equal asOf is also stale.
        vm.expectEmit(false, false, false, true, address(risk));
        emit StaleReportSkipped(200, 200);
        _deliverRisk(0, 1, 200);

        RiskOracle.Risk memory r = risk.getRisk();
        assertEq(r.level, 2);
        assertEq(r.reasonCode, 42);
        assertEq(r.asOf, 200);
    }

    function test_newerReportUpdatesAndStampsTime() public {
        vm.warp(1234);
        vm.expectEmit(false, false, false, true, address(risk));
        emit RiskUpdated(1, 9, 300);
        _deliverRisk(1, 9, 300);

        RiskOracle.Risk memory r = risk.getRisk();
        assertEq(r.updatedAt, 1234);
        assertEq(r.level, 1);
    }

    function test_onlyForwarderCanDeliver() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NotForwarder.selector, stranger));
        risk.onReport("", abi.encode(uint8(0), uint16(0), uint64(1)));
    }

    function test_supportsReceiverAndErc165() public view {
        assertTrue(risk.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(risk.supportsInterface(type(IERC165).interfaceId));
        assertFalse(risk.supportsInterface(0xffffffff));
    }
}
