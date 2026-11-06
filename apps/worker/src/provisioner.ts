// Agent provisioning (PRD 6.2 "On create"). Each step checks the stored state, and the chain where it can, before it
// acts, so a rerun never repeats a finished step. Steps whose config is absent are skipped. provisionAgent never
// throws: a failed step is recorded in provisioning.error, and the run loop retries it after a backoff.
//   a. trading wallet    WalletProvider.addressFor -> agents.trading_wallet
//   b. 0G wallet         WalletProvider.zgAddressFor -> agents.zg_wallet
//   c. 0G capped key     ZG_MGMT_KEY: createCappedKey, secret encrypted into zg_keys.encrypted_secret
//   d. registration      AgentRegistry.register from the platform admin (skipped when exists())
//   e. config sync       AgentRegistry.updateConfig from the operator when configHash changed
//   f. USDC allowance    approve(AgentTreasury, maxAllocationUsd) from the trading wallet; waits for gas

import {
  getAgent,
  getProvisioning,
  getZgKeySecret,
  insertZgKey,
  isPlaceholderWallet,
  listAgentsNeedingProvisioning,
  setAgentWallets,
  updateProvisioning,
  type Db,
  type ProvisioningRequirements,
  type ProvisioningState,
} from "@arena/db";
import { agentIdToBytes32, toUsd6, type Agent, type TemplateId } from "@arena/shared";
import type { CreatedKey, CreateCappedKeyInput } from "@arena/zerog";
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { Clock } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import type { TradingSender, WalletProvider } from "./wallets.ts";

/** Retry delay while the trading wallet has no ETH for the approve. */
export const GAS_RETRY_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

/**
 * AgentRegistry template index. Mirrors TEMPLATE_INDEX in apps/web/lib/templates.ts. Keep both in sync: the onchain
 * template field is what the marketplace reads.
 */
export const TEMPLATE_INDEX: Record<TemplateId, number> = {
  momentum: 0,
  mean_reversion: 1,
  breakout: 2,
  smart_dca: 3,
  social_sentiment: 4,
};

/** Creates a capped 0G key. Implemented by ZeroGAccount. */
export interface ZgKeyMinter {
  createCappedKey(input: CreateCappedKeyInput): Promise<CreatedKey>;
}

/** AgentRegistry.Agent, as the contract's register() takes it. */
export interface OnchainAgentRecord {
  owner: Hex;
  tradingWallet: Hex;
  operator: Hex;
  zgWallet: Hex;
  creator: Hex;
  configHash: Hex;
  forkedFrom: Hex;
  template: number;
  commissionBps: number;
  forkPriceUsd6: bigint;
  forkable: boolean;
  active: boolean;
}

/** AgentRegistry reads and writes. Each write resolves to the tx hash after its receipt succeeded. */
export interface RegistryWriter {
  /** Address stored as the operator on every agent this writer registers. */
  readonly operator: Hex;
  exists(agentIdBytes32: Hex): Promise<boolean>;
  /** The configHash stored onchain, or null when the agent is not registered. */
  configHashOf(agentIdBytes32: Hex): Promise<Hex | null>;
  register(agentIdBytes32: Hex, record: OnchainAgentRecord): Promise<Hex>;
  updateConfig(agentIdBytes32: Hex, configHash: Hex): Promise<Hex>;
}

/** Base-side reads and the USDC approve. The approve is sent by the trading wallet, local or Privy. */
export interface AllowanceWriter {
  ethBalance(address: Hex): Promise<bigint>;
  /** USDC allowance from owner to spender, in USD6. */
  allowance(owner: Hex, spender: Hex): Promise<bigint>;
  /** approve(spender, amount) sent from `from`. Resolves once the receipt succeeded, with the tx hash. */
  approve(from: TradingSender, spender: Hex, amountUsd6: bigint): Promise<Hex>;
}

export interface ProvisionDeps {
  db: Db;
  clock: Clock;
  logger?: Logger;
  wallets: WalletProvider;
  /** ZeroGAccount when ZG_MGMT_KEY is set, else null. */
  zgAccount: ZgKeyMinter | null;
  /** AGENT_KEY_ENCRYPTION_KEY as bytes, else null. Without it no 0G key is minted. */
  encryptionKey: Buffer | null;
  /** AGENT_DAILY_0G_CAP: the credit limit of each agent's capped key (0G units, reset daily). */
  zgCreditLimit: number;
  /** Null when REGISTRY_ADDRESS, PLATFORM_ADMIN_PRIVATE_KEY or OPERATOR_PRIVATE_KEY is missing. */
  registry: RegistryWriter | null;
  allowance: AllowanceWriter | null;
  /** AgentTreasury address, the spender of the USDC allowance. Null skips the step. */
  treasury: Hex | null;
}

export type StepName = "wallet" | "zgWallet" | "zgKey" | "registration" | "configSync" | "allowance";
/** done: performed now. already: found in place. skipped: config absent. waiting: needs gas. */
export type StepStatus = "done" | "already" | "skipped" | "waiting";

export interface ProvisionResult {
  agentId: string;
  /** ok: every step finished or was skipped. waiting: needs gas, retried later. backoff: not attempted yet. failed: error recorded. */
  status: "ok" | "waiting" | "backoff" | "failed";
  steps: Partial<Record<StepName, StepStatus>>;
  error: string | null;
}

/** What this environment can provision. A step the environment cannot perform is not a gap. */
export function provisioningRequirements(deps: ProvisionDeps): ProvisioningRequirements {
  return {
    zgWallet: typeof deps.wallets.zgAddressFor === "function",
    zgKey: Boolean(deps.zgAccount && deps.encryptionKey),
    registration: Boolean(deps.registry),
    allowance: Boolean(deps.allowance && deps.treasury && typeof deps.wallets.tradingSenderFor === "function"),
  };
}

/** Exponential backoff after a failure: 30 s, 1 min, 2 min, ... capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The agent's own 0G secret, decrypted, or null when it has none (the caller then uses the platform key).
 * Throws when a secret is stored but the encryption key is missing: falling back to the platform key would
 * silently bypass the agent's spend cap.
 */
export async function getAgentZgKey(opts: { db: Db; encryptionKey: Buffer | null }, agentId: string): Promise<string | null> {
  const stored = await getZgKeySecret(opts.db, agentId);
  if (!stored) return null;
  if (!opts.encryptionKey) {
    throw new Error(`agent ${agentId} has a stored 0G key but AGENT_KEY_ENCRYPTION_KEY is not set`);
  }
  return decryptSecret(stored.encryptedSecret, opts.encryptionKey);
}

/** Runs every applicable step for one agent. Never throws. */
export async function provisionAgent(deps: ProvisionDeps, agent: Agent, opts: { force?: boolean } = {}): Promise<ProvisionResult> {
  const log = (deps.logger ?? silentLogger).child({ agent: agent.id });
  const now = deps.clock.now();
  const result: ProvisionResult = { agentId: agent.id, status: "ok", steps: {}, error: null };
  let state: ProvisioningState = {};
  let current: Agent = agent;

  try {
    const stored = await getProvisioning(deps.db, agent.id);
    if (!stored) throw new Error(`agent not found: ${agent.id}`);
    state = stored;
    if (!opts.force && state.nextAttemptAt && now < state.nextAttemptAt) return { ...result, status: "backoff" };
    // The caller's copy may be stale (a wallet written by an earlier pass). Steps must see the stored row.
    current = (await getAgent(deps.db, agent.id)) ?? agent;

    /** Writes the patch to the row and to the local state, so later steps see what this pass has done. */
    const save = async (patch: ProvisioningState) => {
      Object.assign(state, patch);
      await updateProvisioning(deps.db, agent.id, patch);
    };

    // a. Trading wallet.
    if (isPlaceholderWallet(current.tradingWallet)) {
      const address = await deps.wallets.addressFor(current);
      current = (await setAgentWallets(deps.db, agent.id, { tradingWallet: address })) ?? current;
      await save({ walletAt: now });
      result.steps.wallet = "done";
    } else {
      result.steps.wallet = "already";
    }

    // b. 0G wallet, a separate derivation namespace from the trading wallet.
    if (!deps.wallets.zgAddressFor) {
      result.steps.zgWallet = "skipped";
    } else if (current.zgWallet) {
      result.steps.zgWallet = "already";
    } else {
      const zgWallet = await deps.wallets.zgAddressFor(current);
      current = (await setAgentWallets(deps.db, agent.id, { zgWallet })) ?? current;
      await save({ zgWalletAt: now });
      result.steps.zgWallet = "done";
    }

    // c. Capped 0G key. The plaintext secret is encrypted before it reaches the repo and is never logged.
    if (!deps.zgAccount || !deps.encryptionKey || current.status !== "active") {
      // Paused agents get their key when resumed, so idle and sample agents don't fill the 0G account with keys.
      result.steps.zgKey = "skipped";
    } else if (state.zgKeyId) {
      result.steps.zgKey = "already";
    } else {
      const storedKey = await getZgKeySecret(deps.db, agent.id);
      if (storedKey) {
        // Minted by an earlier pass whose bookkeeping did not finish.
        await save({ zgKeyId: storedKey.keyId, zgKeyAt: now });
        result.steps.zgKey = "already";
      } else {
        const minted = await deps.zgAccount.createCappedKey({
          name: `agent-${agent.id}`,
          creditLimit: deps.zgCreditLimit,
          resetPeriod: "daily",
        });
        const keyId = minted.keyId || `sk-${createHash("sha256").update(minted.key).digest("hex").slice(0, 16)}`;
        await insertZgKey(deps.db, {
          keyId,
          agentId: agent.id,
          creditLimit: deps.zgCreditLimit,
          resetPeriod: "daily",
          createdAt: now,
          encryptedSecret: encryptSecret(minted.key, deps.encryptionKey),
        });
        await save({ zgKeyId: keyId, zgKeyAt: now });
        result.steps.zgKey = "done";
      }
    }

    // d. Onchain registration. The platform admin registers; the operator is the key that later runs treasury actions.
    const registry = deps.registry;
    if (!registry) {
      result.steps.registration = "skipped";
    } else if (state.registeredAt) {
      result.steps.registration = "already";
    } else {
      if (!current.zgWallet && deps.wallets.zgAddressFor) throw new Error("0G wallet is not set: cannot register");
      const id32 = agentIdToBytes32(agent.id);
      if (await registry.exists(id32)) {
        const onchainHash = await registry.configHashOf(id32);
        await save({ registeredTx: null, registeredAt: now, syncedConfigHash: onchainHash ?? current.configHash });
        result.steps.registration = "already";
      } else {
        const source = current.forkedFrom ? await getAgent(deps.db, current.forkedFrom) : null;
        const templateIndex = TEMPLATE_INDEX[current.config.template];
        if (templateIndex === undefined) throw new Error(`no registry index for template ${current.config.template}`);
        const txHash = await registry.register(id32, {
          owner: current.ownerAddress,
          tradingWallet: current.tradingWallet,
          operator: registry.operator,
          zgWallet: current.zgWallet ?? ZERO_ADDRESS,
          creator: source ? source.ownerAddress : current.ownerAddress,
          configHash: current.configHash,
          forkedFrom: current.forkedFrom ? agentIdToBytes32(current.forkedFrom) : ZERO_BYTES32,
          template: templateIndex,
          commissionBps: current.config.commissionBps,
          forkPriceUsd6: toUsd6(current.config.fork.priceUsd),
          forkable: current.config.fork.forkable,
          active: true,
        });
        await save({ registeredTx: txHash, registeredAt: now, syncedConfigHash: current.configHash });
        result.steps.registration = "done";
      }
    }

    // e. Config sync: a registered agent whose configHash changed (auto-tune or owner edit) gets updateConfig.
    if (!registry || !state.registeredAt) {
      result.steps.configSync = "skipped";
    } else if (state.syncedConfigHash?.toLowerCase() === current.configHash.toLowerCase()) {
      result.steps.configSync = "already";
    } else {
      const txHash = await registry.updateConfig(agentIdToBytes32(agent.id), current.configHash);
      await save({ configTx: txHash, configAt: now, syncedConfigHash: current.configHash });
      result.steps.configSync = "done";
    }

    // f. USDC allowance to AgentTreasury, capped at maxAllocationUsd. Needs ETH on the trading wallet for gas.
    let waiting = false;
    const treasury = deps.treasury;
    const allowance = deps.allowance;
    const tradingSenderFor = deps.wallets.tradingSenderFor?.bind(deps.wallets);
    const cap = toUsd6(current.config.limits.maxAllocationUsd);
    if (!allowance || !treasury || !tradingSenderFor) {
      result.steps.allowance = "skipped";
    } else if (state.allowanceAt && state.allowanceCapUsd6 === cap.toString()) {
      result.steps.allowance = "already";
    } else {
      const sender = await tradingSenderFor(current);
      if ((await allowance.allowance(sender.address, treasury)) >= cap) {
        await save({ allowanceAt: now, allowanceCapUsd6: cap.toString(), needsGas: false });
        result.steps.allowance = "already";
      } else if ((await allowance.ethBalance(sender.address)) === 0n) {
        await save({ needsGas: true });
        waiting = true;
        result.steps.allowance = "waiting";
        log.info("allowance waits for gas", { wallet: sender.address });
      } else {
        const txHash = await allowance.approve(sender, treasury, cap);
        await save({ allowanceTx: txHash, allowanceAt: now, allowanceCapUsd6: cap.toString(), needsGas: false });
        result.steps.allowance = "done";
      }
    }

    await save({ error: null, attempts: 0, nextAttemptAt: waiting ? now + GAS_RETRY_MS : null });
    result.status = waiting ? "waiting" : "ok";
    const done = Object.entries(result.steps).filter(([, s]) => s === "done").map(([k]) => k);
    if (done.length > 0) log.info("provisioning progressed", { steps: done, status: result.status });
    return result;
  } catch (err) {
    const message = errorMessage(err);
    result.status = "failed";
    result.error = message;
    log.error("provisioning failed", { error: err });
    try {
      const attempts = (state.attempts ?? 0) + 1;
      await updateProvisioning(deps.db, agent.id, { error: message, attempts, nextAttemptAt: now + backoffMs(attempts) });
    } catch (writeErr) {
      log.error("could not record provisioning failure", { error: writeErr });
    }
    return result;
  }
}

/**
 * One run-loop pass: every agent with a provisioning gap in this environment, one at a time.
 * `force` ignores backoff; the worker uses it for its first pass so a config fixed between restarts
 * (e.g. DEV_AGENT_MNEMONIC added) takes effect immediately instead of after up to 30 minutes.
 */
export async function provisionPass(deps: ProvisionDeps, opts: { force?: boolean } = {}): Promise<ProvisionResult[]> {
  const agents = await listAgentsNeedingProvisioning(deps.db, provisioningRequirements(deps));
  const results: ProvisionResult[] = [];
  for (const agent of agents) results.push(await provisionAgent(deps, agent, { force: opts.force }));
  return results;
}
