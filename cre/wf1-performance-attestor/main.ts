// WF1 performance-attestor.
// Triggers: cron (every 15 min) and HTTP ("attest now").
// Steps: 1) read active agents from AgentRegistry on Base (DON), 2) read mark prices from Chainlink
// feeds (DON), 3) node-mode: fetch each agent's filled orders + fills from Flash and compute metrics
// with lib/pnl.ts, 4) consensus on the encoded PerfEntry[] payload (identical across nodes),
// 5) runtime.report + writeReport to PerformanceRegistry.
import {
  CronCapability,
  EVMClient,
  HTTPCapability,
  HTTPClient,
  Runner,
  consensusIdenticalAggregation,
  handler,
  ok,
  type CronPayload,
  type HTTPPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { z } from "zod";
import { AGENT_REGISTRY_ABI, AGGREGATOR_V3_ABI } from "../lib/abis.ts";
import { ASSET_DECIMALS, ASSET_MARK_FEED, ZERO_ADDRESS } from "../lib/chains.ts";
import { assertDeployed, makeEvmClient, nowSeconds, readFn, toAddress, writeReportTo } from "../lib/evm-io.ts";
import { parseListOrders, parseOrderFills, toPnlFills, type FlashOrder } from "../lib/flash.ts";
import { computeAgentMetrics, type Fill, type Mark } from "../lib/pnl.ts";
import { decodePerfReport, encodePerfReport, humanAgentId, toPerfEntry, type PerfEntry } from "../lib/onchain.ts";
import { feedAnswerToUsd6 } from "../lib/units.ts";

const configSchema = z.object({
  cronSchedule: z.string(),
  httpAuthorizedKeys: z.array(z.string()),
  chainSelectorName: z.string(),
  isTestnet: z.boolean(),
  agentRegistry: z.string(),
  performanceRegistry: z.string(),
  /** Chainlink ETH/USD and BTC/USD feeds on the same chain. */
  feeds: z.object({ ETH_USD: z.string(), BTC_USD: z.string() }),
  /** A feed answer older than this (seconds, relative to the DON clock) is not used for marks. */
  maxFeedAgeSec: z.number().int().positive(),
  flashApiUrl: z.string(),
  /** Hard cap on Flash list pages per agent. The run fails rather than report a partial history. */
  maxFlashPages: z.number().int().positive(),
  /** Extra "human" trading wallets for the Humans board. Commission is 0 for humans. */
  humanWallets: z.array(z.string()),
  gasLimit: z.string(),
});

type Config = z.infer<typeof configSchema>;

interface AgentRow {
  agentId: `0x${string}`;
  tradingWallet: `0x${string}`;
  commissionBps: number;
}

interface BatchInput {
  /** Fetched on the DON with runtime.getSecret (secrets are not available inside node mode). */
  flashApiKey: string;
  agents: AgentRow[];
  marks: Record<string, Mark>;
  asOf: bigint;
  flashApiUrl: string;
  maxFlashPages: number;
}

const FLASH_STATUS_FILLED = "ORDER_STATUS_FILLED";
const FLASH_PAGE_SIZE = 200;

// ---------- DON-level reads ----------

function readActiveAgents(runtime: Runtime<Config>, evm: EVMClient, cfg: Config): AgentRow[] {
  const registry = assertDeployed(cfg.agentRegistry, "agentRegistry");
  const ids = readFn(runtime, evm, registry, AGENT_REGISTRY_ABI, "listActive") as readonly `0x${string}`[];
  const rows: AgentRow[] = [];
  for (const id of ids) {
    const agent = readFn(runtime, evm, registry, AGENT_REGISTRY_ABI, "getAgent", [id]);
    if (!agent.active) continue;
    if (agent.tradingWallet.toLowerCase() === ZERO_ADDRESS) {
      runtime.log(`skip agent ${id}: tradingWallet is unset`);
      continue;
    }
    rows.push({ agentId: id, tradingWallet: agent.tradingWallet, commissionBps: Number(agent.commissionBps) });
  }
  for (const wallet of cfg.humanWallets) {
    const addr = toAddress(wallet, "humanWallets[]");
    rows.push({ agentId: humanAgentId(addr), tradingWallet: addr, commissionBps: 0 });
  }
  rows.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return rows;
}

function readMarks(runtime: Runtime<Config>, evm: EVMClient, cfg: Config, asOf: bigint): Record<string, Mark> {
  const feedByKey: Record<"ETH_USD" | "BTC_USD", string> = { ETH_USD: cfg.feeds.ETH_USD, BTC_USD: cfg.feeds.BTC_USD };
  const marks: Record<string, Mark> = {};
  for (const [ticker, feedKey] of Object.entries(ASSET_MARK_FEED).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const feed = toAddress(feedByKey[feedKey], `feeds.${feedKey}`);
    const [, answer, , updatedAt] = readFn(runtime, evm, feed, AGGREGATOR_V3_ABI, "latestRoundData");
    const decimals = Number(readFn(runtime, evm, feed, AGGREGATOR_V3_ABI, "decimals"));
    if (asOf - BigInt(updatedAt) > BigInt(cfg.maxFeedAgeSec)) {
      runtime.log(`mark for ${ticker} skipped: feed ${feedKey} is older than ${cfg.maxFeedAgeSec}s`);
      continue;
    }
    const assetDecimals = ASSET_DECIMALS[ticker];
    if (assetDecimals === undefined) throw new Error(`no decimals configured for ${ticker}`);
    marks[ticker] = { priceUsd6: feedAnswerToUsd6(answer as bigint, decimals), decimals: assetDecimals };
  }
  return marks;
}

// ---------- node-mode (runs on every DON node; output must be identical) ----------

function getJson(nodeRuntime: NodeRuntime<unknown>, url: string, apiKey: string): unknown {
  const resp = new HTTPClient()
    .sendRequest(nodeRuntime, {
      url,
      method: "GET",
      headers: { "x-definitive-api-key": apiKey, Accept: "application/json" },
      // Lets the other nodes reuse the first node's response, so all nodes see the same fill snapshot.
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  if (!ok(resp)) throw new Error(`Flash GET ${url.split("?")[0]} failed with status ${resp.statusCode}`);
  return JSON.parse(Buffer.from(resp.body).toString("utf-8"));
}

function listFilledOrders(nodeRuntime: NodeRuntime<unknown>, input: BatchInput, wallet: string, apiKey: string): FlashOrder[] {
  const orders: FlashOrder[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < input.maxFlashPages; page++) {
    let url =
      `${input.flashApiUrl}/orders?funderAddress=${encodeURIComponent(wallet)}` +
      `&statuses=${FLASH_STATUS_FILLED}&pageSize=${FLASH_PAGE_SIZE}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const parsed = parseListOrders(getJson(nodeRuntime, url, apiKey));
    orders.push(...parsed.orders);
    if (!parsed.nextPageToken) return orders;
    pageToken = parsed.nextPageToken;
  }
  throw new Error(`more than ${input.maxFlashPages} Flash pages for ${wallet}; raise maxFlashPages`);
}

function fillsForAgent(nodeRuntime: NodeRuntime<unknown>, input: BatchInput, wallet: string, apiKey: string): Fill[] {
  const fills: Fill[] = [];
  for (const order of listFilledOrders(nodeRuntime, input, wallet, apiKey)) {
    const url =
      `${input.flashApiUrl}/orders/${encodeURIComponent(order.orderId)}` + `?funderAddress=${encodeURIComponent(wallet)}`;
    const raw = parseOrderFills(getJson(nodeRuntime, url, apiKey));
    fills.push(...toPnlFills(order, raw).fills);
  }
  return fills;
}

/**
 * Node-mode computation. Returns the ABI-encoded PerfEntry[] as hex. Consensus is identical-match,
 * so every node must produce byte-identical output. Inputs (asOf, marks, agent list) come from the
 * DON level and are the same on every node.
 */
function computeBatch(nodeRuntime: NodeRuntime<unknown>, input: BatchInput): `0x${string}` {
  const entries: PerfEntry[] = input.agents.map((agent) => {
    const fills = fillsForAgent(nodeRuntime, input, agent.tradingWallet, input.flashApiKey);
    const metrics = computeAgentMetrics(fills, { marks: input.marks, forecastHitRateBps: 0 });
    return toPerfEntry({ agentId: agent.agentId, metrics, commissionBps: agent.commissionBps, asOf: input.asOf });
  });
  return encodePerfReport(entries);
}

// ---------- attestation ----------

function attest(runtime: Runtime<Config>): string {
  const cfg = runtime.config;
  const asOf = nowSeconds(runtime);
  const evm = makeEvmClient(cfg.chainSelectorName, cfg.isTestnet);

  const agents = readActiveAgents(runtime, evm, cfg);
  if (agents.length === 0) {
    runtime.log("no active agents; nothing to attest");
    return "no-agents";
  }
  const marks = readMarks(runtime, evm, cfg, asOf);
  runtime.log(`attesting ${agents.length} agents; marks=${Object.keys(marks).sort().join(",") || "none"}`);

  const input: BatchInput = {
    flashApiKey: runtime.getSecret({ id: "FLASH_API_KEY" }).result().value,
    agents,
    marks,
    asOf,
    flashApiUrl: cfg.flashApiUrl,
    maxFlashPages: cfg.maxFlashPages,
  };
  const encoded = runtime
    .runInNodeMode(computeBatch, consensusIdenticalAggregation<`0x${string}`>())(input)
    .result();

  for (const e of decodePerfReport(encoded)) {
    runtime.log(
      `agent ${e.agentId} realizedPnlUsd6=${e.realizedPnlUsd6} volumeUsd6=${e.volumeUsd6} trades=${e.trades} ` +
        `winRateBps=${e.winRateBps} maxDdBps=${e.maxDrawdownBps} hwmUsd6=${e.hwmUsd6} ` +
        `commissionOwedUsd6=${e.commissionOwedCumulativeUsd6}`,
    );
  }

  const receiver = assertDeployed(cfg.performanceRegistry, "performanceRegistry") as Address;
  const txHash = writeReportTo(runtime, evm, receiver, encoded, cfg.gasLimit);
  runtime.log(`PerformanceRegistry report written, tx ${txHash}`);
  return txHash;
}

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => attest(runtime);
const onHttpTrigger = (runtime: Runtime<Config>, _payload: HTTPPayload): string => attest(runtime);

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();
  return [
    handler(cron.trigger({ schedule: config.cronSchedule }), onCronTrigger),
    handler(
      http.trigger({
        authorizedKeys: config.httpAuthorizedKeys.map((publicKey) => ({
          type: "KEY_TYPE_ECDSA_EVM" as const,
          publicKey,
        })),
      }),
      onHttpTrigger,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
