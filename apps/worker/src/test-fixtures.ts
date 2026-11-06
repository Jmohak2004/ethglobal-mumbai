// Shared fakes for the worker tests. No network, no real keys (keys are generated per run), no real orders.

import { createAgent, createDb, insertFills, migrate, upsertOrder, type Db, type OrderRecord } from "@arena/db";
import type { ExecutionResult, OrderControl, OrderSigner, QuoteResponse } from "@arena/flash";
import { computeIndicators, configHash, defaultConfig } from "@arena/policy";
import {
  globalLimitsFromEnv,
  type Agent,
  type BudgetTier,
  type Candle,
  type ExecutionMode,
  type GlobalLimits,
  type MarketSnapshot,
  type OrderIntent,
  type RiskLevel,
  type StrategyConfig,
  type TemplateId,
} from "@arena/shared";
import { ZeroGRouter } from "@arena/zerog";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Clock, Deps, BudgetReading, BudgetSource, MarketData, RiskSource } from "./deps.ts";
import { loadWorkerEnv } from "./env.ts";
import { silentLogger } from "./logger.ts";
import { LocalWalletProvider } from "./wallets.ts";

export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

export function fixedClock(start = NOW): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

export async function memoryDb(): Promise<Db> {
  const db = createDb({ memory: true });
  await migrate(db);
  return db;
}

export function globalLimits(overrides: Partial<GlobalLimits> = {}): GlobalLimits {
  return { ...globalLimitsFromEnv(loadWorkerEnv({})), ...overrides };
}

/** Oldest-first candles drifting from price*0.98 up to price*1.02. */
export function candlesAround(price: number, n = 60): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = price * (0.98 + (0.04 * i) / n);
    return { t: NOW - (n - i) * 300_000, o: c * 0.999, h: c * 1.002, l: c * 0.998, c, v: 10 };
  });
}

export function snapshotFor(asset: string, price: number): MarketSnapshot {
  const candles = candlesAround(price);
  return { asset, priceUsd: price, ts: NOW, candles, indicators: computeIndicators(candles) };
}

export interface FakeMarket extends MarketData {
  /** Assets whose snapshots were requested. */
  requested: string[];
  setPrice(asset: string, price: number): void;
  failAsset(asset: string): void;
}

export function fakeMarket(prices: Record<string, number>): FakeMarket {
  const current = { ...prices };
  const failing = new Set<string>();
  const market: FakeMarket = {
    requested: [],
    setPrice(asset, price) {
      current[asset] = price;
    },
    failAsset(asset) {
      failing.add(asset);
    },
    async getSnapshot(asset) {
      market.requested.push(asset);
      const price = current[asset];
      if (failing.has(asset) || price === undefined) throw new Error(`no market data for ${asset}`);
      return snapshotFor(asset, price);
    },
    async getPrice(asset) {
      const price = current[asset];
      if (failing.has(asset) || price === undefined) throw new Error(`no price for ${asset}`);
      return price;
    },
  };
  return market;
}

/** Risk source whose level and report time (asOf, unix ms) can be changed between checks. */
export function fakeRisk(level: RiskLevel = "NORMAL", asOf: number | null = NOW): RiskSource & { level: RiskLevel; asOf: number | null } {
  const source = {
    level,
    asOf,
    async current() {
      return source.level;
    },
    async reading() {
      return { level: source.level, asOf: source.asOf };
    },
  };
  return source;
}

export interface FakeOrderControl extends OrderControl {
  /** Order ids cancelled, in call order. */
  cancels: string[];
  /** Stop moves, in call order. stopLossPrice is the plain decimal string passed to tightenStop. */
  stops: Array<{ orderId: string; stopLossPrice: string }>;
  /** Makes the next call with this order id throw. */
  failOn: Set<string>;
}

/** Records live cancel and stop calls without touching Flash or signing anything. */
export function fakeOrderControl(): FakeOrderControl {
  const control: FakeOrderControl = {
    cancels: [],
    stops: [],
    failOn: new Set(),
    async cancel(orderId) {
      if (control.failOn.has(orderId)) throw new Error(`flash rejected cancel for ${orderId}`);
      control.cancels.push(orderId);
      return { ok: true };
    },
    async cancelMany() {
      throw new Error("batch cancel is not used by these tests");
    },
    async tightenStop(orderId, stopLossPrice) {
      if (control.failOn.has(orderId)) throw new Error(`flash rejected stop change for ${orderId}`);
      control.stops.push({ orderId, stopLossPrice });
      return { ok: true };
    },
  };
  return control;
}

export interface FakeBudget extends BudgetSource {
  tier: BudgetTier;
  marks: Array<{ agentId: string; reason: string }>;
}

export function fakeBudget(tier: BudgetTier = "healthy"): FakeBudget {
  const budget: FakeBudget = {
    tier,
    marks: [],
    async forAgent(): Promise<BudgetReading> {
      return { tier: budget.tier, balance: 1, dailyBurn: 0, source: "estimate" };
    },
    markCritical(agentId, reason) {
      budget.marks.push({ agentId, reason });
      budget.tier = "critical";
    },
  };
  return budget;
}

export interface ExecCall {
  intent: OrderIntent;
  mode: ExecutionMode;
  funder: string;
  referencePriceUsd: number | undefined;
}

/** Records every execute call and answers like FlashExecutor would, without touching Flash. */
export class FakeExecutor {
  readonly calls: ExecCall[] = [];
  nextOrderId = 1;
  constructor(private readonly ts = NOW) {}

  async execute(intent: OrderIntent, signer: OrderSigner, mode: ExecutionMode, opts: { referencePriceUsd?: number } = {}): Promise<ExecutionResult> {
    this.calls.push({ intent, mode, funder: signer.address, referencePriceUsd: opts.referencePriceUsd });
    const quote = { quoteId: `quote-${this.nextOrderId}`, fees: { estimatedFeeNotional: "0.01" } } as unknown as QuoteResponse;
    const orderId = `${mode === "paper" ? "paper-" : "flash-"}order-${this.nextOrderId++}`;
    if (mode === "paper") {
      return {
        paper: true,
        orderId: `paper-${quote.quoteId}`,
        status: "simulated_fill",
        quote,
        fill: { qty: intent.notionalUsd / 2000, price: 2000, notionalUsd: intent.notionalUsd, ts: this.ts },
      };
    }
    return { paper: false, orderId, status: "submitted", quote, attachedBracketStatus: null };
  }
}

export interface RouterStub {
  router: ZeroGRouter;
  requests: Array<Record<string, unknown>>;
}

/** A real ZeroGRouter whose HTTP layer is replaced by `respond`. Records every request body. */
export function routerWith(respond: (body: Record<string, unknown>, index: number) => Response): RouterStub {
  const requests: Array<Record<string, unknown>> = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    return respond(body, requests.length - 1);
  };
  const router = new ZeroGRouter({ apiKey: "sk-test", baseUrl: "https://router.test/v1", payer: "platform", fetch: fetchFn });
  return { router, requests };
}

/** OpenAI-shaped completion carrying `content` and an x_0g_trace block. */
export function completion(content: string, requestId = "req-test-1"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      x_0g_trace: { request_id: requestId, provider: "0xprovider", billing: "0.01", tee_verified: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function apiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, code: "insufficient_balance" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A buy on WETH that the policy approves at the given mark (default template sliders, $1 notional). */
export function buyReply(markPrice: number, confidence = 0.8): string {
  return JSON.stringify({
    forecast: { asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 1, confidence },
    proposal: {
      action: "buy",
      asset: "WETH",
      orderType: "limit",
      sizePct: 0.2,
      limitPrice: Number((markPrice * 0.999).toFixed(2)),
      takeProfitPct: 4,
      stopLossPct: 2,
      rationale: "test entry",
    },
  });
}

export const HOLD_REPLY = JSON.stringify({
  forecast: null,
  proposal: { action: "hold", rationale: "no edge" },
});

export interface AgentOptions {
  template?: TemplateId;
  mode?: ExecutionMode;
  status?: Agent["status"];
  assets?: string[];
  config?: Partial<StrategyConfig>;
  tradingWallet?: `0x${string}`;
  zgWallet?: `0x${string}` | null;
  name?: string;
}

/** Inserts an agent row and returns it. The trading wallet defaults to a freshly generated address. */
export async function seedAgent(db: Db, opts: AgentOptions = {}): Promise<Agent> {
  const global = globalLimits();
  const base = defaultConfig(opts.template ?? "momentum", {
    assets: opts.assets ?? ["WETH"],
    commissionBps: 1000,
    global,
  });
  const config: StrategyConfig = { ...base, ...opts.config };
  const id = crypto.randomUUID();
  const tradingWallet = opts.tradingWallet ?? privateKeyToAccount(generatePrivateKey()).address;
  return createAgent(db, {
    id,
    name: opts.name ?? "test agent",
    ownerAddress: "0x1111111111111111111111111111111111111111",
    tradingWallet,
    zgWallet: opts.zgWallet ?? null,
    config,
    configHash: configHash(config),
    mode: opts.mode ?? "paper",
    status: opts.status ?? "active",
    createdAt: NOW - 3 * 24 * 60 * 60 * 1000,
  });
}

export interface PaperFillSpec {
  id: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  ts: number;
  asset?: string;
  feeUsd?: number;
  /** Entry bracket, stored on the order the way execution.ts stores it. */
  bracket?: { takeProfitPrice: number; stopLossPrice: number };
  /** Set on TP/SL exits: the bracket order this sell closes. */
  closesOrderId?: string;
}

/** Inserts a paper order and its simulated fill, shaped like execution.ts orderRows() for a paper fill. */
export async function seedPaperFill(db: Db, agent: Agent, spec: PaperFillSpec): Promise<void> {
  const notionalUsd = spec.qty * spec.price;
  const record: OrderRecord = {
    id: spec.id,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: spec.side,
    asset: spec.asset ?? "WETH",
    orderType: "market",
    notionalUsd,
    status: "simulated_fill",
    raw: {
      paper: true,
      attachedBracket: spec.bracket ?? null,
      ...(spec.closesOrderId ? { closesOrderId: spec.closesOrderId, exit: true } : {}),
    },
    createdAt: spec.ts,
    updatedAt: spec.ts,
  };
  await upsertOrder(db, record);
  await insertFills(db, [
    {
      id: `${spec.id}:fill`,
      orderId: spec.id,
      price: spec.price,
      qty: spec.qty,
      notionalUsd,
      feeUsd: spec.feeUsd ?? 0,
      integratorFeeUsd: 0,
      txId: null,
      ts: spec.ts,
    },
  ]);
}

/** A wallet provider whose keys are generated for this process only. */
export function testWallets(): LocalWalletProvider {
  return new LocalWalletProvider({ privateKey: generatePrivateKey() });
}

export function deps(overrides: Partial<Deps> & { db: Db }): Deps {
  return {
    clock: fixedClock(),
    logger: silentLogger,
    executionMode: "paper",
    globalLimits: globalLimits(),
    market: fakeMarket({ WETH: 2000, cbBTC: 60000 }),
    risk: fakeRisk("NORMAL"),
    budget: fakeBudget("healthy"),
    wallets: testWallets(),
    executor: new FakeExecutor(),
    routerFor: () => {
      throw new Error("no router configured for this test");
    },
    ...overrides,
  };
}
