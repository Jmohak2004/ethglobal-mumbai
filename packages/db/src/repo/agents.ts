import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { toUsd6, type Agent, type AgentStatus, type ExecutionMode, type StrategyConfig, type TemplateId } from "@arena/shared";
import type { Db } from "../client.ts";
import { agentConfigVersions, agents, type ProvisioningState } from "../schema.ts";
import { ensureUser } from "./users.ts";
import { addr, clampLimit, hex, newId } from "./util.ts";

type AgentRow = typeof agents.$inferSelect;

export interface CreateAgentInput {
  id?: string;
  name: string;
  ownerAddress: string;
  tradingWallet: string;
  zgWallet?: string | null;
  config: StrategyConfig;
  /** Computed by the caller (the onchain configHash). The DB does not hash configs. */
  configHash: `0x${string}`;
  mode?: ExecutionMode;
  status?: AgentStatus;
  forkedFrom?: string | null;
  createdAt?: number;
}

export interface UpdateConfigInput {
  config: StrategyConfig;
  configHash: `0x${string}`;
  changelog?: string | null;
  /** Optimistic concurrency: fail with ConfigVersionConflictError if the agent is not at this version. */
  expectedVersion?: number;
  createdAt?: number;
}

/** Stats-only projection for public surfaces. Carries no config, sliders, owner or trades. */
export interface PublicAgent {
  id: string;
  name: string;
  template: TemplateId;
  mode: ExecutionMode;
  status: AgentStatus;
  forkedFrom: string | null;
  createdAt: number;
}

export interface ConfigVersion {
  agentId: string;
  version: number;
  config: StrategyConfig;
  configHash: `0x${string}`;
  changelog: string | null;
  createdAt: number;
}

export class ConfigVersionConflictError extends Error {
  constructor(agentId: string, expected: number, actual: number) {
    super(`agent ${agentId} is at config version ${actual}, expected ${expected}`);
    this.name = "ConfigVersionConflictError";
  }
}

/** Creates the agent, its ensured owner user, and config version 1, in one transaction. */
export async function createAgent(db: Db, input: CreateAgentInput): Promise<Agent> {
  const id = input.id ?? newId();
  const now = input.createdAt ?? Date.now();
  const owner = addr(input.ownerAddress);

  return db.transaction(async (tx) => {
    await ensureUser(tx, owner, now);
    const [row] = await tx
      .insert(agents)
      .values({
        id,
        name: input.name,
        ownerAddress: owner,
        tradingWallet: addr(input.tradingWallet),
        zgWallet: input.zgWallet ? addr(input.zgWallet) : null,
        status: input.status ?? "active",
        mode: input.mode ?? "paper",
        template: input.config.template,
        config: input.config,
        configVersion: 1,
        configHash: input.configHash,
        forkedFrom: input.forkedFrom ?? null,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("createAgent: insert returned no row");
    await tx.insert(agentConfigVersions).values({
      agentId: id,
      version: 1,
      config: input.config,
      configHash: input.configHash,
      changelog: "created",
      createdAt: now,
    });
    return toAgent(row);
  });
}

export async function getAgent(db: Db, id: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ? toAgent(row) : null;
}

/** Full agent records (including config). Callers must restrict this to the owner. */
export async function listByOwner(db: Db, ownerAddress: string): Promise<Agent[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerAddress, addr(ownerAddress)))
    .orderBy(desc(agents.createdAt));
  return rows.map(toAgent);
}

/** Non-stopped agents for public listings. Never returns config. */
export async function listPublic(
  db: Db,
  opts: { template?: TemplateId; limit?: number } = {},
): Promise<PublicAgent[]> {
  const conditions = [inArray(agents.status, ["active", "paused"])];
  if (opts.template) conditions.push(eq(agents.template, opts.template));
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      template: agents.template,
      mode: agents.mode,
      status: agents.status,
      forkedFrom: agents.forkedFrom,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(and(...conditions))
    .orderBy(desc(agents.createdAt))
    .limit(clampLimit(opts.limit, 100, 500));
  return rows.map((r) => ({
    ...r,
    template: r.template as TemplateId,
    mode: r.mode as ExecutionMode,
    status: r.status as AgentStatus,
  }));
}

/**
 * Replaces the agent's config as a new version (version = current + 1), appends the version row,
 * and updates the denormalized template. Runs in a transaction with a row lock.
 */
export async function updateConfig(db: Db, agentId: string, input: UpdateConfigInput): Promise<Agent> {
  const now = input.createdAt ?? Date.now();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ version: agents.configVersion })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update")
      .limit(1);
    if (!current) throw new Error(`updateConfig: agent not found: ${agentId}`);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new ConfigVersionConflictError(agentId, input.expectedVersion, current.version);
    }

    const next = current.version + 1;
    await tx.insert(agentConfigVersions).values({
      agentId,
      version: next,
      config: input.config,
      configHash: input.configHash,
      changelog: input.changelog ?? null,
      createdAt: now,
    });
    const [row] = await tx
      .update(agents)
      .set({
        config: input.config,
        configHash: input.configHash,
        configVersion: next,
        template: input.config.template,
      })
      .where(eq(agents.id, agentId))
      .returning();
    if (!row) throw new Error(`updateConfig: agent not found: ${agentId}`);
    return toAgent(row);
  });
}

/** A stored config version. Reverting means calling updateConfig with that version's config. */
export async function getConfigVersion(db: Db, agentId: string, version: number): Promise<ConfigVersion | null> {
  const [row] = await db
    .select()
    .from(agentConfigVersions)
    .where(and(eq(agentConfigVersions.agentId, agentId), eq(agentConfigVersions.version, version)))
    .limit(1);
  if (!row) return null;
  return {
    agentId: row.agentId,
    version: row.version,
    config: row.config,
    configHash: hex(row.configHash),
    changelog: row.changelog,
    createdAt: row.createdAt,
  };
}

export async function setAgentStatus(db: Db, agentId: string, status: AgentStatus): Promise<Agent | null> {
  const [row] = await db.update(agents).set({ status }).where(eq(agents.id, agentId)).returning();
  return row ? toAgent(row) : null;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    ownerAddress: hex(row.ownerAddress),
    tradingWallet: hex(row.tradingWallet),
    zgWallet: row.zgWallet ? hex(row.zgWallet) : null,
    config: row.config,
    configVersion: row.configVersion,
    configHash: hex(row.configHash),
    status: row.status as AgentStatus,
    mode: row.mode as ExecutionMode,
    forkedFrom: row.forkedFrom,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Provisioning (trading wallet, 0G wallet and key, AgentRegistry, treasury allowance)
// ---------------------------------------------------------------------------

/** The zero address. Agents created before provisioning carry it as their trading wallet. */
export const PLACEHOLDER_WALLET = "0x0000000000000000000000000000000000000000";

/** True for a missing or zero address: the agent has no trading wallet yet. */
export function isPlaceholderWallet(address: string | null | undefined): boolean {
  return !address || addr(address) === PLACEHOLDER_WALLET;
}

/** Which optional steps this environment can perform. A step the environment cannot perform is not a gap. */
export interface ProvisioningRequirements {
  /** The wallet provider can derive a 0G wallet. */
  zgWallet?: boolean;
  /** ZG_MGMT_KEY and AGENT_KEY_ENCRYPTION_KEY are set. */
  zgKey?: boolean;
  /** AgentRegistry, platform and operator keys are set. */
  registration?: boolean;
  /** TREASURY_ADDRESS is set and the trading wallet is locally controllable. */
  allowance?: boolean;
}

/**
 * Names of the provisioning steps this agent still needs, given the environment. Empty when provisioned.
 * A registered agent whose synced configHash is stale also has the "config sync" gap, and an agent whose
 * allowance cap no longer matches limits.maxAllocationUsd has the "allowance" gap.
 */
export function provisioningGaps(
  agent: Pick<Agent, "tradingWallet" | "zgWallet" | "configHash" | "config">,
  state: ProvisioningState,
  req: ProvisioningRequirements,
): string[] {
  const gaps: string[] = [];
  if (isPlaceholderWallet(agent.tradingWallet)) gaps.push("trading wallet");
  if (req.zgWallet && !agent.zgWallet) gaps.push("0G wallet");
  if (req.zgKey && !state.zgKeyId) gaps.push("0G key");
  if (req.registration && !state.registeredAt) gaps.push("registration");
  const synced = state.syncedConfigHash?.toLowerCase();
  if (req.registration && state.registeredAt && synced !== agent.configHash.toLowerCase()) gaps.push("config sync");
  const cap = toUsd6(agent.config.limits.maxAllocationUsd).toString();
  if (req.allowance && (!state.allowanceAt || state.allowanceCapUsd6 !== cap)) gaps.push("allowance");
  return gaps;
}

/** Agents (not stopped) with at least one provisioning gap for the given environment. */
export async function listAgentsNeedingProvisioning(db: Db, req: ProvisioningRequirements = {}): Promise<Agent[]> {
  const rows = await db.select().from(agents).where(inArray(agents.status, ["active", "paused"])).orderBy(agents.createdAt);
  const out: Agent[] = [];
  for (const row of rows) {
    const agent = toAgent(row);
    if (provisioningGaps(agent, row.provisioning ?? {}, req).length > 0) out.push(agent);
  }
  return out;
}

/** Stored provisioning state, or null when the agent does not exist. */
export async function getProvisioning(db: Db, agentId: string): Promise<ProvisioningState | null> {
  const [row] = await db.select({ provisioning: agents.provisioning }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return row ? (row.provisioning ?? {}) : null;
}

/** Sets the trading and/or 0G wallet. Omitted fields are left alone. A null zgWallet clears it. */
export async function setAgentWallets(
  db: Db,
  agentId: string,
  wallets: { tradingWallet?: string; zgWallet?: string | null },
): Promise<Agent | null> {
  const patch: Partial<typeof agents.$inferInsert> = {};
  if (wallets.tradingWallet !== undefined) patch.tradingWallet = addr(wallets.tradingWallet);
  if (wallets.zgWallet !== undefined) patch.zgWallet = wallets.zgWallet ? addr(wallets.zgWallet) : null;
  if (Object.keys(patch).length === 0) return getAgent(db, agentId);
  const [row] = await db.update(agents).set(patch).where(eq(agents.id, agentId)).returning();
  return row ? toAgent(row) : null;
}

/**
 * Shallow-merges a patch into the agent's provisioning jsonb, in one statement. Keys with undefined are
 * skipped (JSON.stringify drops them); null clears a field. Returns the merged state.
 */
export async function updateProvisioning(db: Db, agentId: string, patch: ProvisioningState): Promise<ProvisioningState> {
  const [row] = await db
    .update(agents)
    .set({
      provisioning: sql`coalesce(${agents.provisioning}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(agents.id, agentId))
    .returning({ provisioning: agents.provisioning });
  if (!row) throw new Error(`updateProvisioning: agent not found: ${agentId}`);
  return row.provisioning ?? {};
}

