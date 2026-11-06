// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./utils/Fixture.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {StrategyMarketplace} from "../src/StrategyMarketplace.sol";
import {NotOwner} from "../src/Owned.sol";

contract StrategyMarketplaceTest is Fixture {
    event Forked(
        bytes32 indexed agentId,
        address indexed buyer,
        bytes32 configHash,
        uint256 priceUsd6,
        uint256 platformCut
    );

    uint256 internal constant PRICE = 100 * USD;

    function setUp() public override {
        super.setUp();

        AgentRegistry.Agent memory a = _defaultAgent();
        a.creator = creator;
        a.forkable = true;
        a.forkPriceUsd6 = PRICE;
        registry.register(AGENT_1, a);

        usdc.mint(buyer, 1000 * USD);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function test_forkSplitsPriceBetweenCreatorAndPlatform() public {
        vm.prank(buyer);
        market.fork(AGENT_1);

        // 30% platform (PLATFORM_BPS = 3000), 70% creator.
        assertEq(usdc.balanceOf(platformWallet), 30 * USD);
        assertEq(usdc.balanceOf(creator), 70 * USD);
        assertEq(usdc.balanceOf(buyer), 900 * USD);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_forkRecordsLicenseAndEmits() public {
        bytes32 configHash = registry.getAgent(AGENT_1).configHash;

        vm.expectEmit(true, true, false, true, address(market));
        emit Forked(AGENT_1, buyer, configHash, PRICE, 30 * USD);

        vm.prank(buyer);
        market.fork(AGENT_1);

        assertTrue(market.hasLicense(AGENT_1, buyer));
        assertFalse(market.hasLicense(AGENT_1, stranger));
    }

    function test_forkRejectsDuplicateLicense() public {
        vm.startPrank(buyer);
        market.fork(AGENT_1);
        vm.expectRevert(abi.encodeWithSelector(StrategyMarketplace.AlreadyLicensed.selector, AGENT_1, buyer));
        market.fork(AGENT_1);
        vm.stopPrank();
    }

    function test_forkRequiresForkable() public {
        vm.prank(agentOwner);
        registry.setForkSettings(AGENT_1, false, PRICE);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyMarketplace.NotForkable.selector, AGENT_1));
        market.fork(AGENT_1);
    }

    function test_forkRequiresActive() public {
        registry.setActive(AGENT_1, false);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyMarketplace.AgentInactive.selector, AGENT_1));
        market.fork(AGENT_1);
    }

    function test_forkUnknownAgentReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyMarketplace.NotForkable.selector, AGENT_2));
        market.fork(AGENT_2);
    }

    function test_zeroPlatformBpsGivesCreatorEverything() public {
        market.setPlatformBps(0);

        vm.prank(buyer);
        market.fork(AGENT_1);

        assertEq(usdc.balanceOf(creator), PRICE);
        assertEq(usdc.balanceOf(platformWallet), 0);
    }

    function test_zeroPriceForkTransfersNothing() public {
        vm.prank(agentOwner);
        registry.setForkSettings(AGENT_1, true, 0);

        vm.prank(buyer);
        market.fork(AGENT_1);

        assertTrue(market.hasLicense(AGENT_1, buyer));
        assertEq(usdc.balanceOf(buyer), 1000 * USD);
    }

    function test_adminCanChangeSplitAndTreasury() public {
        market.setPlatformBps(1000);
        market.setPlatformTreasury(stranger);

        vm.prank(buyer);
        market.fork(AGENT_1);

        assertEq(usdc.balanceOf(stranger), 10 * USD);
        assertEq(usdc.balanceOf(creator), 90 * USD);
    }

    function test_platformBpsBoundsAndAdminOnly() public {
        vm.expectRevert(abi.encodeWithSelector(StrategyMarketplace.InvalidBps.selector, uint16(10_001)));
        market.setPlatformBps(10_001);

        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        market.setPlatformBps(1000);

        vm.prank(stranger);
        vm.expectRevert(NotOwner.selector);
        market.setPlatformTreasury(stranger);
    }

    /// @dev Split math: creator + platform always equals price, and platform = floor(price * bps / 10000).
    function testFuzz_splitMath(uint96 price, uint16 bps) public {
        price = uint96(bound(price, 1, 1_000_000_000 * USD));
        bps = uint16(bound(bps, 0, 10_000));

        usdc.mint(buyer, price);
        vm.prank(agentOwner);
        registry.setForkSettings(AGENT_1, true, price);
        market.setPlatformBps(bps);

        uint256 platformBefore = usdc.balanceOf(platformWallet);
        uint256 creatorBefore = usdc.balanceOf(creator);

        vm.prank(buyer);
        market.fork(AGENT_1);

        uint256 platformCut = usdc.balanceOf(platformWallet) - platformBefore;
        uint256 creatorCut = usdc.balanceOf(creator) - creatorBefore;
        assertEq(platformCut, uint256(price) * bps / 10_000);
        assertEq(platformCut + creatorCut, price);
    }
}
