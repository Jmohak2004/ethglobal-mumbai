// WF2 crash-sentinel.
// Triggers: cron (every 2 min) and HTTP with JSON body { "simulate": "crash" | "caution" | "clear" }.
// Steps: 1) Chainlink short-window drawdown from recent rounds (DON), 2) CoinGecko 24h change and
// USDC price, median across nodes (node mode), 3) optional 0G LLM risk score (node mode, one node
// calls via cacheSettings, median), 4) assessRisk + applySimulation (lib/risk.ts), 5) writeReport
// of abi.encode(uint8 level, uint16 reasonCode, uint64 asOf) to RiskOracle.
import {
  CronCapability,
  EVMClient,
  HTTPCapability,
  HTTPClient,
  Runner,
  consensusMedianAggregation,
  ConsensusAggregationByFields,
  decodeJson,
  handler,
  median,
  ok,
  type CronPayload,
  type HTTPPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { z } from "zod";
import { AGGREGATOR_V3_ABI } from "../lib/abis.ts";
import { assertDeployed, makeEvmClient, nowSeconds, readFn, toAddress, writeReportTo } from "../lib/evm-io.ts";
import { encodeRiskReport } from "../lib/onchain.ts";
import {
  applySimulation,
  assessRisk,
  declineBpsFromPercent,
  depegBps,
  dropBpsFromWindow,
  parseRiskScore,
  parseSimulate,
  type RiskSignals,
  type RiskThresholds,
  type SimulateValue,
} from "../lib/risk.ts";

const configSchema = z.object({
  cronSchedule: z.string(),
  httpAuthorizedKeys: z.array(z.string()),
  /** Simulation payloads are only honored when true. Keep false in production. */
  allowSimulate: z.boolean(),
  chainSelectorName: z.string(),
  isTestnet: z.boolean(),
  riskOracle: z.string(),
  gasLimit: z.string(),
  feeds: z.object({ ETH_USD: z.string(), BTC_USD: z.string() }),
  /** Number of rounds before the latest used for the short-window drawdown. */
  lookbackRounds: z.number().int().min(1).max(20),
  coingeckoUrl: z.string(),
  thresholds: z.object({
    shortWindowCautionBps: z.number(),
    shortWindowHaltBps: z.number(),
    drop24hCautionBps: z.number(),
    drop24hHaltBps: z.number(),
    depegHaltBps: z.number(),
    llmCautionScore: z.number().min(0).max(1),
  }),
  llm: z.object({
    enabled: z.boolean(),
    /** 0G Router base URL, for example https://router-api.0g.ai/v1 (mainnet). */
    routerUrl: z.string(),
    model: z.string(),
    /** Operator-supplied context (for example a pasted headline batch). Sent with the market snapshot. */
    context: z.string(),
  }),
});

type Config = z.infer<typeof configSchema>;

interface MarketSnapshot {
  ethChange24hPct: number;
  btcChange24hPct: number;
  usdcPriceUsd: number;
}

interface RoundRead {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

// ---------- DON-level Chainlink reads ----------

function readRound(
  runtime: Runtime<Config>,
  evm: EVMClient,
  feed: Address,
  roundId: bigint | undefined,
): RoundRead {
  const r =
    roundId === undefined
      ? readFn(runtime, evm, feed, AGGREGATOR_V3_ABI, "latestRoundData")
      : readFn(runtime, evm, feed, AGGREGATOR_V3_ABI, "getRoundData", [roundId]);
  const [id, answer, , updatedAt] = r as [bigint, bigint, bigint, bigint, bigint];
  if (answer <= 0n) throw new Error(`feed ${feed} round ${id} has non-positive answer`);
  return { roundId: id, answer, updatedAt };
}

/** Drop (bps) of the latest answer from the peak of the previous `lookback` rounds. Missing rounds are skipped. */
function shortWindowDropBps(runtime: Runtime<Config>, evm: EVMClient, feed: Address, lookback: number): number {
  const latest = readRound(runtime, evm, feed, undefined);
  const window: bigint[] = [];
  for (let i = 1; i <= lookback; i++) {
    try {
      window.push(readRound(runtime, evm, feed, latest.roundId - BigInt(i)).answer);
    } catch (err) {
      // Phase boundaries and pruned rounds can revert. Using fewer rounds is acceptable.
      runtime.log(`feed ${feed}: round -${i} unavailable (${String(err)})`);
    }
  }
  return dropBpsFromWindow(latest.answer, window);
}

// ---------- node-mode external calls ----------

/** CoinGecko simple/price for ethereum, bitcoin and usd-coin. Each node returns numbers; the DON takes the median. */
function fetchMarket(nodeRuntime: NodeRuntime<unknown>, url: string): MarketSnapshot {
  const resp = new HTTPClient()
    .sendRequest(nodeRuntime, {
      url,
      method: "GET",
      headers: { Accept: "application/json" },
      cacheSettings: { store: true, maxAge: "30s" },
    })
    .result();
  if (!ok(resp)) throw new Error(`CoinGecko failed with status ${resp.statusCode}`);
  const body = JSON.parse(Buffer.from(resp.body).toString("utf-8")) as Record<string, Record<string, number | undefined>>;
  const eth = body.ethereum?.usd_24h_change;
  const btc = body.bitcoin?.usd_24h_change;
  const usdc = body["usd-coin"]?.usd;
  if (typeof eth !== "number" || typeof btc !== "number" || typeof usdc !== "number") {
    throw new Error("CoinGecko reply is missing ethereum/bitcoin 24h change or usd-coin price");
  }
  return { ethChange24hPct: eth, btcChange24hPct: btc, usdcPriceUsd: usdc };
}

/**
 * 0G Router chat completion that returns a numeric riskScore in [0,1]. Only one node should make the
 * call: the response is cached (store + maxAge), so the other nodes reuse it.
 */
function fetchLlmScore(
  nodeRuntime: NodeRuntime<unknown>,
  llm: Config["llm"],
  snapshotText: string,
  zgApiKey: string,
): number {
  const body = {
    model: llm.model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          'You score crypto market crash risk. Reply with JSON only: {"riskScore": <number from 0 to 1>}. ' +
          "0 means calm, 1 means imminent crash or stablecoin failure.",
      },
      { role: "user", content: `${llm.context}\n\nMarket snapshot:\n${snapshotText}` },
    ],
  };
  const resp = new HTTPClient()
    .sendRequest(nodeRuntime, {
      url: `${llm.routerUrl}/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${zgApiKey}` },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      cacheSettings: { store: true, maxAge: "300s" },
    })
    .result();
  if (!ok(resp)) throw new Error(`0G Router failed with status ${resp.statusCode}`);
  const reply = JSON.parse(Buffer.from(resp.body).toString("utf-8")) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = reply.choices?.[0]?.message?.content ?? "";
  const score = parseRiskScore(content);
  if (score === null) throw new Error("0G reply did not contain a riskScore in [0,1]");
  return score;
}

// ---------- sentinel run ----------

function runSentinel(runtime: Runtime<Config>, simulate: SimulateValue | undefined): string {
  const cfg = runtime.config;
  if (simulate !== undefined && !cfg.allowSimulate) {
    throw new Error("simulate payload received but allowSimulate is false for this config");
  }
  const asOf = nowSeconds(runtime);
  const evm = makeEvmClient(cfg.chainSelectorName, cfg.isTestnet);

  const ethFeed = toAddress(cfg.feeds.ETH_USD, "feeds.ETH_USD");
  const btcFeed = toAddress(cfg.feeds.BTC_USD, "feeds.BTC_USD");
  const shortEth = shortWindowDropBps(runtime, evm, ethFeed, cfg.lookbackRounds);
  const shortBtc = shortWindowDropBps(runtime, evm, btcFeed, cfg.lookbackRounds);

  const market = runtime
    .runInNodeMode(
      fetchMarket,
      ConsensusAggregationByFields<MarketSnapshot>({
        ethChange24hPct: median,
        btcChange24hPct: median,
        usdcPriceUsd: median,
      }),
    )(cfg.coingeckoUrl)
    .result();

  let llmScore: number | null = null;
  if (cfg.llm.enabled) {
    const snapshotText = `ETH 24h ${market.ethChange24hPct}%, BTC 24h ${market.btcChange24hPct}%, USDC $${market.usdcPriceUsd}`;
    try {
      // Secrets come from the DON runtime, then go into node mode as plain input.
      const zgApiKey = runtime.getSecret({ id: "ZG_API_KEY" }).result().value;
      llmScore = runtime
        .runInNodeMode(fetchLlmScore, consensusMedianAggregation<number>())(cfg.llm, snapshotText, zgApiKey)
        .result();
    } catch (err) {
      // The LLM is advisory. A failed call drops that signal and the sentinel still runs on the rest.
      runtime.log(`LLM signal skipped: ${String(err)}`);
    }
  }

  const signals: RiskSignals = {
    shortWindowDropBps: Math.max(shortEth, shortBtc),
    drop24hBps: Math.max(declineBpsFromPercent(market.ethChange24hPct), declineBpsFromPercent(market.btcChange24hPct)),
    usdcDeviationBps: depegBps(market.usdcPriceUsd),
    llmRiskScore: llmScore,
  };
  const thresholds: RiskThresholds = cfg.thresholds;
  const live = assessRisk(signals, thresholds);
  const final = applySimulation(live, simulate);
  runtime.log(
    `signals=${JSON.stringify(signals)} live=${live.level}/${live.reasonCode} ` +
      `final=${final.level}/${final.reasonCode} triggers=[${final.triggers.join("; ")}]`,
  );

  const riskOracle = assertDeployed(cfg.riskOracle, "riskOracle");
  const txHash = writeReportTo(runtime, evm, riskOracle, encodeRiskReport(final.level, final.reasonCode, asOf), cfg.gasLimit);
  runtime.log(`RiskOracle report written, tx ${txHash}`);
  return `level=${final.level} reason=${final.reasonCode} tx=${txHash}`;
}

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => runSentinel(runtime, undefined);

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const body = payload.input.length > 0 ? decodeJson(payload.input) : undefined;
  return runSentinel(runtime, parseSimulate(body));
};

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
