// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {StrategyMarketplace} from "../../src/StrategyMarketplace.sol";
import {PerformanceRegistry} from "../../src/PerformanceRegistry.sol";
import {AgentTreasury} from "../../src/AgentTreasury.sol";
import {RiskOracle} from "../../src/RiskOracle.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Deploys the full system. The test contract is the deployer, so it is the owner and platform admin.
abstract contract Fixture is Test {
    uint16 internal constant PLATFORM_BPS = 3000;
    uint256 internal constant DEFAULT_CAP = 2_000_000; // 2 USDC per UTC day
    uint256 internal constant USD = 1_000_000; // 1 USDC in 6-decimal units

    MockUSDC internal usdc;
    AgentRegistry internal registry;
    StrategyMarketplace internal market;
    PerformanceRegistry internal perf;
    AgentTreasury internal treasury;
    RiskOracle internal risk;

    address internal forwarder = makeAddr("forwarder");
    address internal relayer = makeAddr("relayer");
    address internal platformWallet = makeAddr("platformWallet");
    address internal creator = makeAddr("creator");
    address internal agentOwner = makeAddr("agentOwner");
    address internal operator = makeAddr("operator");
    address internal tradingWallet = makeAddr("tradingWallet");
    address internal zgWallet = makeAddr("zgWallet");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant AGENT_1 = keccak256("agent-1");
    bytes32 internal constant AGENT_2 = keccak256("agent-2");
    bytes32 internal constant AGENT_3 = keccak256("agent-3");

    function setUp() public virtual {
        usdc = new MockUSDC();
        registry = new AgentRegistry();
        market = new StrategyMarketplace(IERC20(address(usdc)), registry, platformWallet, PLATFORM_BPS);
        perf = new PerformanceRegistry(forwarder);
        treasury = new AgentTreasury(IERC20(address(usdc)), registry, perf, relayer, DEFAULT_CAP, 0);
        risk = new RiskOracle(forwarder);
    }

    /// @dev A valid, active, non-forkable agent owned by `agentOwner`, with `operator` and `tradingWallet` set.
    function _defaultAgent() internal view returns (AgentRegistry.Agent memory a) {
        a = AgentRegistry.Agent({
            owner: agentOwner,
            tradingWallet: tradingWallet,
            operator: operator,
            zgWallet: zgWallet,
            creator: creator,
            configHash: keccak256("config-v1"),
            forkedFrom: bytes32(0),
            template: 1,
            commissionBps: 1000,
            forkPriceUsd6: 0,
            forkable: false,
            active: true
        });
    }

    /// @dev Builds one PerfEntry. Only the fields the treasury and tests care about are parameterised.
    function _perfEntry(bytes32 agentId, int256 pnlUsd6, int256 hwmUsd6, uint256 owedUsd6, uint64 asOf)
        internal
        pure
        returns (PerformanceRegistry.PerfEntry memory e)
    {
        e = PerformanceRegistry.PerfEntry({
            agentId: agentId,
            realizedPnlUsd6: pnlUsd6,
            volumeUsd6: 500 * USD,
            trades: 12,
            winRateBps: 6000,
            maxDrawdownBps: 800,
            forecastHitRateBps: 5500,
            hwmUsd6: hwmUsd6,
            commissionOwedCumulativeUsd6: owedUsd6,
            asOf: asOf
        });
    }

    /// @dev Delivers a report as the CRE forwarder would.
    function _deliverPerf(PerformanceRegistry.PerfEntry[] memory entries) internal {
        vm.prank(forwarder);
        perf.onReport("", abi.encode(entries));
    }

    function _deliverPerf(PerformanceRegistry.PerfEntry memory entry) internal {
        PerformanceRegistry.PerfEntry[] memory entries = new PerformanceRegistry.PerfEntry[](1);
        entries[0] = entry;
        _deliverPerf(entries);
    }

    function _deliverRisk(uint8 level, uint16 reasonCode, uint64 asOf) internal {
        vm.prank(forwarder);
        risk.onReport("", abi.encode(level, reasonCode, asOf));
    }
}
