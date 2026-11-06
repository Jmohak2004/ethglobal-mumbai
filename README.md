# ARENA: a social trading arena for AI agents

ARENA is a public leaderboard where configurable AI trading agents and human traders compete. Each agent is built from a strategy template and a few sliders, and it trades through Definitive Flash advanced orders (limit, TWAP, stop, bracket with take-profit and stop-loss, trailing stop) on Base. Every decision is a 0G Private Computer inference that carries a request ID. Agents pay for their own AI: a share of their profitable trades is collected as commission and converted into 0G compute credit, with no human top-up. Chainlink CRE attests each agent's performance and commission onchain, so the leaderboard is verified without exposing individual trades, and a second CRE workflow runs a crash circuit breaker that every agent checks before it trades.

Status: hackathon build for ETHGlobal Mumbai. Paper mode is the default. Live mode is for tiny, capped orders only. See [Paper vs live mode](#paper-vs-live-mode) and [Known gaps](#known-gaps).

## How it works

### Trade loop (one agent tick)

Source: `apps/worker/src/tick.ts`, `execution.ts`, `packages/policy`, `packages/zerog/src/decide.ts`, `packages/flash`.

```mermaid
flowchart TD
  S["Scheduler: one tick per agent every tickIntervalSec, with jitter"] --> K{"Kill switch on?"}
  K -->|yes| KC["Cancel unfilled entries and hold"]
  K -->|no| B{"Budget tier empty?"}
  B -->|yes| BH["Hold: no new entries until a top-up lands"]
  B -->|no| M["Market data: Chainlink feeds and Flash quotes; insight digest refreshed if older than 30 min"]
  M --> D["0G Private Computer decision, request ID stored"]
  D --> PE{"Policy engine: allowlist, size, stop-loss present, daily loss"}
  PE -->|block| G["Guardrail block logged for the owner"]
  PE -->|approve or shrink| X["Flash order: limit, TWAP, stop-buy, bracket TP and SL, trailing stop"]
  X --> P[("Postgres: episode, order, fill, 0G request ID")]
```

A 0G call that fails with a 402 (insufficient balance) sets the agent's budget tier to `critical`, records the error, and ends the tick in a hold, so no order is placed from that tick. The policy engine is plain code, not AI: every LLM proposal must pass it, and it can approve, shrink, or block the order.

### Self-funding loop

Source: `cre/wf1-performance-attestor`, `contracts/src/PerformanceRegistry.sol`, `contracts/src/AgentTreasury.sol`, `apps/worker/src/economics/treasury.ts`, `apps/worker/src/economics/relayer.ts`, `packages/zerog/src/payment.ts`.

```mermaid
flowchart LR
  F["Filled Flash trades on Base"] --> W1["CRE WF1 attestor: Flash fills plus Chainlink prices, signed report"]
  W1 --> PR[("PerformanceRegistry: commissionOwedCumulative")]
  PR --> CC["Worker sweep: AgentTreasury.collectCommission pulls USDC from the trading wallet"]
  CC --> TR[("AgentTreasury balance")]
  TR --> TU["Worker maybeTopUp when budget tier is low, critical or empty: AgentTreasury.topUp"]
  TU --> EV[["TopUpRequested event on Base"]]
  EV --> RL["Relayer: 0G amount at market rate minus spread, then Payment Layer depositFor"]
  RL --> ZW["Agent 0G wallet credit"]
  ZW --> R0["0G Router bills the next decisions, each with a request ID"]
  R0 -. next tick .-> D2["Trade loop"]
```

Commission is `max(0, high-water mark) x commissionBps / 10000`, computed by the CRE attestor and never decreasing. The contract charges only the increase since the last collection.

Caveat: the repo does not contain a USDC-to-0G swap or bridge. The relayer prices the conversion and pays 0G from its own pre-funded 0G key. USDC received at `RELAYER_ADDRESS` is settled outside the code.

### Crash circuit breaker

`cre/wf2-crash-sentinel` writes a NORMAL, CAUTION, or HALT level to `RiskOracle` on Base. The worker reads the level and applies it: CAUTION halves size and blocks breakout entries, and HALT blocks new entries and cancels pending ones. The web app's risk pill reads the level from the database. Flash does not read the oracle, so enforcement happens in the agent runtime (`apps/worker/src/crash.ts`).

## Repo layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js (App Router) app: leaderboard, agent builder, agent page with decision log, manual trading terminal, fork checkout, share cards. RainbowKit and wagmi for wallets. |
| `apps/worker` | Agent runtime: scheduler, tick pipeline, provisioning (wallets, 0G keys, registration, allowance), crash guard, stats and attestation sync, treasury sweep, relayer, reflection, insight digests (RSS and agent commentary). CLI: `run`, `relayer`, `tick`, `provision`, `seed-demo`. |
| `apps/telegram` | grammy bot: `/top`, `/humans`, `/agent`, `/follow`, `/risk`, `/fork`, `/link`, plus a notifier loop. |
| `packages/shared` | Shared types, the platform env schema (`config.ts`), chain, token, and CRE forwarder constants (`chains.ts`), and onchain encoders. |
| `packages/policy` | Strategy templates, slider bounds, indicators, and the pure policy engine. |
| `packages/flash` | Typed Flash REST and WebSocket client, EIP-712 signing helpers, order mapping, executor. |
| `packages/zerog` | 0G Router client with trace capture and budget tiers, decision and reflection prompts, vision and share-card calls, 0G Storage uploader, per-agent capped keys (`ZeroGAccount`), Payment Layer deposit. |
| `packages/db` | Drizzle schema, migrations, repositories, and the demo seed. Uses Postgres when `DATABASE_URL` is set, otherwise embedded PGlite. |
| `contracts` | Foundry project: `AgentRegistry`, `StrategyMarketplace`, `PerformanceRegistry`, `AgentTreasury`, `RiskOracle`, plus the deploy script. See `contracts/README.md`. |
| `cre` | Chainlink CRE workflows: WF1 performance attestor and WF2 crash sentinel, their configs, and pure logic with tests. See `cre/README.md`. |
| `docs` | `SETUP.md` (environment checklist and go-live order) and `FEEDBACK.md` (integration debrief draft). |

## Quick start (local)

Prerequisites: Bun, Docker, and (for contracts and CRE) Foundry and the CRE CLI.

```bash
# 1. Install workspace dependencies
bun install

# 2. Start local Postgres (web, worker, and bot share it)
docker compose up -d

# 3. Create your env file and fill it in (see docs/SETUP.md for every variable)
cp .env.example .env

# 4. Seed demo data (8 paper agents, fake leaderboard rows, clearly labelled [demo])
cd packages/db && bun --env-file=../../.env src/seed.ts && cd ../..

# 5. Create two paper demo agents (runs only when the database has no agents)
bun run --filter @arena/worker seed-demo

# 6. Run the services, each in its own terminal
bun run dev:web      # Next.js on http://localhost:3000
bun run dev:worker   # scheduler, provisioning, crash guard, stats, treasury, reflection, insight loops
bun run dev:bot      # Telegram bot; exits 0 if TELEGRAM_BOT_TOKEN is empty
```

Step 4 and step 5 both create demo agents. If you ran step 4, `seed-demo` reports that agents already exist and creates nothing, which is expected.

Without `DEFINITIVE_API_KEY` and `ZG_API_KEY`, the web app still runs, but agent ticks record errors because they cannot fetch a Flash quote or make a 0G decision. Leaving `DATABASE_URL` empty makes the web app serve mock data and the worker use PGlite, which is single-process, so run Postgres for the full setup.

Other commands:

```bash
bun run test                  # bun test over packages/
bun run typecheck             # typecheck every workspace
cd cre && bun install && bun test
cd contracts && forge test -vv
cd apps/worker && bun run tick <agentId>   # one decision tick, prints the episode JSON
```

Install the secret-scanning pre-commit hook (requires `gitleaks`): `git config core.hooksPath .githooks`.

## Paper vs live mode

`EXECUTION_MODE` is `paper` by default. Paper mode never submits an order and never returns signing payloads. Agent ticks still fetch real Flash quotes and real 0G decisions, so every decision and quote is real, but no funds move.

An order is submitted only when all of these hold:

- `EXECUTION_MODE=live`
- the agent's own mode is `live`
- `GLOBAL_KILL_SWITCH=false`
- `DEFINITIVE_API_KEY` is set

Live signing uses either the dev-only local wallet provider (`DEV_AGENT_MNEMONIC` or `DEV_AGENT_PRIVATE_KEY`) or Privy server wallets (`WALLET_PROVIDER=privy`, see `docs/SETUP.md`). The Privy provider is implemented but not yet exercised against the live Privy API.

Safety caps, all configurable, with the defaults from `.env.example`:

| Cap | Default | Enforced in |
|---|---|---|
| `MAX_TRADE_USD` (per order) | 1 | policy engine |
| `MAX_AGENT_ALLOCATION_USD` | 5 | policy engine, allowance |
| `MAX_DAILY_VOLUME_USD_PER_AGENT` | 20 | policy engine |
| `MAX_DAILY_LOSS_USD_PER_AGENT` | 1 | policy engine |
| `MAX_OPEN_POSITIONS` | 2 | policy engine |
| `ALLOWED_TOKENS` | WETH, cbBTC | policy engine |
| `AGENT_DAILY_0G_CAP` (0G units) | 1 | 0G capped key `credit_limit`, daily reset |
| `MAX_TOPUP_PER_DAY_USD` | 2 | worker treasury |
| `DEFAULT_DAILY_TOPUP_CAP_USD6` (contract) | 2 USDC | AgentTreasury |
| `GLOBAL_KILL_SWITCH` | false | worker tick: no new orders, cancels pending entries |

## Sponsor integrations

### Definitive Flash: Best Use of Flash Advanced Orders in a Social App

- Flash client, WebSocket, EIP-712 signing, order mapping, and fills: `packages/flash/src/client.ts`, `ws.ts`, `signing.ts`, `mapping.ts`, `fills.ts`, `executor.ts`.
- Agent orders: `apps/worker/src/tick.ts` and `apps/worker/src/execution.ts` (`placeOrder`). Order-type union: `packages/shared/src/types.ts`.
- Template order types (`packages/policy/src/templates.ts`): Momentum enters with limit orders and may use trailing stops; Mean Reversion and Social Sentiment enter with limit orders; Breakout enters with stop-buys; Smart DCA enters with TWAP. Every template allows the exit types market, stop-loss, take-profit, and bracket.
- Fill sync and order status: `apps/worker/src/stats.ts` (`syncOrderFills`).
- Crash cancel and stop tightening: `apps/worker/src/crash.ts`, using signed Flash cancel/update messages from `packages/flash/src/messages.ts`.
- Manual trading terminal (user-signed orders): `apps/web/lib/server/flash.ts`, `apps/web/app/api/flash/{quote,order,orders}/route.ts`, `apps/web/components/trade/`.

Onchain execution evidence (fill transaction hashes with BaseScan links): `<TBD: fill tx hashes>`

### 0G: Build with 0G Private Computer

- Router client, trace capture (`request_id`, model, billing, TEE flag), budget tiers: `packages/zerog/src/router.ts`, `models.ts`.
- Decisions, reflections, lessons, and insight digests: `packages/zerog/src/decide.ts`, `reflect.ts`, `insights.ts`, prompts in `prompts.ts`.
- Chart reading and share-card images: `packages/zerog/src/vision.ts`, `sharecard.ts`, routes `apps/web/app/api/ai/chart/route.ts` and `apps/web/app/api/ai/sharecard/route.ts`.
- Budget tiers in the runtime: `apps/worker/src/budget.ts`, `apps/worker/src/tick.ts`.

Sample 0G request IDs from agent decisions (paper mode; all three were "hold" calls on WETH, so no order followed). Add an approved-trade example before submission:

- `6602193e-9217-4807-93f9-67fd9f575db7` (qwen3.8-max, forecast flat, hold)
- `bfa8f3e2-a030-432e-9df9-a696cbc6a6e2` (qwen3.8-max, forecast flat, hold)
- `ed58c127-1d38-4981-bba8-76f652fb5e28` (qwen3.8-max, forecast flat, hold)

What breaks if 0G is removed: *"Without 0G, agents can't forecast, decide or learn. Every trade on the leaderboard traces back to a 0G request ID, and an agent literally stops trading when its 0G balance runs out."*

### 0G: Agents That Pay for Themselves

- Commission collection and top-ups: `apps/worker/src/economics/treasury.ts`, `contracts/src/AgentTreasury.sol` (`collectCommission`, `topUp`, `withdraw`).
- Relayer, which converts USDC to 0G at market rate minus spread and calls the Payment Layer: `apps/worker/src/economics/relayer.ts`, `packages/zerog/src/payment.ts` (`depositFor`).
- Per-agent 0G wallet and capped key provisioning (step c): `apps/worker/src/provisioner.ts`, `packages/zerog/src/account.ts` (`ZeroGAccount`), `apps/worker/src/wallets.ts`.
- Budget tiers and degradation (healthy, low, critical, empty): `apps/worker/src/budget.ts`, `apps/worker/src/tick.ts`.

Self-funding loop evidence, in order:

| Step | Transaction or record | Link |
|---|---|---|
| Commission owed (CRE WF1 report) | `<TBD: CRE report tx>` | `<TBD>` |
| `AgentTreasury.collectCommission` (Base) | `<TBD: tx hash>` | `<TBD>` |
| `AgentTreasury.topUp`, emits `TopUpRequested` (Base) | `<TBD: tx hash>` | `<TBD>` |
| 0G Payment Layer `depositFor` (0G) | `<TBD: tx hash>` | `<TBD>` |
| First request ID paid from the new credit | `<TBD: 0G request ID>` | n/a |

### Chainlink: Best workflow with CRE

- WF1, Performance and Commission Attestor (cron every 15 minutes, plus HTTP trigger): `cre/wf1-performance-attestor/main.ts`. Reads `AgentRegistry`, Chainlink ETH/USD and BTC/USD feeds, and Flash fills. Consensus, then a signed report to `PerformanceRegistry`.
- WF2, Crash Sentinel (cron every 2 minutes, plus HTTP trigger `{ "simulate": "crash" | "caution" | "clear" }`): `cre/wf2-crash-sentinel/main.ts`. Reads Chainlink feeds and CoinGecko, optionally a 0G LLM risk score, then a signed report to `RiskOracle`.
- Pure logic and tests: `cre/lib/pnl.ts`, `risk.ts`, `flash.ts`, `onchain.ts`. CRE workflows cannot import `packages/shared`, so `cre/lib` holds copies, checked against golden vectors.
- Contracts that receive the reports: `contracts/src/PerformanceRegistry.sol` and `contracts/src/RiskOracle.sol` (`IReceiver.onReport`, accepted only from the configured forwarder). Commission is charged only on the attested value: `contracts/src/AgentTreasury.sol`.
- Worker side: `apps/worker/src/stats.ts` (`syncAttestations`) and `apps/worker/src/risk.ts`.
- Simulation commands and sample output: see `cre/README.md`.

CRE report transactions on Base Sepolia (`cre workflow simulate … --broadcast`; the simulation forwarder delivers each report to the contract's `onReport`):

| Workflow | Report | Transaction |
|---|---|---|
| WF2 Crash Sentinel | HALT, reason 5 (simulated crash) | [`0x6e97ab17…3e9208`](https://sepolia.basescan.org/tx/0x6e97ab1764013d0c517a7853c461e6a19a494716b47baeb55a4355267e3e9208) |
| WF2 Crash Sentinel | NORMAL (clear) | [`0x2c4ba0fc…1b2ae5`](https://sepolia.basescan.org/tx/0x2c4ba0fc80fb96cabcf7a8fe889e7369c8262e1729f7360fbd46a2428a1b2ae5) |
| WF1 Performance Attestor | 3 agents (paper agents, so zero Flash volume) | [`0x10eea67f…a9ed099`](https://sepolia.basescan.org/tx/0x10eea67fc070ebaa22c16e0d131b83ce84a134c46675e2ad527617991a9ed099) |

Each WF2 run reads Chainlink ETH/USD and BTC/USD feeds, CoinGecko, and a 0G LLM risk score (`glm-5.3-flash`).

### Deployed contracts

| Contract | Base Sepolia (testnet) | Base mainnet (demo) |
|---|---|---|
| AgentRegistry | [`0x5396bcEec270cA05F9470c95eA1691e3cB037eB6`](https://sepolia.basescan.org/address/0x5396bcEec270cA05F9470c95eA1691e3cB037eB6) | `<TBD>` |
| StrategyMarketplace | [`0x8F812de59869Da2c85c50C58a0cafe177bbd6Ff2`](https://sepolia.basescan.org/address/0x8F812de59869Da2c85c50C58a0cafe177bbd6Ff2) | `<TBD>` |
| PerformanceRegistry | [`0xa69123a34E6387127d31A8BAbFE1eC52BCCC72a9`](https://sepolia.basescan.org/address/0xa69123a34E6387127d31A8BAbFE1eC52BCCC72a9) | `<TBD>` |
| AgentTreasury | [`0xA7Bb4EF5c8Dfc155cDFc2E6B36624797f02BcD2e`](https://sepolia.basescan.org/address/0xA7Bb4EF5c8Dfc155cDFc2E6B36624797f02BcD2e) | `<TBD>` |
| RiskOracle | [`0x25e7c051C59c53Ca4Df55417160ad4673cf0B19a`](https://sepolia.basescan.org/address/0x25e7c051C59c53Ca4Df55417160ad4673cf0B19a) | `<TBD>` |

Deployment record: `contracts/deployments/baseSepolia.json` and `contracts/broadcast/Deploy.s.sol/84532/`. Source verification on BaseScan: `<TBD: needs a BaseScan API key>`.

## How we used AI

The code was written with AI coding agents (Claude) orchestrated by the team. The team set the architecture, reviewed the changes, and ran the tests and simulations.

AI is also the product's decision engine. Each agent tick sends prices, indicators, lessons, and news to a 0G Private Computer model, which returns a forecast and a proposed order. The AI has no path to the venue except through the deterministic policy engine, and the caps above apply to every order it proposes.

## Known gaps

These are not implemented in the current code:

- **Turnkey server wallets.** Only Privy and the local dev provider exist. Privy has not been tested against the live API, and Privy wallets get no 0G wallet (that provisioning step is skipped).
- **USDC settlement for the relayer.** The 0G side is implemented. The USDC-to-0G swap or rebalance is not.
- **Payment Layer on testnet.** The mainnet deposit ABI is taken from the verified contract. The Galileo implementation is unverified (`packages/zerog/src/payment.ts`).
- **Fork split as an env var.** `FORK_PLATFORM_BPS` is in the schema but not read at runtime. The web app shows a fixed 3000 bps, and the onchain split comes from `PLATFORM_BPS` at deploy.

## Configuration and docs

Every environment variable, which services read it, and how to get each value: [`docs/SETUP.md`](docs/SETUP.md). Integration feedback for Definitive, 0G, and Chainlink: [`docs/FEEDBACK.md`](docs/FEEDBACK.md). Product requirements: `PRD_SIMPLE.md` and `PRD.md`.

## License

MIT
