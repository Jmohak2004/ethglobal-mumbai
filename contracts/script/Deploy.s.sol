// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {StrategyMarketplace} from "../src/StrategyMarketplace.sol";
import {PerformanceRegistry} from "../src/PerformanceRegistry.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {RiskOracle} from "../src/RiskOracle.sol";

/// @notice Deploys the full arena contract set. Configuration comes from environment variables;
/// the signer is supplied on the command line (--account or --private-key), never stored in this repo.
///
/// Required: USDC_ADDRESS, CRE_FORWARDER, RELAYER_ADDRESS, PLATFORM_TREASURY
/// Optional: PLATFORM_BPS (3000), DEFAULT_DAILY_TOPUP_CAP_USD6 (2000000), RESERVE_FLOOR_USD6 (0)
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address creForwarder = vm.envAddress("CRE_FORWARDER");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address platformTreasury = vm.envAddress("PLATFORM_TREASURY");
        uint256 platformBps = vm.envOr("PLATFORM_BPS", uint256(3000));
        uint256 dailyCap = vm.envOr("DEFAULT_DAILY_TOPUP_CAP_USD6", uint256(2_000_000));
        uint256 reserveFloor = vm.envOr("RESERVE_FLOOR_USD6", uint256(0));

        require(platformBps <= 10_000, "PLATFORM_BPS > 10000");

        vm.startBroadcast();

        // The broadcasting EOA becomes owner and platform admin of the registry, marketplace and treasury.
        AgentRegistry registry = new AgentRegistry();
        StrategyMarketplace marketplace =
            new StrategyMarketplace(IERC20(usdc), registry, platformTreasury, uint16(platformBps));
        // Receivers are wired to the CRE forwarder at construction; the forwarder stays owner-settable.
        PerformanceRegistry performance = new PerformanceRegistry(creForwarder);
        AgentTreasury treasury =
            new AgentTreasury(IERC20(usdc), registry, performance, relayer, dailyCap, reserveFloor);
        RiskOracle riskOracle = new RiskOracle(creForwarder);

        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("USDC", usdc);
        console2.log("AgentRegistry", address(registry));
        console2.log("StrategyMarketplace", address(marketplace));
        console2.log("PerformanceRegistry", address(performance));
        console2.log("AgentTreasury", address(treasury));
        console2.log("RiskOracle", address(riskOracle));
        console2.log("CRE forwarder", creForwarder);
        console2.log("Relayer", relayer);
        console2.log("Platform treasury", platformTreasury);
    }
}
