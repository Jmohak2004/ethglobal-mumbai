// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./utils/Fixture.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {NotOwner} from "../src/Owned.sol";

contract AgentTreasuryTest is Fixture {
    event CommissionCollected(bytes32 indexed agentId, uint256 amountUsd6, uint256 commissionPaidTotal);
    event TopUpRequested(bytes32 indexed agentId, uint256 amountUsd6, address zgWallet, uint256 nonce);

    function setUp() public override {
        super.setUp();
        // Mid-day UTC so the daily-cap tests never straddle a day boundary by accident.
        vm.warp(10 days + 12 hours);

        registry.register(AGENT_1, _defaultAgent()); // commissionBps 1000, operator and tradingWallet set

        usdc.mint(tradingWallet, 1000 * USD);
        vm.prank(tradingWallet);
        usdc.approve(address(treasury), type(uint256).max);
    }

    /// @dev Report cumulative owed commission directly. hwm is the high-water mark the owed amount is derived from.
    function _reportOwed(uint256 owedUsd6, uint256 hwmUsd6, uint64 asOf) internal {
        _deliverPerf(_perfEntry(AGENT_1, int256(hwmUsd6), int256(hwmUsd6), owedUsd6, asOf));
    }

    /// @dev Credit `owedUsd6` of commission to the agent's treasury balance.
    function _fund(uint256 owedUsd6, uint64 asOf) internal {
        _reportOwed(owedUsd6, owedUsd6 * 10, asOf);
        treasury.collectCommission(AGENT_1);
    }

    // ---------------------------------------------------------------------
    // Commission collection
    // ---------------------------------------------------------------------

    function test_collectFollowsIncreasingHighWaterMark() public {
        _reportOwed(10 * USD, 100 * USD, 1);
        assertEq(treasury.collectCommission(AGENT_1), 10 * USD);

        _reportOwed(15 * USD, 150 * USD, 2);
        assertEq(treasury.collectCommission(AGENT_1), 5 * USD);

        _reportOwed(20 * USD, 200 * USD, 3);
        assertEq(treasury.collectCommission(AGENT_1), 5 * USD);

        AgentTreasury.Account memory acc = treasury.getAccount(AGENT_1);
        assertEq(acc.commissionPaid, 20 * USD);
        assertEq(acc.balance, 20 * USD);
        assertEq(usdc.balanceOf(address(treasury)), 20 * USD);
        assertEq(usdc.balanceOf(tradingWallet), 980 * USD);
    }

    function test_decreasingHighWaterMarkNeverDoubleCharges() public {
        _reportOwed(20 * USD, 200 * USD, 1);
        assertEq(treasury.collectCommission(AGENT_1), 20 * USD);

        // A lower report must not refund or re-charge anything.
        _reportOwed(12 * USD, 120 * USD, 2);
        assertEq(treasury.collectCommission(AGENT_1), 0);

        // Recovering to the old level is still already paid.
        _reportOwed(18 * USD, 180 * USD, 3);
        assertEq(treasury.collectCommission(AGENT_1), 0);

        // Only the excess above the total ever paid is collected.
        _reportOwed(25 * USD, 250 * USD, 4);
        assertEq(treasury.collectCommission(AGENT_1), 5 * USD);

        AgentTreasury.Account memory acc = treasury.getAccount(AGENT_1);
        assertEq(acc.commissionPaid, 25 * USD);
        assertEq(acc.balance, 25 * USD);
        assertEq(usdc.balanceOf(tradingWallet), 975 * USD);
    }

    function test_secondCollectWithoutNewHwmCollectsZero() public {
        _reportOwed(10 * USD, 100 * USD, 1);
        treasury.collectCommission(AGENT_1);

        uint256 balanceBefore = usdc.balanceOf(tradingWallet);
        assertEq(treasury.collectCommission(AGENT_1), 0);
        assertEq(usdc.balanceOf(tradingWallet), balanceBefore);
        assertEq(treasury.getAccount(AGENT_1).balance, 10 * USD);
    }

    function test_collectWithoutReportCollectsZero() public {
        assertEq(treasury.collectCommission(AGENT_1), 0);
    }

    function test_anyoneCanCollect() public {
        _reportOwed(3 * USD, 30 * USD, 1);

        vm.prank(stranger);
        uint256 owed = treasury.collectCommission(AGENT_1);
        assertEq(owed, 3 * USD);
    }

    function test_collectEmitsEvent() public {
        _reportOwed(3 * USD, 30 * USD, 1);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit CommissionCollected(AGENT_1, 3 * USD, 3 * USD);
        treasury.collectCommission(AGENT_1);
    }

    function test_collectUnknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.AgentNotFound.selector, AGENT_2));
        treasury.collectCommission(AGENT_2);
    }

    // ---------------------------------------------------------------------
    // Reserve and withdrawal
    // ---------------------------------------------------------------------

    function test_withdrawRespectsReserve() public {
        _fund(100 * USD, 1);

        vm.prank(operator);
        treasury.setReserveTarget(AGENT_1, 30 * USD);
        assertEq(treasury.withdrawable(AGENT_1), 70 * USD);

        vm.prank(agentOwner);
        treasury.withdraw(AGENT_1, 70 * USD);
        assertEq(usdc.balanceOf(agentOwner), 70 * USD);
        assertEq(treasury.getAccount(AGENT_1).balance, 30 * USD);
        assertEq(treasury.withdrawable(AGENT_1), 0);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ExceedsWithdrawable.selector, 1, 0));
        treasury.withdraw(AGENT_1, 1);
    }

    function test_withdrawableIsZeroBelowReserve() public {
        _fund(10 * USD, 1);
        vm.prank(operator);
        treasury.setReserveTarget(AGENT_1, 30 * USD);

        assertEq(treasury.withdrawable(AGENT_1), 0);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ExceedsWithdrawable.selector, 1, 0));
        treasury.withdraw(AGENT_1, 1);
    }

    function test_onlyAgentOwnerWithdraws() public {
        _fund(50 * USD, 1);

        vm.prank(operator);
        vm.expectRevert(AgentTreasury.NotAgentOwner.selector);
        treasury.withdraw(AGENT_1, 1 * USD);

        vm.prank(stranger);
        vm.expectRevert(AgentTreasury.NotAgentOwner.selector);
        treasury.withdraw(AGENT_1, 1 * USD);
    }

    function test_reserveTargetOperatorOnlyAndAboveFloor() public {
        treasury.setReserveFloor(20 * USD);

        vm.prank(stranger);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        treasury.setReserveTarget(AGENT_1, 25 * USD);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ReserveBelowFloor.selector, 10 * USD, 20 * USD));
        treasury.setReserveTarget(AGENT_1, 10 * USD);

        vm.prank(operator);
        treasury.setReserveTarget(AGENT_1, 25 * USD);
        assertEq(treasury.getAccount(AGENT_1).reserveTarget, 25 * USD);
    }

    function test_raisedFloorProtectsReserveAboveTarget() public {
        _fund(100 * USD, 1);
        vm.prank(operator);
        treasury.setReserveTarget(AGENT_1, 10 * USD);
        assertEq(treasury.withdrawable(AGENT_1), 90 * USD);

        // Admin raises the floor above the agent's own target: the floor wins.
        treasury.setReserveFloor(40 * USD);
        assertEq(treasury.withdrawable(AGENT_1), 60 * USD);
    }

    // ---------------------------------------------------------------------
    // Top-ups
    // ---------------------------------------------------------------------

    function test_topUpOnlyOperator() public {
        _fund(10 * USD, 1);

        vm.prank(agentOwner);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        treasury.topUp(AGENT_1, 1 * USD);

        vm.prank(stranger);
        vm.expectRevert(AgentTreasury.NotOperator.selector);
        treasury.topUp(AGENT_1, 1 * USD);
    }

    function test_topUpSendsToRelayerAndEmits() public {
        _fund(10 * USD, 1);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit TopUpRequested(AGENT_1, 1 * USD, zgWallet, 1);

        vm.prank(operator);
        treasury.topUp(AGENT_1, 1 * USD);

        assertEq(usdc.balanceOf(relayer), 1 * USD);
        AgentTreasury.Account memory acc = treasury.getAccount(AGENT_1);
        assertEq(acc.balance, 9 * USD);
        assertEq(acc.topUpNonce, 1);
    }

    function test_topUpCannotExceedBalance() public {
        _fund(1 * USD, 1);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.InsufficientBalance.selector, 2 * USD, 1 * USD));
        treasury.topUp(AGENT_1, 2 * USD);
    }

    function test_topUpRejectsZero() public {
        _fund(1 * USD, 1);
        vm.prank(operator);
        vm.expectRevert(AgentTreasury.ZeroAmount.selector);
        treasury.topUp(AGENT_1, 0);
    }

    function test_topUpDailyCapEnforcedThenResetsNextDay() public {
        _fund(10 * USD, 1);
        // Default cap is 2 USDC per UTC day.

        vm.startPrank(operator);
        treasury.topUp(AGENT_1, 1.5e6);

        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ExceedsDailyCap.selector, 0.6e6, 0.5e6));
        treasury.topUp(AGENT_1, 0.6e6);

        // Hitting the cap exactly is allowed.
        treasury.topUp(AGENT_1, 0.5e6);

        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ExceedsDailyCap.selector, 0.1e6, 0));
        treasury.topUp(AGENT_1, 0.1e6);
        vm.stopPrank();

        // Next UTC day: the counter resets.
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        treasury.topUp(AGENT_1, 2 * USD);

        // Three successful top-ups (reverted attempts do not consume a nonce).
        assertEq(usdc.balanceOf(relayer), 4 * USD);
        assertEq(treasury.getAccount(AGENT_1).topUpNonce, 3);
    }

    function test_adminOverridesDailyCap() public {
        _fund(10 * USD, 1);

        treasury.setDailyTopUpCap(AGENT_1, 5 * USD);
        assertEq(treasury.effectiveDailyTopUpCap(AGENT_1), 5 * USD);

        vm.prank(operator);
        treasury.topUp(AGENT_1, 4 * USD);

        // An explicit zero cap disables top-ups for this agent.
        treasury.setDailyTopUpCap(AGENT_1, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.ExceedsDailyCap.selector, 1 * USD, 0));
        treasury.topUp(AGENT_1, 1 * USD);
    }

    function test_adminSettersAreOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(NotOwner.selector);
        treasury.setRelayer(stranger);
        vm.expectRevert(NotOwner.selector);
        treasury.setReserveFloor(1);
        vm.expectRevert(NotOwner.selector);
        treasury.setDailyTopUpCap(AGENT_1, 1);
        vm.stopPrank();

        treasury.setRelayer(stranger);
        assertEq(treasury.relayer(), stranger);
    }
}
