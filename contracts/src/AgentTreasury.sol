// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned, ZeroAddress} from "./Owned.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {PerformanceRegistry} from "./PerformanceRegistry.sol";

/// @notice Per-agent USDC treasury: commission collection, operator top-ups to the 0G relayer,
/// and owner withdrawals above a reserve. All USD amounts are 6-decimal USDC units.
contract AgentTreasury is Owned {
    struct Account {
        uint256 balance;
        uint256 commissionPaid;
        uint256 reserveTarget;
        uint256 dailyTopUpCap;
        bool hasCustomDailyCap;
        uint256 topUpDay;
        uint256 toppedUpToday;
        uint256 topUpNonce;
    }

    IERC20 public immutable usdc;
    AgentRegistry public immutable registry;
    PerformanceRegistry public immutable performanceRegistry;
    uint256 public immutable defaultDailyTopUpCapUsd6;

    address public relayer;
    uint256 public reserveFloorUsd6;

    mapping(bytes32 => Account) public accounts;

    error AgentNotFound(bytes32 agentId);
    error NotOperator();
    error NotAgentOwner();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error ExceedsDailyCap(uint256 requested, uint256 remaining);
    error ExceedsWithdrawable(uint256 requested, uint256 available);
    error ReserveBelowFloor(uint256 requested, uint256 floor);
    error TransferFailed();

    event CommissionCollected(bytes32 indexed agentId, uint256 amountUsd6, uint256 commissionPaidTotal);
    event TopUpRequested(bytes32 indexed agentId, uint256 amountUsd6, address zgWallet, uint256 nonce);
    event ReserveTargetUpdated(bytes32 indexed agentId, uint256 amountUsd6);
    event Withdrawn(bytes32 indexed agentId, address indexed to, uint256 amountUsd6);
    event RelayerUpdated(address indexed relayer);
    event ReserveFloorUpdated(uint256 amountUsd6);
    event DailyTopUpCapUpdated(bytes32 indexed agentId, uint256 capUsd6);

    constructor(
        IERC20 usdc_,
        AgentRegistry registry_,
        PerformanceRegistry performanceRegistry_,
        address relayer_,
        uint256 defaultDailyTopUpCapUsd6_,
        uint256 reserveFloorUsd6_
    ) Owned(msg.sender) {
        if (
            address(usdc_) == address(0) || address(registry_) == address(0)
                || address(performanceRegistry_) == address(0) || relayer_ == address(0)
        ) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        registry = registry_;
        performanceRegistry = performanceRegistry_;
        relayer = relayer_;
        defaultDailyTopUpCapUsd6 = defaultDailyTopUpCapUsd6_;
        reserveFloorUsd6 = reserveFloorUsd6_;
    }

    // ---------------------------------------------------------------------
    // Commission
    // ---------------------------------------------------------------------

    /// @notice Pull the commission newly owed (per the latest CRE report) from the agent's trading wallet.
    /// Anyone may call. Never charges the same amount twice: only the excess over commissionPaid is taken.
    function collectCommission(bytes32 agentId) external returns (uint256 owed) {
        AgentRegistry.Agent memory a = _agent(agentId);

        uint256 owedCumulative = performanceRegistry.commissionOwedCumulative(agentId);
        Account storage acc = accounts[agentId];
        if (owedCumulative <= acc.commissionPaid) return 0;

        owed = owedCumulative - acc.commissionPaid;
        acc.commissionPaid = owedCumulative;
        acc.balance += owed;
        emit CommissionCollected(agentId, owed, owedCumulative);

        if (!usdc.transferFrom(a.tradingWallet, address(this), owed)) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Operator actions
    // ---------------------------------------------------------------------

    /// @notice Send USDC to the conversion relayer to fund the agent's 0G compute credit.
    function topUp(bytes32 agentId, uint256 amountUsd6) external {
        AgentRegistry.Agent memory a = _agent(agentId);
        if (msg.sender != a.operator) revert NotOperator();
        if (amountUsd6 == 0) revert ZeroAmount();

        Account storage acc = accounts[agentId];
        if (amountUsd6 > acc.balance) revert InsufficientBalance(amountUsd6, acc.balance);

        uint256 today = block.timestamp / 1 days;
        if (acc.topUpDay != today) {
            acc.topUpDay = today;
            acc.toppedUpToday = 0;
        }
        uint256 cap = effectiveDailyTopUpCap(agentId);
        uint256 remaining = cap > acc.toppedUpToday ? cap - acc.toppedUpToday : 0;
        if (amountUsd6 > remaining) revert ExceedsDailyCap(amountUsd6, remaining);

        acc.toppedUpToday += amountUsd6;
        acc.balance -= amountUsd6;
        uint256 nonce = ++acc.topUpNonce;

        emit TopUpRequested(agentId, amountUsd6, a.zgWallet, nonce);
        if (!usdc.transfer(relayer, amountUsd6)) revert TransferFailed();
    }

    /// @notice Set the balance the operator wants kept back for compute. Cannot go below the platform floor.
    function setReserveTarget(bytes32 agentId, uint256 amountUsd6) external {
        AgentRegistry.Agent memory a = _agent(agentId);
        if (msg.sender != a.operator) revert NotOperator();
        if (amountUsd6 < reserveFloorUsd6) revert ReserveBelowFloor(amountUsd6, reserveFloorUsd6);

        accounts[agentId].reserveTarget = amountUsd6;
        emit ReserveTargetUpdated(agentId, amountUsd6);
    }

    // ---------------------------------------------------------------------
    // Owner withdrawals
    // ---------------------------------------------------------------------

    /// @notice Withdraw the part of the agent balance above its reserve, to the agent owner.
    function withdraw(bytes32 agentId, uint256 amountUsd6) external {
        AgentRegistry.Agent memory a = _agent(agentId);
        if (msg.sender != a.owner) revert NotAgentOwner();
        if (amountUsd6 == 0) revert ZeroAmount();

        uint256 available = withdrawable(agentId);
        if (amountUsd6 > available) revert ExceedsWithdrawable(amountUsd6, available);

        accounts[agentId].balance -= amountUsd6;
        emit Withdrawn(agentId, a.owner, amountUsd6);
        if (!usdc.transfer(a.owner, amountUsd6)) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    function setReserveFloor(uint256 amountUsd6) external onlyOwner {
        reserveFloorUsd6 = amountUsd6;
        emit ReserveFloorUpdated(amountUsd6);
    }

    function setDailyTopUpCap(bytes32 agentId, uint256 capUsd6) external onlyOwner {
        Account storage acc = accounts[agentId];
        acc.dailyTopUpCap = capUsd6;
        acc.hasCustomDailyCap = true;
        emit DailyTopUpCapUpdated(agentId, capUsd6);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getAccount(bytes32 agentId) external view returns (Account memory) {
        return accounts[agentId];
    }

    /// @notice Balance above max(reserveTarget, reserveFloor). Zero when the balance is under the reserve.
    function withdrawable(bytes32 agentId) public view returns (uint256) {
        Account storage acc = accounts[agentId];
        uint256 reserve = acc.reserveTarget > reserveFloorUsd6 ? acc.reserveTarget : reserveFloorUsd6;
        return acc.balance > reserve ? acc.balance - reserve : 0;
    }

    function effectiveDailyTopUpCap(bytes32 agentId) public view returns (uint256) {
        Account storage acc = accounts[agentId];
        return acc.hasCustomDailyCap ? acc.dailyTopUpCap : defaultDailyTopUpCapUsd6;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _agent(bytes32 agentId) private view returns (AgentRegistry.Agent memory a) {
        a = registry.getAgent(agentId);
        if (a.owner == address(0)) revert AgentNotFound(agentId);
    }
}
