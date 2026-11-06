// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned} from "./Owned.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE consumer interface. The CRE forwarder calls onReport with signed report data.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

error NotForwarder(address caller);

/// @notice Base for CRE report consumers. Only the configured forwarder may deliver reports.
/// The forwarder is owner-settable so it can point at the CRE mock forwarder during simulation.
abstract contract ReceiverBase is Owned, IReceiver {
    address public forwarder;

    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);

    constructor(address forwarder_) Owned(msg.sender) {
        forwarder = forwarder_;
        emit ForwarderUpdated(address(0), forwarder_);
    }

    modifier onlyForwarder() {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        _;
    }

    function setForwarder(address newForwarder) external onlyOwner {
        emit ForwarderUpdated(forwarder, newForwarder);
        forwarder = newForwarder;
    }

    function supportsInterface(bytes4 interfaceId) public pure virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
