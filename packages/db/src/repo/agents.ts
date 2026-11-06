import { and, desc, eq, inArray } from "drizzle-orm";
import type { Agent, AgentStatus, ExecutionMode, StrategyConfig, TemplateId } from "@arena/shared";
import type { Db } from "../client.ts";
import { agentConfigVersions, agents } from "../schema.ts";
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
