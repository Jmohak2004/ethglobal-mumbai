// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TradeJournal} from "../src/TradeJournal.sol";

/// @notice Deploys the paper trade journal. Separate from Deploy.s.sol so the arena set is not redeployed.
/// The broadcasting EOA becomes the owner. The recorder is the platform operator that posts paper fills.
///
/// Required: RECORDER_ADDRESS. Signer on the command line (--private-key or --account), never stored here.
contract DeployJournal is Script {
    function run() external {
        address recorder = vm.envAddress("RECORDER_ADDRESS");

        vm.startBroadcast();
        TradeJournal journal = new TradeJournal(recorder);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("TradeJournal", address(journal));
        console2.log("Recorder", recorder);
    }
}
