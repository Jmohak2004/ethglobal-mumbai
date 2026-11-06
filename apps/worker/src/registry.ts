// AgentRegistry read: are the active agents registered onchain? Read-only and advisory. The worker logs a
// warning for each active agent the registry does not know, and keeps trading (registration is a
// listing concern, not a risk control).

import { agentIdToBytes32, type Agent } from "@arena/shared";
import type { Hex, PublicClient } from "viem";
import { AGENT_REGISTRY_ABI } from "./abi.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

/** AgentRegistry.exists(bytes32): whether the agent id is registered. */
export type RegistrationReader = (agentIdBytes32: Hex) => Promise<boolean>;

export function registryReader(client: PublicClient, address: Hex): RegistrationReader {
  return async (agentIdBytes32) =>
    (await client.readContract({ address, abi: AGENT_REGISTRY_ABI, functionName: "exists", args: [agentIdBytes32] })) as boolean;
}

export interface RegistrationCheck {
  checked: number;
  unregistered: string[];
  failed: string[];
}

/** Checks each agent once and warns about the ones the registry does not know. Read errors are per agent. */
export async function checkRegistrations(agents: Agent[], exists: RegistrationReader, logger: Logger = silentLogger): Promise<RegistrationCheck> {
  const result: RegistrationCheck = { checked: 0, unregistered: [], failed: [] };
  for (const agent of agents) {
    try {
      result.checked += 1;
      if (!(await exists(agentIdToBytes32(agent.id)))) {
        result.unregistered.push(agent.id);
        logger.warn("active agent is not registered onchain", { agent: agent.id });
      }
    } catch (err) {
      result.failed.push(agent.id);
      logger.warn("registry read failed", { agent: agent.id, error: err });
    }
  }
  return result;
}
