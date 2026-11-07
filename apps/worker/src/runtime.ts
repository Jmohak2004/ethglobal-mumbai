// Composition root. Builds every concrete dependency from env. Nothing else in the worker reads process.env.
// Missing keys do not stop startup: each feature reports its own "not configured" error when it is used.

import { closeDb, createDb, getAgent, listPublic, type Db } from "@arena/db";
import { createOrderControl, FlashClient, FlashExecutor, type OrderControl } from "@arena/flash";
import { globalLimitsFromEnv, ZG_ROUTER_URL, type Agent } from "@arena/shared";
import { NoopMemoryStore, ZeroGAccount, ZeroGRouter, ZeroGStorage, type MemoryStore } from "@arena/zerog";
import { PrivyClient } from "@privy-io/node";
import type { Hex } from "viem";
import { caip2For, chainConfigFor, flashChainFor, publicClientFor, type ChainConfig } from "./chain.ts";
import { createViemFlashChain } from "./flash-chain.ts";
import type { WorkerEnv } from "./env.ts";
import { createBudgetSource } from "./budget.ts";
import { AgentLock } from "./agent-lock.ts";
import { modeFor } from "./execution.ts";
import { createMarketData, chainlinkFeedReader } from "./market.ts";
import { createRiskSource, riskOracleReader } from "./risk.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createPerfChain, type PerfChain } from "./stats.ts";
import { createTreasury, treasuryChainFromEnv, type Treasury } from "./economics/treasury.ts";
import { coingeckoZgUsd, createViemRelayerChain, fileCursorStore, type RelayerOptions } from "./economics/relayer.ts";
import { registryReader, type RegistrationReader } from "./registry.ts";
import { LocalWalletProvider, UnconfiguredWalletProvider, type WalletProvider } from "./wallets.ts";
import { PrivyWalletProvider, privyStoreFromDb, type PrivyServerClient } from "./privy-wallets.ts";
import { systemClock, type Clock, type Deps } from "./deps.ts";
import type { ReflectionDeps } from "./reflection.ts";
import type { ProvisionDeps, RegistryWriter } from "./provisioner.ts";
import { createViemAllowanceWriter, createViemLocalSend, createViemRegistryWriter } from "./provisioner-chain.ts";
import { parseEncryptionKey } from "./secrets.ts";
import { createAgentRouterFor } from "./inference-router.ts";
import { createInsightProducer, type InsightProducer } from "./insights/producer.ts";
import { parseFeedList, RssCollector } from "./insights/sources.ts";

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
  /** Insight digests (PRD 6.8): the 15-min cycle, and the refresh a tick calls when a digest is stale. */
  insights: InsightProducer;
  /** One lock per agent. Ticks, paper TP/SL exits and paper ledger writes all run under it. */
  agentLock: AgentLock;
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

/**
 * The trading-wallet provider for WALLET_PROVIDER. Privy wallets are keyed by the stored Privy id in the agent's
 * provisioning jsonb. Local wallets come from the DEV_AGENT_* keys, and local approvals are sent on the configured chain.
 */
export function walletProviderFor(env: WorkerEnv, deps: { db: Db; chain: ChainConfig }): WalletProvider {
  // Flash approvals always go to Base mainnet, whatever CHAIN is.
  const flashConfig = flashChainFor(env);
  if (env.WALLET_PROVIDER === "privy") {
    if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) throw new Error("WALLET_PROVIDER=privy needs PRIVY_APP_ID and PRIVY_APP_SECRET");
    const client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
    return new PrivyWalletProvider({
      client: client as unknown as PrivyServerClient,
      store: privyStoreFromDb(deps.db),
      caip2: caip2For(deps.chain),
      policyId: env.PRIVY_POLICY_ID,
      authorizationKey: env.PRIVY_AUTHORIZATION_KEY,
      flash: createViemFlashChain(flashConfig),
    });
  }
  if (env.DEV_AGENT_MNEMONIC || env.DEV_AGENT_PRIVATE_KEY) {
    return new LocalWalletProvider({
      mnemonic: env.DEV_AGENT_MNEMONIC,
      privateKey: env.DEV_AGENT_PRIVATE_KEY as Hex | undefined,
      sendTransaction: createViemLocalSend(deps.chain),
      flash: { chain: createViemFlashChain(flashConfig), sendTransaction: createViemLocalSend(flashConfig) },
    });
  }
  return new UnconfiguredWalletProvider("WALLET_PROVIDER=local needs DEV_AGENT_MNEMONIC or DEV_AGENT_PRIVATE_KEY");
}

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
  const budget = createBudgetSource({
    db,
    clock,
    seedCredit0G: env.AGENT_SEED_CREDIT_0G,
    account: zgAccount,
    isPaper: (agent) => modeFor({ executionMode: env.EXECUTION_MODE }, agent) === "paper",
    logger,
  });

  const wallets: WalletProvider = walletProviderFor(env, { db, chain });

  const flash = env.DEFINITIVE_API_KEY ? new FlashClient({ apiKey: env.DEFINITIVE_API_KEY }) : null;
  // Flash settles on Base mainnet, so quotes name mainnet token addresses even when CHAIN is Base Sepolia.
  const executor = new FlashExecutor({ client: flash ?? missingFlashClient, integratorFeeBps: env.FLASH_INTEGRATOR_FEE_BPS, tokens: flashChainFor(env).tokens });
  // Live cancels and stop moves are signed by the agent's message signer (EIP-191), and the signer must be the trading wallet.
  const orderControlFor = flash
    ? async (agent: Agent): Promise<OrderControl> => {
        const signer = await wallets.messageSignerFor(agent);
        if (signer.address.toLowerCase() !== agent.tradingWallet.toLowerCase()) {
          throw new Error(`message signer ${signer.address} does not match the agent trading wallet ${agent.tradingWallet}`);
        }
        return createOrderControl(flash, signer);
      }
    : null;

  let router: ZeroGRouter | null = null;
  const routerFor = (): ZeroGRouter => {
    if (!env.ZG_API_KEY) throw new Error("ZG_API_KEY is not set: no decision model is available");
    router ??= new ZeroGRouter({ apiKey: env.ZG_API_KEY, baseUrl: zgBaseUrl, payer: "platform" });
    return router;
  };

  // Per-agent 0G keys (provisioning step c). The router is rebuilt when an agent's stored key changes.
  const encryptionKey = env.AGENT_KEY_ENCRYPTION_KEY ? parseEncryptionKey(env.AGENT_KEY_ENCRYPTION_KEY) : null;
  const agentRouterFor = createAgentRouterFor({
    db,
    encryptionKey,
    platformRouter: routerFor,
    agentRouter: (apiKey) => new ZeroGRouter({ apiKey, baseUrl: zgBaseUrl, payer: "agent" }),
  });

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

  const rss = new RssCollector({ feeds: parseFeedList(env.INSIGHT_RSS_FEEDS), clock, logger });
  const insights = createInsightProducer({ db, clock, logger, budget, agentRouterFor, rss });
  const agentLock = new AgentLock();

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
    insights,
    orderControlFor,
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
    insights,
    agentLock,

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
      agentRouterFor,
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
