// Composition root. Builds every concrete dependency from env. Nothing else in the worker reads process.env.
// Missing keys do not stop startup: each feature reports its own "not configured" error when it is used.

import { closeDb, createDb, getAgent, listPublic, type Db } from "@arena/db";
import { FlashClient, FlashExecutor } from "@arena/flash";
import { globalLimitsFromEnv, ZG_ROUTER_URL, type Agent } from "@arena/shared";
import { NoopMemoryStore, ZeroGAccount, ZeroGRouter, ZeroGStorage, type MemoryStore } from "@arena/zerog";
import type { Hex } from "viem";
import { chainConfigFor, publicClientFor, type ChainConfig } from "./chain.ts";
import type { WorkerEnv } from "./env.ts";
import { createBudgetSource } from "./budget.ts";
import { createMarketData, chainlinkFeedReader } from "./market.ts";
import { createRiskSource, riskOracleReader } from "./risk.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createPerfChain, type PerfChain } from "./stats.ts";
import { createTreasury, treasuryChainFromEnv, type Treasury } from "./economics/treasury.ts";
import { coingeckoZgUsd, createViemRelayerChain, fileCursorStore, type RelayerOptions } from "./economics/relayer.ts";
import { registryReader, type RegistrationReader } from "./registry.ts";
import { LocalWalletProvider, PrivyWalletProvider, type WalletProvider } from "./wallets.ts";
import { systemClock, type Clock, type Deps } from "./deps.ts";
import type { ReflectionDeps } from "./reflection.ts";
import { getAgentZgKey, type ProvisionDeps, type RegistryWriter } from "./provisioner.ts";
import { createViemAllowanceWriter, createViemRegistryWriter } from "./provisioner-chain.ts";
import { parseEncryptionKey } from "./secrets.ts";

export interface Runtime {
  env: WorkerEnv;
  db: Db;
  logger: Logger;
  clock: Clock;
  chain: ChainConfig;
  deps: Deps;
  treasury: Treasury;
  memory: MemoryStore;
  /** AgentRegistry.exists reader, or null when REGISTRY_ADDRESS is not set. */
  registry: RegistrationReader | null;
  perf: PerfChain | null;
  /** Flash REST client, or null when DEFINITIVE_API_KEY is not set. */
  flash: FlashClient | null;
  reflectionDeps(): ReflectionDeps;
  relayerOptions(): RelayerOptions;
  /** Dependencies for provisioning (wallets, 0G keys, registry, allowance). */
  provisionDeps(): ProvisionDeps;
  close(): Promise<void>;
}

export interface RuntimeOverrides {
  db?: Db;
  logger?: Logger;
  clock?: Clock;
}

/** Agents with the given statuses, with full configs. */
export async function loadAgents(db: Db, statuses: Agent["status"][] = ["active"]): Promise<Agent[]> {
  const rows = await listPublic(db, { limit: 500 });
  const out: Agent[] = [];
  for (const row of rows) {
    if (!statuses.includes(row.status)) continue;
    const agent = await getAgent(db, row.id);
    if (agent) out.push(agent);
  }
  return out;
}

/** Flash client used when DEFINITIVE_API_KEY is missing. Every call fails with a clear message. */
const missingFlashClient: Pick<FlashClient, "quote" | "submitOrder"> = {
  quote: async () => {
    throw new Error("DEFINITIVE_API_KEY is not set: Flash quotes are unavailable");
  },
  submitOrder: async () => {
    throw new Error("DEFINITIVE_API_KEY is not set: Flash orders are unavailable");
  },
};

export function createRuntime(env: WorkerEnv, overrides: RuntimeOverrides = {}): Runtime {
  const logger = overrides.logger ?? createLogger();
  const clock = overrides.clock ?? systemClock;
  const db = overrides.db ?? createDb({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
  const chain = chainConfigFor(env);
  const client = publicClientFor(chain);
  const zgBaseUrl = env.ZG_ROUTER_URL ?? ZG_ROUTER_URL[env.NETWORK];

  const market = createMarketData({ feed: chainlinkFeedReader(client, chain), clock, logger });

  const riskAddress = env.RISK_ORACLE_ADDRESS as Hex | undefined;
  const risk = createRiskSource({
    db,
    clock,
    readOnchain: riskAddress ? riskOracleReader(client, riskAddress) : undefined,
    logger,
  });

  const zgAccount = env.ZG_MGMT_KEY ? new ZeroGAccount({ mgmtKey: env.ZG_MGMT_KEY, baseUrl: zgBaseUrl }) : null;
  const budget = createBudgetSource({ db, clock, seedCredit0G: env.AGENT_SEED_CREDIT_0G, account: zgAccount, logger });

  const wallets: WalletProvider =
    env.DEV_AGENT_MNEMONIC || env.DEV_AGENT_PRIVATE_KEY
      ? new LocalWalletProvider({ mnemonic: env.DEV_AGENT_MNEMONIC, privateKey: env.DEV_AGENT_PRIVATE_KEY as Hex | undefined })
      : new PrivyWalletProvider();

  const flash = env.DEFINITIVE_API_KEY ? new FlashClient({ apiKey: env.DEFINITIVE_API_KEY }) : null;
  const executor = new FlashExecutor({ client: flash ?? missingFlashClient, integratorFeeBps: env.FLASH_INTEGRATOR_FEE_BPS, tokens: chain.tokens });

  let router: ZeroGRouter | null = null;
  const routerFor = (): ZeroGRouter => {
    if (!env.ZG_API_KEY) throw new Error("ZG_API_KEY is not set: no decision model is available");
    router ??= new ZeroGRouter({ apiKey: env.ZG_API_KEY, baseUrl: zgBaseUrl, payer: "platform" });
    return router;
  };

  // Per-agent 0G keys (provisioning step c). The router is rebuilt when an agent's stored key changes.
  const encryptionKey = env.AGENT_KEY_ENCRYPTION_KEY ? parseEncryptionKey(env.AGENT_KEY_ENCRYPTION_KEY) : null;
  const agentRouters = new Map<string, { key: string; router: ZeroGRouter }>();
  const agentRouterFor = async (agent: Agent): Promise<ZeroGRouter> => {
    const key = await getAgentZgKey({ db, encryptionKey }, agent.id);
    if (!key) return routerFor();
    const cached = agentRouters.get(agent.id);
    if (cached && cached.key === key) return cached.router;
    const agentRouter = new ZeroGRouter({ apiKey: key, baseUrl: zgBaseUrl, payer: "agent" });
    agentRouters.set(agent.id, { key, router: agentRouter });
    return agentRouter;
  };

  const memory: MemoryStore =
    env.ZG_STORAGE_INDEXER && env.ZG_RPC_URL && env.ZG_PRIVATE_KEY
      ? new ZeroGStorage({ rpcUrl: env.ZG_RPC_URL, indexerUrl: env.ZG_STORAGE_INDEXER, privateKey: env.ZG_PRIVATE_KEY })
      : new NoopMemoryStore();
  if (memory instanceof NoopMemoryStore) {
    logger.warn("0G Storage not configured: memory roots are local digests, not 0G roots", {});
  }

  const treasury = createTreasury({
    db,
    clock,
    logger,
    chain: treasuryChainFromEnv(env, chain),
    minTopUpUsd: env.MIN_TOPUP_USD,
    maxTopUpPerDayUsd: env.MAX_TOPUP_PER_DAY_USD,
  });

  const perf = env.PERF_REGISTRY_ADDRESS
    ? createPerfChain({
        client,
        address: env.PERF_REGISTRY_ADDRESS as Hex,
        fromBlock: BigInt(env.PERF_REGISTRY_FROM_BLOCK),
        chunkBlocks: env.LOG_CHUNK_BLOCKS,
      })
    : null;
  const registry = env.REGISTRY_ADDRESS ? registryReader(client, env.REGISTRY_ADDRESS as Hex) : null;

  // Provisioning writers. Each is null when its keys are missing, and the matching step is then skipped.
  const registryWriter: RegistryWriter | null =
    env.REGISTRY_ADDRESS && env.PLATFORM_ADMIN_PRIVATE_KEY && env.OPERATOR_PRIVATE_KEY
      ? createViemRegistryWriter({
          chain,
          registry: env.REGISTRY_ADDRESS as Hex,
          platformKey: env.PLATFORM_ADMIN_PRIVATE_KEY as Hex,
          operatorKey: env.OPERATOR_PRIVATE_KEY as Hex,
        })
      : null;
  const usdc = chain.tokens.USDC?.address;
  const allowanceWriter = usdc ? createViemAllowanceWriter({ chain, usdc }) : null;

  const deps: Deps = {
    db,
    clock,
    logger,
    executionMode: env.EXECUTION_MODE,
    globalLimits: globalLimitsFromEnv(env),
    market,
    risk,
    budget,
    wallets,
    executor,
    routerFor,
    agentRouterFor,
    // Flash cancel and PATCH need signed messages that this repo does not define yet (see crash.ts). Until
    // an implementation is supplied, live cancels and stop changes fail with a recorded error.
    orderControl: null,
  };

  return {
    env,
    db,
    logger,
    clock,
    chain,
    deps,
    treasury,
    memory,
    perf,
    registry,
    flash,

    provisionDeps: () => ({
      db,
      clock,
      logger,
      wallets,
      zgAccount,
      encryptionKey,
      zgCreditLimit: env.AGENT_DAILY_0G_CAP,
      registry: registryWriter,
      allowance: allowanceWriter,
      treasury: (env.TREASURY_ADDRESS as Hex | undefined) ?? null,
    }),

    reflectionDeps: () => ({
      db,
      clock,
      logger,
      memory,
      routerFor,
      globalLimits: deps.globalLimits,
      commissionBounds: { min: env.COMMISSION_BPS_MIN, max: env.COMMISSION_BPS_MAX },
    }),

    relayerOptions: () => {
      if (!env.TREASURY_ADDRESS) throw new Error("relayer needs TREASURY_ADDRESS");
      if (!env.RELAYER_ZG_PRIVATE_KEY || !env.ZG_RPC_URL) {
        throw new Error("relayer needs RELAYER_ZG_PRIVATE_KEY and ZG_RPC_URL");
      }
      return {
        db,
        clock,
        logger,
        chain: createViemRelayerChain({ client, treasury: env.TREASURY_ADDRESS as Hex }),
        cursor: fileCursorStore(env.RELAYER_CURSOR_FILE),
        zgPrice: coingeckoZgUsd(),
        fallbackZgPerUsdc: env.ZG_PER_USDC ?? null,
        spreadBps: env.RELAYER_SPREAD_BPS,
        maxRequestUsd: env.RELAYER_MAX_REQUEST_USD,
        zg: { rpcUrl: env.ZG_RPC_URL, privateKey: env.RELAYER_ZG_PRIVATE_KEY as Hex, network: env.NETWORK },
        agents: () => loadAgents(db, ["active", "paused"]),
      };
    },

    close: () => closeDb(db),
  };
}
