// Contract ABIs, imported from the Foundry export so the worker always matches the deployed Solidity.
// viem's typed inference does not survive a JSON import, so callers cast results to the shapes they expect.

import type { Abi } from "viem";
import agentRegistryJson from "../../../contracts/abi/AgentRegistry.json";
import agentTreasuryJson from "../../../contracts/abi/AgentTreasury.json";
import performanceRegistryJson from "../../../contracts/abi/PerformanceRegistry.json";
import riskOracleJson from "../../../contracts/abi/RiskOracle.json";
import tradeJournalJson from "../../../contracts/abi/TradeJournal.json";

export const AGENT_REGISTRY_ABI = agentRegistryJson as unknown as Abi;
export const AGENT_TREASURY_ABI = agentTreasuryJson as unknown as Abi;
export const PERFORMANCE_REGISTRY_ABI = performanceRegistryJson as unknown as Abi;
export const RISK_ORACLE_ABI = riskOracleJson as unknown as Abi;
export const TRADE_JOURNAL_ABI = tradeJournalJson as unknown as Abi;
