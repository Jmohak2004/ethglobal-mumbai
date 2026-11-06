// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned, ZeroAddress} from "./Owned.sol";

contract AgentRegistry is Owned {
    struct Agent {
        address owner;
        address tradingWallet;
        address operator;
        address zgWallet;
        address creator;
        bytes32 configHash;
        bytes32 forkedFrom;
        uint8 template;
        uint16 commissionBps;
        uint256 forkPriceUsd6;
        bool forkable;
        bool active;
    }

    uint16 public constant MAX_BPS = 10_000;

    /// @notice Platform admin: may register agents and pause/resume any agent.
    address public platform;
    uint16 public minCommissionBps;
    uint16 public maxCommissionBps = 2000;

    mapping(bytes32 => Agent) private _agents;
    bytes32[] private _activeIds;
    /// @dev index + 1 into _activeIds; 0 means not active.
    mapping(bytes32 => uint256) private _activeIndexPlusOne;

    error AgentExists(bytes32 agentId);
    error AgentNotFound(bytes32 agentId);
    error NotAuthorized();
    error CommissionOutOfBounds(uint16 commissionBps);
    error InvalidBounds();

    event AgentRegistered(
        bytes32 indexed agentId, address indexed owner, address creator, bytes32 configHash, uint16 commissionBps
    );
    event ConfigUpdated(bytes32 indexed agentId, bytes32 configHash, address indexed by);
    event ForkSettingsUpdated(bytes32 indexed agentId, bool forkable, uint256 priceUsd6);
    event AgentActiveUpdated(bytes32 indexed agentId, bool active, address indexed by);
    event OperatorUpdated(bytes32 indexed agentId, address indexed operator);
    event PlatformUpdated(address indexed platform);
    event CommissionBoundsUpdated(uint16 minCommissionBps, uint16 maxCommissionBps);

    constructor() Owned(msg.sender) {
        platform = msg.sender;
        emit PlatformUpdated(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Writes
    // ---------------------------------------------------------------------

    /// @notice Register an agent. Callable by the platform admin or by the agent's owner.
    function register(bytes32 agentId, Agent calldata a) external {
        if (msg.sender != platform && msg.sender != a.owner) revert NotAuthorized();
        if (_agents[agentId].owner != address(0)) revert AgentExists(agentId);
        if (a.owner == address(0) || a.tradingWallet == address(0) || a.creator == address(0)) {
            revert ZeroAddress();
        }
        if (a.commissionBps < minCommissionBps || a.commissionBps > maxCommissionBps) {
            revert CommissionOutOfBounds(a.commissionBps);
        }

        _agents[agentId] = a;
        if (a.active) _addActive(agentId);

        emit AgentRegistered(agentId, a.owner, a.creator, a.configHash, a.commissionBps);
    }

    /// @notice Update the config hash. Callable by the agent owner or operator.
    function updateConfig(bytes32 agentId, bytes32 configHash) external {
        Agent storage a = _requireAgent(agentId);
        if (msg.sender != a.owner && msg.sender != a.operator) revert NotAuthorized();
        a.configHash = configHash;
        emit ConfigUpdated(agentId, configHash, msg.sender);
    }

    /// @notice Owner-only: mark the agent forkable and set its fork price (USDC, 6 decimals).
    function setForkSettings(bytes32 agentId, bool forkable, uint256 priceUsd6) external {
        Agent storage a = _requireAgent(agentId);
        if (msg.sender != a.owner) revert NotAuthorized();
        a.forkable = forkable;
        a.forkPriceUsd6 = priceUsd6;
        emit ForkSettingsUpdated(agentId, forkable, priceUsd6);
    }

    /// @notice Pause or resume an agent. Callable by the agent owner or the platform admin.
    function setActive(bytes32 agentId, bool active) external {
        Agent storage a = _requireAgent(agentId);
        if (msg.sender != a.owner && msg.sender != platform) revert NotAuthorized();
        a.active = active;
        if (active) {
            _addActive(agentId);
        } else {
            _removeActive(agentId);
        }
        emit AgentActiveUpdated(agentId, active, msg.sender);
    }

    /// @notice Owner-only: set the operator key that runs the agent's treasury actions.
    function setOperator(bytes32 agentId, address operator) external {
        Agent storage a = _requireAgent(agentId);
        if (msg.sender != a.owner) revert NotAuthorized();
        a.operator = operator;
        emit OperatorUpdated(agentId, operator);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setPlatform(address newPlatform) external onlyOwner {
        if (newPlatform == address(0)) revert ZeroAddress();
        platform = newPlatform;
        emit PlatformUpdated(newPlatform);
    }

    function setCommissionBounds(uint16 minBps, uint16 maxBps) external onlyOwner {
        if (minBps > maxBps || maxBps > MAX_BPS) revert InvalidBounds();
        minCommissionBps = minBps;
        maxCommissionBps = maxBps;
        emit CommissionBoundsUpdated(minBps, maxBps);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getAgent(bytes32 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function exists(bytes32 agentId) external view returns (bool) {
        return _agents[agentId].owner != address(0);
    }

    function listActive() external view returns (bytes32[] memory) {
        return _activeIds;
    }

    function activeCount() external view returns (uint256) {
        return _activeIds.length;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _requireAgent(bytes32 agentId) private view returns (Agent storage a) {
        a = _agents[agentId];
        if (a.owner == address(0)) revert AgentNotFound(agentId);
    }

    function _addActive(bytes32 agentId) private {
        if (_activeIndexPlusOne[agentId] != 0) return;
        _activeIds.push(agentId);
        _activeIndexPlusOne[agentId] = _activeIds.length;
    }

    function _removeActive(bytes32 agentId) private {
        uint256 idxPlusOne = _activeIndexPlusOne[agentId];
        if (idxPlusOne == 0) return;

        uint256 idx = idxPlusOne - 1;
        uint256 last = _activeIds.length - 1;
        if (idx != last) {
            bytes32 moved = _activeIds[last];
            _activeIds[idx] = moved;
            _activeIndexPlusOne[moved] = idx + 1;
        }
        _activeIds.pop();
        delete _activeIndexPlusOne[agentId];
    }
}
