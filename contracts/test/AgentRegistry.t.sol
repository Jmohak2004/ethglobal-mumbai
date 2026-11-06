// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./utils/Fixture.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {NotOwner, ZeroAddress} from "../src/Owned.sol";

contract AgentRegistryTest is Fixture {
    function test_platformCanRegisterAnyAgent() public {
        registry.register(AGENT_1, _defaultAgent());
        assertTrue(registry.exists(AGENT_1));
        assertEq(registry.getAgent(AGENT_1).owner, agentOwner);
    }

    function test_ownerCanRegisterOwnAgent() public {
        vm.prank(agentOwner);
        registry.register(AGENT_1, _defaultAgent());
        assertTrue(registry.exists(AGENT_1));
    }

    function test_strangerCannotRegister() public {
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.register(AGENT_1, _defaultAgent());
    }

    function test_duplicateRegisterReverts() public {
        registry.register(AGENT_1, _defaultAgent());
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentExists.selector, AGENT_1));
        registry.register(AGENT_1, _defaultAgent());
    }

    function test_registerRequiresAddresses() public {
        AgentRegistry.Agent memory a = _defaultAgent();
        a.tradingWallet = address(0);
        vm.expectRevert(ZeroAddress.selector);
        registry.register(AGENT_1, a);
    }

    function test_commissionDefaultBoundsAre0To2000() public {
        assertEq(registry.minCommissionBps(), 0);
        assertEq(registry.maxCommissionBps(), 2000);

        AgentRegistry.Agent memory a = _defaultAgent();
        a.commissionBps = 2001;
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CommissionOutOfBounds.selector, uint16(2001)));
        registry.register(AGENT_1, a);

        a.commissionBps = 2000;
        registry.register(AGENT_1, a);
        assertEq(registry.getAgent(AGENT_1).commissionBps, 2000);
    }

    function test_adminSetsCommissionBounds() public {
        registry.setCommissionBounds(100, 500);

        AgentRegistry.Agent memory a = _defaultAgent();
        a.commissionBps = 50;
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CommissionOutOfBounds.selector, uint16(50)));
        registry.register(AGENT_1, a);

        a.commissionBps = 500;
        registry.register(AGENT_1, a);
        assertEq(registry.getAgent(AGENT_1).commissionBps, 500);
    }

    function test_onlyOwnerSetsBoundsAndBoundsValid() public {
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        registry.setCommissionBounds(0, 100);

        vm.expectRevert(AgentRegistry.InvalidBounds.selector);
        registry.setCommissionBounds(600, 500);

        vm.expectRevert(AgentRegistry.InvalidBounds.selector);
        registry.setCommissionBounds(0, 10_001);
    }

    function test_listActiveAddAndRemove() public {
        AgentRegistry.Agent memory a = _defaultAgent();
        registry.register(AGENT_1, a);
        registry.register(AGENT_2, a);
        registry.register(AGENT_3, a);

        bytes32[] memory active = registry.listActive();
        assertEq(active.length, 3);

        // Pausing the middle agent swaps the last one into its slot.
        vm.prank(agentOwner);
        registry.setActive(AGENT_2, false);

        active = registry.listActive();
        assertEq(active.length, 2);
        assertEq(active[0], AGENT_1);
        assertEq(active[1], AGENT_3);
        assertFalse(registry.getAgent(AGENT_2).active);

        // Pausing an already paused agent is a no-op for the list.
        vm.prank(agentOwner);
        registry.setActive(AGENT_2, false);
        assertEq(registry.activeCount(), 2);

        // Resuming adds it back, and activating twice does not duplicate it.
        vm.prank(agentOwner);
        registry.setActive(AGENT_2, true);
        vm.prank(agentOwner);
        registry.setActive(AGENT_2, true);
        assertEq(registry.activeCount(), 3);
        assertTrue(registry.getAgent(AGENT_2).active);
    }

    function test_registerInactiveAgentNotListed() public {
        AgentRegistry.Agent memory a = _defaultAgent();
        a.active = false;
        registry.register(AGENT_1, a);
        assertEq(registry.listActive().length, 0);
    }

    function test_platformCanPauseAgent() public {
        registry.register(AGENT_1, _defaultAgent());
        registry.setActive(AGENT_1, false);
        assertEq(registry.activeCount(), 0);
    }

    function test_strangerCannotChangeActive() public {
        registry.register(AGENT_1, _defaultAgent());
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setActive(AGENT_1, false);
    }

    function test_updateConfigByOwnerAndOperator() public {
        registry.register(AGENT_1, _defaultAgent());

        vm.prank(agentOwner);
        registry.updateConfig(AGENT_1, keccak256("v2"));
        assertEq(registry.getAgent(AGENT_1).configHash, keccak256("v2"));

        vm.prank(operator);
        registry.updateConfig(AGENT_1, keccak256("v3"));
        assertEq(registry.getAgent(AGENT_1).configHash, keccak256("v3"));
    }

    function test_updateConfigStrangerReverts() public {
        registry.register(AGENT_1, _defaultAgent());
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.updateConfig(AGENT_1, keccak256("evil"));
    }

    function test_setForkSettingsOwnerOnly() public {
        registry.register(AGENT_1, _defaultAgent());

        vm.prank(operator);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setForkSettings(AGENT_1, true, 10 * USD);

        vm.prank(agentOwner);
        registry.setForkSettings(AGENT_1, true, 10 * USD);
        AgentRegistry.Agent memory a = registry.getAgent(AGENT_1);
        assertTrue(a.forkable);
        assertEq(a.forkPriceUsd6, 10 * USD);
    }

    function test_setOperatorOwnerOnly() public {
        registry.register(AGENT_1, _defaultAgent());

        vm.prank(operator);
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        registry.setOperator(AGENT_1, stranger);

        vm.prank(agentOwner);
        registry.setOperator(AGENT_1, stranger);
        assertEq(registry.getAgent(AGENT_1).operator, stranger);
    }

    function test_unknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentNotFound.selector, AGENT_1));
        registry.updateConfig(AGENT_1, bytes32(uint256(1)));
        assertFalse(registry.exists(AGENT_1));
    }

    function test_onlyOwnerSetsPlatform() public {
        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        registry.setPlatform(stranger);

        registry.setPlatform(stranger);
        assertEq(registry.platform(), stranger);
    }
}
