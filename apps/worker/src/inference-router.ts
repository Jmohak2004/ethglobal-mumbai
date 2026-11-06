// Per-agent 0G inference routers (PRD 6.11). An agent with a stored capped key is billed to its own key
// (payer "agent"). Otherwise the platform router is used (payer "platform"). The tick, reflection and the
// insight producer all select their router here, so the rule lives in one place.

import type { Db } from "@arena/db";
import type { Agent } from "@arena/shared";
import type { ZeroGRouter } from "@arena/zerog";
import { getAgentZgKey } from "./provisioner.ts";

export interface AgentRouterOptions {
  db: Db;
  /** AES key for stored secrets. Null when AGENT_KEY_ENCRYPTION_KEY is not set. */
  encryptionKey: Buffer | null;
  /** The platform router. Called only when the agent has no key, and throws when ZG_API_KEY is unset. */
  platformRouter: () => ZeroGRouter;
  /** Builds the agent's router from its decrypted `sk-` key. The router must use payer "agent". */
  agentRouter: (apiKey: string) => ZeroGRouter;
}

/**
 * Returns a per-agent router selector. Routers are cached per agent and rebuilt when the stored key changes.
 * A stored key without AGENT_KEY_ENCRYPTION_KEY throws (from getAgentZgKey) instead of silently falling back.
 */
export function createAgentRouterFor(opts: AgentRouterOptions): (agent: Pick<Agent, "id">) => Promise<ZeroGRouter> {
  const cache = new Map<string, { key: string; router: ZeroGRouter }>();
  return async (agent) => {
    const key = await getAgentZgKey({ db: opts.db, encryptionKey: opts.encryptionKey }, agent.id);
    if (!key) return opts.platformRouter();
    const cached = cache.get(agent.id);
    if (cached && cached.key === key) return cached.router;
    const router = opts.agentRouter(key);
    cache.set(agent.id, { key, router });
    return router;
  };
}
