// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TradeJournal, NotRecorder, AlreadyRecorded, InvalidSide, EmptyBatch} from "../src/TradeJournal.sol";
import {ZeroAddress, NotOwner} from "../src/Owned.sol";

contract TradeJournalTest is Test {
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

    TradeJournal internal journal;

    address internal recorder = makeAddr("recorder");
    address internal stranger = makeAddr("stranger");
    address internal funder = makeAddr("funder");
    bytes32 internal constant AGENT = keccak256("agent-1");

    function setUp() public {
        journal = new TradeJournal(recorder);
    }

    function _trade(bytes32 fillId, uint8 side) internal view returns (TradeJournal.Trade memory t) {
        t = TradeJournal.Trade({
            agentId: AGENT,
            funder: funder,
            fillId: fillId,
            asset: "WETH",
            side: side,
            notionalUsd6: 1_000_000,
            priceUsd18: 2000e18,
            quoteIdHash: keccak256("quote-1"),
            paper: true,
            ts: 1_700_000_000_000
        });
    }

    function _batch(bytes32 a, bytes32 b) internal view returns (TradeJournal.Trade[] memory list) {
        list = new TradeJournal.Trade[](2);
        list[0] = _trade(a, 0);
        list[1] = _trade(b, 1);
    }

    function test_deployerIsOwnerAndRecorderIsSet() public view {
        assertEq(journal.owner(), address(this));
        assertEq(journal.recorder(), recorder);
    }

    function test_constructorRejectsZeroRecorder() public {
        vm.expectRevert(ZeroAddress.selector);
        new TradeJournal(address(0));
    }

    function test_recordEmitsEventAndMarksFill() public {
        bytes32 fillId = keccak256("fill-1");
        TradeJournal.Trade[] memory list = new TradeJournal.Trade[](1);
        list[0] = _trade(fillId, 0);

        vm.expectEmit(true, true, true, true, address(journal));
        emit TradeRecorded(AGENT, funder, fillId, "WETH", 0, 1_000_000, 2000e18, keccak256("quote-1"), true, 1_700_000_000_000);

        vm.prank(recorder);
        journal.record(list);

        assertTrue(journal.recorded(fillId));
    }

    function test_recordsABatchInOneCall() public {
        TradeJournal.Trade[] memory list = new TradeJournal.Trade[](20);
        for (uint256 i; i < list.length; i++) {
            list[i] = _trade(keccak256(abi.encode("fill", i)), uint8(i % 2));
        }
        vm.prank(recorder);
        journal.record(list);
        for (uint256 i; i < list.length; i++) {
            assertTrue(journal.recorded(keccak256(abi.encode("fill", i))));
        }
    }

    function test_onlyRecorderCanRecord() public {
        TradeJournal.Trade[] memory list = _batch(keccak256("a"), keccak256("b"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NotRecorder.selector, stranger));
        journal.record(list);
    }

    function test_ownerCannotRecordUnlessRecorder() public {
        TradeJournal.Trade[] memory list = _batch(keccak256("a"), keccak256("b"));
        vm.expectRevert(abi.encodeWithSelector(NotRecorder.selector, address(this)));
        journal.record(list);
    }

    function test_rejectsFillAlreadyJournaled() public {
        bytes32 fillId = keccak256("fill-dup");
        TradeJournal.Trade[] memory first = new TradeJournal.Trade[](1);
        first[0] = _trade(fillId, 0);
        vm.prank(recorder);
        journal.record(first);

        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(AlreadyRecorded.selector, fillId));
        journal.record(first);
    }

    function test_rejectsDuplicateInsideOneBatch() public {
        bytes32 fillId = keccak256("fill-twice");
        TradeJournal.Trade[] memory list = _batch(fillId, fillId);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(AlreadyRecorded.selector, fillId));
        journal.record(list);
        assertFalse(journal.recorded(fillId));
    }

    function test_duplicateRevertsTheWholeBatch() public {
        bytes32 old = keccak256("old");
        TradeJournal.Trade[] memory seed = new TradeJournal.Trade[](1);
        seed[0] = _trade(old, 0);
        vm.prank(recorder);
        journal.record(seed);

        TradeJournal.Trade[] memory list = _batch(keccak256("fresh"), old);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(AlreadyRecorded.selector, old));
        journal.record(list);
        assertFalse(journal.recorded(keccak256("fresh")));
    }

    function test_rejectsInvalidSide() public {
        TradeJournal.Trade[] memory list = new TradeJournal.Trade[](1);
        list[0] = _trade(keccak256("bad"), 2);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(InvalidSide.selector, uint8(2)));
        journal.record(list);
    }

    function test_rejectsEmptyBatch() public {
        TradeJournal.Trade[] memory list = new TradeJournal.Trade[](0);
        vm.prank(recorder);
        vm.expectRevert(EmptyBatch.selector);
        journal.record(list);
    }

    function test_ownerCanRotateRecorder() public {
        address next = makeAddr("next");
        journal.setRecorder(next);
        assertEq(journal.recorder(), next);

        TradeJournal.Trade[] memory list = _batch(keccak256("old-recorder"), keccak256("x"));
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(NotRecorder.selector, recorder));
        journal.record(list);

        vm.prank(next);
        journal.record(list);
        assertTrue(journal.recorded(keccak256("x")));
    }

    function test_setRecorderIsOwnerOnlyAndNonZero() public {
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        journal.setRecorder(stranger);

        vm.expectRevert(ZeroAddress.selector);
        journal.setRecorder(address(0));
    }

    function testFuzz_sideAboveOneReverts(uint8 side) public {
        vm.assume(side > 1);
        TradeJournal.Trade[] memory list = new TradeJournal.Trade[](1);
        list[0] = _trade(keccak256(abi.encode(side)), side);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(InvalidSide.selector, side));
        journal.record(list);
    }
}
