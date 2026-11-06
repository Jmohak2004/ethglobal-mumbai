# arena-cre: Chainlink CRE workflows

Two CRE workflows for the social trading arena (Definitive Flash on Base):

| Workflow | Triggers | Writes to | Purpose |
|---|---|---|---|
| `wf1-performance-attestor` (WF1) | cron `*/15 * * * *`, HTTP ("attest now") | `PerformanceRegistry` (Base) | Verified per-agent PnL, volume, trades, win rate, max drawdown, HWM and commission owed |
| `wf2-crash-sentinel` (WF2) | cron `*/2 * * * *`, HTTP `{ "simulate": "crash" \| "caution" \| "clear" }` | `RiskOracle` (Base) | NORMAL / CAUTION / HALT risk light |

Pure logic lives in `lib/` and is unit-tested with `bun test`. Chain-facing code lives in each workflow's `main.ts`.

## Layout

```
cre/
  project.yaml            CRE targets (staging-settings = Base Sepolia, production-settings = Base)
  secrets.yaml            secret ids only (values come from .env)
  package.json            arena-cre; @chainlink/cre-sdk ~1.23.0, viem, zod
  tsconfig.json
  .env.example            copy to cre/.env (git-ignored)
  lib/
    pnl.ts  risk.ts  flash.ts  units.ts     pure logic (+ *.test.ts)
    onchain.ts              report encodings, copied from packages/shared/src/onchain.ts
    chains.ts  abis.ts      addresses, selectors, ABIs (copied from packages/shared)
    evm-io.ts               SDK-facing EVM read/write helpers
  wf1-performance-attestor/ main.ts, workflow.yaml, config.{staging,production}.json
  wf2-crash-sentinel/       main.ts, workflow.yaml, config.{staging,production}.json, payloads/*.json
```

The workflows cannot import `packages/shared` (CRE compiles them separately), so `lib/onchain.ts` and `lib/chains.ts` are copies. `lib/onchain.test.ts` checks the copy against golden vectors generated from the shared encoder. If the shared encoding changes, update the copy and the vectors together.

## Setup

1. Install dependencies inside `cre/` only (this directory is not part of the root bun workspace):
   ```bash
   cd cre
   bun install
   bun x cre-setup          # SDK step: downloads the Javy compiler (sha256-verified)
   ```
2. CRE CLI (optional, needed for `simulate`). Official install, with checksum verification before running:
   ```bash
   tag=$(curl -fsSL https://api.github.com/repos/smartcontractkit/cre-cli/releases/latest | grep -Eo '"tag_name":\s*"[^"]+"' | head -n1 | grep -Eo 'v[0-9][^"]*')
   base="https://github.com/smartcontractkit/cre-cli/releases/download/$tag"
   curl -fsSL "$base/install.sh" -o install.sh && curl -fsSL "$base/checksums.txt" -o checksums.txt
   # compare the sha256 of install.sh with the install.sh line in checksums.txt, read it, then:
   bash install.sh
   ```
   The installer adds `CRE_INSTALL` and PATH lines to your shell rc file. Review that before running it.
3. Log in once (opens a browser; not automated here):
   ```bash
   cre login
   ```
4. Create `cre/.env` from `.env.example`:
   - `CRE_ETH_PRIVATE_KEY`: needed for `--broadcast` writes (Base Sepolia ETH). A dummy key works for dry runs.
   - `FLASH_API_KEY`: read-only Definitive Flash key. It cannot move funds.
   - `ZG_API_KEY`: 0G Router key. Only used if `llm.enabled` is true in WF2 config.
5. Fill in deployed addresses in the config files (`agentRegistry`, `performanceRegistry`, `riskOracle`). They are zero placeholders until deployed. The workflow fails fast on zero addresses.

## Simulate

Run from `cre/`. The target chooses config, RPCs, and secrets.

```bash
# WF1 (trigger index 0 = cron, 1 = HTTP)
cre workflow simulate wf1-performance-attestor --target staging-settings
cre workflow simulate wf1-performance-attestor --target staging-settings --broadcast
cre workflow simulate wf1-performance-attestor --non-interactive --trigger-index 1 --target staging-settings

# WF2 HTTP trigger with a simulate payload
cre workflow simulate wf2-crash-sentinel --non-interactive --trigger-index 1 \
  --http-payload @wf2-crash-sentinel/payloads/simulate-crash.json --target staging-settings
cre workflow simulate wf2-crash-sentinel --non-interactive --trigger-index 1 \
  --http-payload @wf2-crash-sentinel/payloads/simulate-caution.json --target staging-settings
cre workflow simulate wf2-crash-sentinel --non-interactive --trigger-index 1 \
  --http-payload @wf2-crash-sentinel/payloads/simulate-clear.json --target staging-settings

# Add --broadcast to any of the above to submit the onchain write (mock forwarder).
```

Without `--broadcast` the simulator does a dry run. Simulation needs `cre login`.

## Compile without the CLI

```bash
bun run typecheck        # tsc --noEmit
bun test                 # pure-logic and encoding tests
bun run compile:wf1      # cre-compile -> wf1-performance-attestor/dist/workflow.wasm
bun run compile:wf2      # cre-compile -> wf2-crash-sentinel/dist/workflow.wasm
```

`cre-compile` is the SDK compile path. It runs type checks, the runtime-compatibility check (no `fetch`, `setTimeout`, `node:*`), and the determinism check (no `Date.now()`, `new Date()` without args).

## What each workflow does

### WF1 performance-attestor
1. DON: `AgentRegistry.listActive()` and `getAgent(id)` on Base. Skips inactive agents and unset trading wallets. Adds `humanWallets` with commission 0.
2. DON: `latestRoundData` for ETH/USD and BTC/USD (mark prices for unrealized PnL). Feeds older than `maxFeedAgeSec` are skipped.
3. Node mode, per agent: `GET /orders?funderAddress=…&statuses=ORDER_STATUS_FILLED` (paged), then `GET /orders/{id}` for each order's fills. Computes FIFO realized PnL, volume, trades, win rate, max drawdown, HWM, and commission owed (`lib/pnl.ts`).
4. Consensus: `consensusIdenticalAggregation` over the ABI-encoded `PerfEntry[]`. Every node must produce identical bytes.
5. `runtime.report` then `evmClient.writeReport` to `PerformanceRegistry`. Fails on a non-success tx status or a reverted `onReport`.

### WF2 crash-sentinel
1. DON: short-window drop from the latest ETH/USD and BTC/USD rounds plus the previous `lookbackRounds` (`getRoundData`).
2. Node mode: CoinGecko `simple/price` for ethereum, bitcoin, usd-coin. Median across nodes for 24h change and USDC price.
3. Optional (`llm.enabled`): 0G Router chat completion that returns `riskScore` in [0,1]. The response is cached (`cacheSettings`) so other nodes can reuse it. The docs call this best-effort, so duplicate calls are possible. Failures drop only this signal.
4. `assessRisk` (`lib/risk.ts`). Priority: USDC depeg above 1% → HALT/Depeg (3). Price drop at or above 5% short-window or 10% 24h → HALT/PriceDrop (1). Drop at or above 2.5% / 5% → CAUTION/Volatility (2). LLM score ≥ 0.8 → CAUTION/News (4). Otherwise NORMAL/None (0).
5. `simulate` overrides the level and sets reason 5 (ManualSimulation). Honored only when `allowSimulate` is true (staging only).
6. `runtime.report` then `writeReport` to `RiskOracle` with `abi.encode(uint8 level, uint16 reasonCode, uint64 asOf)`.

## Consuming the outputs

- Leaderboard: decode `PerformanceRegistry` reports per `agentId` (`decodePerfReport` in `lib/onchain.ts` mirrors the Solidity struct). Verified stats only, linked to the report tx.
- `AgentTreasury.collectCommission`: read `commissionOwedCumulativeUsd6`. It is `max(0, hwm) × commissionBps / 10000`, and it never decreases.
- Agents: read `RiskOracle` before every order. NORMAL trades normally. CAUTION halves size and blocks breakout entries. HALT blocks new entries. Flash does not read the oracle, so enforcement is in the agent runtime.

## Day-1 checklist (unverified assumptions)

- **Flash units.** Assumed: `targetAmount` is a human-unit decimal string of the traded asset, and `notional` and `feeNotional` are USD. Verify with one real order and fix `toPnlFills` in `lib/flash.ts` if not.
- **Flash side semantics.** Assumed: `targetAsset` is the traded (base) asset for both buys and sells, and `contraAsset` is the USD quote.
- **Flash rate limit.** 5 req/s per endpoint per key. WF1 makes one detail call per filled order, so large histories will need pacing or caching.
- **Feeds.** The Base mainnet feed addresses in `config.production.json` and `lib/chains.ts` are marked VERIFY. ETH/USD was partially confirmed against a Chainlink page. BTC/USD was not confirmed. Staging (Base Sepolia) addresses are copied from the monorepo and not re-checked.
- **Forwarder.** Confirm that `--broadcast` simulation calls `onReport` through the mock forwarder (PRD §7.3 day-1 spike). Deployed receivers must accept the production KeystoneForwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`.
- **0G model.** `llm.model` is a placeholder. Set it from the 0G Router model list. Confirm the response shape (`choices[0].message.content`).
- **HTTP trigger auth.** `httpAuthorizedKeys` is empty in the committed configs. Add operator EVM addresses before deploying. The HTTP trigger docs say an empty config is accepted only for simulation. Confirm the simulate path with a real `cre workflow simulate` run (not done here, since it needs login).
- **Consensus on WF1.** `identical` requires every node to see the same fills. Use the cached GETs (60 s) to keep nodes aligned. If they still diverge, the run fails and nothing is written. That is the intended fail-safe.

## Deviations from the spec

- Flash: the list endpoint returns orders without fills. Fills come from `GET /orders/{orderId}`. The status filter value is `ORDER_STATUS_FILLED`, not `filled`.
- Cron: the docs define the optional 6th cron field as seconds, so the PRD's `"0 */15 * * * *"` is ambiguous. Committed configs use 5-field expressions.
- Secrets: SDK 1.23 `NodeRuntime` has no `getSecret`. Secrets are read on the DON runtime and passed into node mode as input.
- Production forwarder: `config.production.json` records the production KeystoneForwarder. The mock `0x5e34…` is simulation-only.
- HWM and drawdown: HWM starts at 0. Drawdown is a percentage of the running peak. A loss with no profit peak counts as 10000 bps.
- WF2 `clear` reports reason 5 (ManualSimulation), like the other simulate values.
- `simulate` is disabled in `config.production.json` (`allowSimulate: false`).
- 0G Router: production uses `https://router-api.0g.ai/v1`, staging uses the testnet router from `packages/shared/src/chains.ts`.
- `forecastHitRateBps` is always 0 (no forecast source yet). Unrealized PnL is computed and logged but not written, because `PerfEntry` has no field for it.
