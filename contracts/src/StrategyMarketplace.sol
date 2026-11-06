// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned, ZeroAddress} from "./Owned.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Paid forking of forkable agents. The buyer's USDC is split between the creator and the platform.
contract StrategyMarketplace is Owned {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    AgentRegistry public immutable registry;
    address public platformTreasury;
    uint16 public platformBps;

    /// @notice buyer license per agent, set when the buyer forks.
    mapping(bytes32 => mapping(address => bool)) public hasLicense;

    error NotForkable(bytes32 agentId);
    error AgentInactive(bytes32 agentId);
    error AlreadyLicensed(bytes32 agentId, address buyer);
    error InvalidBps(uint16 bps);
    error TransferFailed();

    event Forked(
        bytes32 indexed agentId,
        address indexed buyer,
        bytes32 configHash,
        uint256 priceUsd6,
        uint256 platformCut
    );
    event PlatformBpsUpdated(uint16 platformBps);
    event PlatformTreasuryUpdated(address indexed platformTreasury);

    constructor(IERC20 usdc_, AgentRegistry registry_, address platformTreasury_, uint16 platformBps_)
        Owned(msg.sender)
    {
        if (address(usdc_) == address(0) || address(registry_) == address(0) || platformTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (platformBps_ > BPS_DENOMINATOR) revert InvalidBps(platformBps_);

        usdc = usdc_;
        registry = registry_;
        platformTreasury = platformTreasury_;
        platformBps = platformBps_;
    }

    function fork(bytes32 agentId) external {
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        if (!a.forkable) revert NotForkable(agentId);
        if (!a.active) revert AgentInactive(agentId);
        if (hasLicense[agentId][msg.sender]) revert AlreadyLicensed(agentId, msg.sender);

        uint256 price = a.forkPriceUsd6;
        uint256 platformCut = (price * platformBps) / BPS_DENOMINATOR;
        uint256 creatorAmount = price - platformCut;

        hasLicense[agentId][msg.sender] = true;
        emit Forked(agentId, msg.sender, a.configHash, price, platformCut);

        if (creatorAmount > 0) _pay(msg.sender, a.creator, creatorAmount);
        if (platformCut > 0) _pay(msg.sender, platformTreasury, platformCut);
    }

    function setPlatformBps(uint16 newBps) external onlyOwner {
        if (newBps > BPS_DENOMINATOR) revert InvalidBps(newBps);
        platformBps = newBps;
        emit PlatformBpsUpdated(newBps);
    }

    function setPlatformTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        platformTreasury = newTreasury;
        emit PlatformTreasuryUpdated(newTreasury);
    }

    function _pay(address from, address to, uint256 amount) private {
        if (!usdc.transferFrom(from, to, amount)) revert TransferFailed();
    }
}
