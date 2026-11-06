# Setup checklist

Everything the team must fill in before testing or demoing ARENA. Each variable is listed with the service that reads it, where it is read, and how to get the value.

Stages used in the tables:

- **L**: local test (docker Postgres, paper mode, no chain writes)
- **T**: testnet rehearsal (Base Sepolia, 0G testnet, CRE simulation with `--broadcast` to testnet)
- **D**: live demo (Base mainnet, 0G mainnet, tiny capped orders)

Cell values: a stage letter means required for that stage. `opt` means optional. `-` means not used at that stage.

## 0. Conventions

- **Root `.env`** (copy of `.env.example`) is the source for the worker, the bot, and the db scripts (`bun --env-file=../../.env`). The web app loads the root `.env` through `apps/web/next.config.ts`, and it also reads `apps/web/.env.local`.
- **`cre/.env`** is for the CRE CLI only. Repo code does not read it. The CRE secrets come from `cre/secrets.yaml`.
- **Contracts** read their config with `vm.env*` from the process environment, so export the variables in the shell that runs `forge`.
- **Blank values** are dropped by the worker (`apps/worker/src/env.ts` trims and drops blanks, so defaults apply). The web app parses the shared schema without that step: a blank number becomes `0` and a blank enum such as `EXECUTION_MODE=` fails validation. Delete lines you do not use instead of leaving them empty.
- **Secrets**: never put a secret in a `NEXT_PUBLIC_*` variable. Those values are inlined into the browser bundle at build time, so rebuild after changing them.
- **Dev keys** (`DEV_AGENT_MNEMONIC`, `DEV_AGENT_PRIVATE_KEY`) hold funds. Use tiny balances and fresh keys. They are the only working signing path today (see section 6).

## 1. Platform limits and economics (root `.env`)

Read through `packages/shared/src/config.ts` (`EnvSchema`) by the worker runtime and the web server (`apps/web/lib/server/env.ts`). Defaults are in the schema. Values in `.env.example` match.

| Variable | Default | Req | Read by | Notes |
|---|---|---|---|---|
| `EXECUTION_MODE` | `paper` | L, T, D | config.ts; `apps/worker/src/runtime.ts`; `apps/web/lib/server/env.ts` (`flashLive`) | `paper` never submits orders. `live` submits only when the agent is also live, the kill switch is off, and `DEFINITIVE_API_KEY` is set. |
| `NETWORK` | `testnet` | L, T, D | config.ts; worker runtime (0G router default and relayer network); `apps/web/lib/server/zerog.ts` (router default); `apps/telegram/src/index.ts` (BaseScan host) | Set it together with `CHAIN`. |
| `GLOBAL_KILL_SWITCH` | `false` | D | worker `tick.ts` (no new orders, cancels pending entries); web `flashLive` | Set to `true` to stop all new orders at once. |
| `MAX_TRADE_USD` | `1` | L, T, D | worker policy via `globalLimitsFromEnv` | Per order. Must be at or above Flash's minimum notional, which is not documented. Probe it before the demo. |
| `MAX_AGENT_ALLOCATION_USD` | `5` | L, T, D | worker policy; provisioner allowance cap (`provisioner.ts`, step f) | Per agent. |
| `MAX_DAILY_VOLUME_USD_PER_AGENT` | `20` | L, T, D | worker policy | Per agent per day. |
| `MAX_DAILY_LOSS_USD_PER_AGENT` | `1` | L, T, D | worker policy | Per agent per day. |
| `MAX_OPEN_POSITIONS` | `2` | L, T, D | worker policy | Per agent. |
| `ALLOWED_TOKENS` | `WETH,cbBTC` | L, T, D | worker policy | Comma list. Base Sepolia's `cbBTC` address is the zero address in `packages/shared/src/chains.ts`, so on testnet only `WETH` can trade. |
| `COMMISSION_BPS_DEFAULT` | `1000` | L, T, D | `apps/web/lib/server/agent-config.ts` (default for new agents) | 1000 = 10% of profit above the high-water mark. |
| `COMMISSION_BPS_MIN` | `0` | L, T, D | worker `runtime.ts` (reflection bounds) | Clamps commission suggestions from reflection. |
| `COMMISSION_BPS_MAX` | `2000` | L, T, D | worker `runtime.ts` (reflection bounds) | Same. |
| `FORK_PLATFORM_BPS` | `3000` | - | Declared in the schema only. Not read at runtime. | The web app shows a fixed 3000 from `apps/web/lib/templates.ts`. The onchain split comes from `PLATFORM_BPS` at deploy. |
| `RESERVE_DAYS` | `3` | D | `apps/web/lib/data.ts` (reserve = daily spend x days) | Display of treasury reserve. |
| `MIN_TOPUP_USD` | `0.5` | D | worker `runtime.ts` → `economics/treasury.ts` | Top-ups below this are skipped. |
| `MAX_TOPUP_PER_DAY_USD` | `2` | D | worker `runtime.ts` → `economics/treasury.ts` | Per agent per day, off-chain check. The contract has its own cap (section 7). |
| `RELAYER_SPREAD_BPS` | `100` | D | worker `runtime.ts` → `economics/relayer.ts` | Spread taken on the USDC to 0G conversion. |
| `TICK_INTERVAL_DEFAULT_SEC` | `300` | L | `apps/worker/src/seed.ts` (`seed-demo` agents only) | Agents created in the web app use the template's own interval. |

## 2. Database

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `DATABASE_URL` | none | L, T, D | `packages/db/src/client.ts`; `apps/web/lib/server/db.ts`; `apps/worker/src/runtime.ts`; `apps/telegram` (via `@arena/db`); `packages/db/src/seed.ts` | **L:** `postgres://arena:arena@localhost:5432/arena` (matches `docker-compose.yml`). **T, D:** Neon pooled connection string. Host contains `-pooler`, and you append `?sslmode=require`. Get it from the Neon console (project, Connect, pooled connection). Unset makes the web app serve mock data and the worker use PGlite. |
| `DB_POOL_MAX` | `10` | opt | `packages/db/src/client.ts` | Set to `1` to `3` for serverless web deploys. |
| `DB_POOLED` | unset | opt | `packages/db/src/client.ts` | `true` turns off prepared statements for a pooled host that does not contain `-pooler` (for example, PgBouncer in transaction mode). `-pooler` hosts are detected automatically. |
| `PGLITE_DIR` | `<repo>/.pglite` | opt | `packages/db/src/client.ts`; `seed.ts`; `apps/worker/src/env.ts` | Used only when `DATABASE_URL` is unset. Single process only, so the web app, worker, and bot cannot share it. |

`docker-compose.yml` sets `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. The postgres image reads these, not the app.

## 3. Chain RPC and selection

| Variable | Default | Req | Read by | Notes |
|---|---|---|---|---|
| `CHAIN` | `baseSepolia` (worker) | T, D | `apps/worker/src/env.ts`; `apps/worker/src/chain.ts` (token list, viem chain, RPC) | `base` or `baseSepolia`. **Must match `NEXT_PUBLIC_CHAIN`.** The worker defaults to Base Sepolia but the web app defaults to Base mainnet, so set both. |
| `BASE_RPC_URL` | `https://mainnet.base.org` | D | config.ts; `apps/worker/src/chain.ts`; `apps/web/lib/server/chain.ts` (fork verification); `contracts/foundry.toml` (`base` endpoint) | Use a private RPC for the demo. The public endpoint rate-limits. Get one from your RPC provider. |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | T | same as above (`base_sepolia` endpoint in foundry.toml) | Public endpoint, fine for rehearsal. |
| `PERF_REGISTRY_FROM_BLOCK` | `0` | T, D | `apps/worker/src/env.ts`; `runtime.ts` → `stats.ts` | First block scanned for `PerformanceReported` logs. Set it to the PerformanceRegistry deploy block to avoid scanning from genesis. |
| `LOG_CHUNK_BLOCKS` | `2000` | opt | `apps/worker/src/env.ts`; `runtime.ts` | Block range per `eth_getLogs` call. |

Flash's API and WebSocket base URLs (`https://flash.definitive.fi/v1`, `wss://flash.definitive.fi/v1/ws`) are constants in `packages/shared/src/chains.ts`, not env variables.

## 4. Definitive Flash

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `DEFINITIVE_API_KEY` | none | L, T, D | `apps/worker/src/runtime.ts` (`FlashClient`); `apps/web/lib/server/env.ts` (`flashLive`); `apps/web/lib/server/flash.ts` | **L:** needed, because paper ticks fetch real quotes and the trade screen returns 503 without it. **How:** request an integrator API key from Definitive (docs at https://flash.definitive.fi/docs). The repo does not document the sign-up. Ask the Definitive team at the booth or on Discord. There is no Flash testnet: quotes and orders run against mainnet. |
| `FLASH_INTEGRATOR_FEE_BPS` | `10` | D | `apps/worker/src/runtime.ts` → `FlashExecutor` | Integrator fee applied to each order. Confirm the value against Flash's monetization docs. |

`FLASH_API_KEY` in `cre/.env` is a separate variable for the CRE workflow (section 8). It should hold the same key.

## 5. 0G (Private Computer, Router, Storage, Payment Layer)

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `ZG_API_KEY` | none | L (opt), T, D | `apps/worker/src/runtime.ts` (platform router); `apps/web/lib/server/zerog.ts` (platform AI, needs sign-in); CRE WF2 secret (section 8, only if `llm.enabled`) | Without it, every decision fails with "ZG_API_KEY is not set". **How:** create the platform key in the 0G Private Computer console (pc.0g.ai, per the PRD appendix). Confirm the key type with 0G. |
| `ZG_ROUTER_URL` | by `NETWORK`: mainnet `https://router-api.0g.ai/v1`, testnet `https://router-api-testnet.integratenetwork.work/v1` | opt | worker `runtime.ts`; `apps/web/lib/server/zerog.ts` | Override only if 0G changes the endpoint. The testnet router could not be reached during research (PRD_SIMPLE section 14.1). |
| `ZG_MGMT_KEY` | none | T (rec.), D | `apps/worker/src/runtime.ts` → `ZeroGAccount`; provisioner step c | `mk-...` management key. Gives real 0G balances and mints a capped key per agent. Without it, the budget is an estimate (`AGENT_SEED_CREDIT_0G` minus billed). **How:** from the 0G Router account dashboard. Programmatic account creation is not documented (see FEEDBACK). |
| `AGENT_KEY_ENCRYPTION_KEY` | none | D (if agents get 0G keys) | `apps/worker/src/runtime.ts` → `secrets.ts` (AES-256-GCM for `zg_keys`) | 32 bytes of hex, with or without `0x`. **Generate:** `openssl rand -hex 32`. Keep it in your secret manager. Losing it makes stored agent keys unreadable, and changing it breaks decryption of existing rows. |
| `AGENT_DAILY_0G_CAP` | `1` | D | `apps/worker/src/runtime.ts` → provisioner `zgCreditLimit` | Per-agent 0G key `credit_limit` in 0G units, with a daily reset. |
| `AGENT_SEED_CREDIT_0G` | `1` | L, T, D | `apps/worker/src/runtime.ts` → `budget.ts` | Estimated starting credit per agent when there is no `ZG_MGMT_KEY`. Set it to the bootstrap seed you actually put into the account. Disclose the seed in the README (PRD 1.3). |
| `ZG_PER_USDC` | none | opt (D) | `apps/worker/src/runtime.ts` → relayer `fallbackZgPerUsdc` | Used when CoinGecko has no 0G price. Without it and without a price, the relayer fails the top-up. |
| `ZG_RPC_URL` | none | D (relayer, storage) | `apps/worker/src/runtime.ts` (storage and relayer) | 0G chain RPC for Storage uploads and Payment Layer deposits. Chain IDs: Galileo testnet 16602, 0G mainnet 16661 (`packages/shared/src/chains.ts`). Get the RPC from the 0G docs (docs.0g.ai). |
| `ZG_STORAGE_INDEXER` | none | opt (T, D) | `apps/worker/src/runtime.ts` | 0G Storage indexer URL. Storage is enabled only when `ZG_STORAGE_INDEXER`, `ZG_RPC_URL`, and `ZG_PRIVATE_KEY` are all set. Otherwise memory roots are local digests, not 0G roots. Testnet turbo indexer from PRD_SIMPLE 14.1: `indexer-storage-testnet-turbo.0g.ai` (it may change). Mainnet: confirm in the 0G docs. |
| `ZG_PRIVATE_KEY` | none | opt (T, D) | `apps/worker/src/runtime.ts` (Storage signer) | `0x` + 64 hex. Fund it with 0G. On testnet, use the 0G faucet (0.1 0G per day, per PRD_SIMPLE 14.1). |
| `RELAYER_ZG_PRIVATE_KEY` | none | D (relayer) | `apps/worker/src/runtime.ts` → `economics/relayer.ts` | `0x` + 64 hex. Pays the Payment Layer `depositFor` from its own 0G balance (the float). Relayer also needs `TREASURY_ADDRESS` and `ZG_RPC_URL`. Fund it with 0G before the demo. |
| `RELAYER_MAX_REQUEST_USD` | `2` | D | `apps/worker/src/env.ts` → relayer | A `TopUpRequested` above this amount is not converted. |
| `RELAYER_POLL_SEC` | `15` | opt | `apps/worker/src/env.ts` → relayer loop | Poll interval. |
| `RELAYER_CURSOR_FILE` | `.relayer-cursor.json` | opt | `apps/worker/src/env.ts` → relayer | Last processed Base block (gitignored). |
| `INSIGHT_RSS_FEEDS` | built-in list in `apps/worker/src/insights/sources.ts` (`DEFAULT_RSS_FEEDS`) | opt | `apps/worker/src/env.ts` → `runtime.ts` → `RssCollector` (insight digests, PRD 6.8) | Comma-separated http(s) feed URLs. Blank uses the defaults. Entries that are not http(s) URLs are dropped. Digests are built with 0G, so they count against the 0G budget. |

Payment Layer addresses are constants in `packages/shared/src/chains.ts`, not env variables. Mainnet: `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` (verified implementation). Testnet: `0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939` (implementation unverified, see `packages/zerog/src/payment.ts`).

## 6. Keys and wallets (worker)

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `DEV_AGENT_MNEMONIC` | none | T, D (until Privy) | `apps/worker/src/runtime.ts` → `LocalWalletProvider` (`wallets.ts`) | BIP-39 phrase. Trading wallet per agent at `m/44'/60'/0'/0/<index>`, 0G wallet on branch 1. Takes precedence over `DEV_AGENT_PRIVATE_KEY`. **How:** generate a fresh 12-word phrase offline, with a hardware wallet or a BIP-39 tool. Never reuse a wallet that holds other funds. |
| `DEV_AGENT_PRIVATE_KEY` | none | T, D (alternative) | `apps/worker/src/runtime.ts` → `LocalWalletProvider` | `0x` + 64 hex. One shared trading key. Per-agent 0G keys are derived by hashing it, so anyone with this key controls every dev agent. **How:** `cast wallet new` (Foundry). |
| `OPERATOR_PRIVATE_KEY` | none | T, D | `apps/worker/src/runtime.ts` → provisioner (`updateConfig`, and registration stores its address as the agent operator); `economics/treasury.ts` (`collectCommission`, `topUp`) | `0x` + 64 hex. Needs Base ETH for gas. **How:** `cast wallet new`, then fund on Base Sepolia (faucet) or Base. |
| `PLATFORM_ADMIN_PRIVATE_KEY` | none | T, D | `apps/worker/src/runtime.ts` → registry writer (`AgentRegistry.register`) | `0x` + 64 hex. Must be the `platform` address on AgentRegistry. The deployer is `platform` by default. Otherwise the owner calls `setPlatform`. Needs Base ETH. |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `TURNKEY_*` | n/a | not used | Not read by any code | `PrivyWalletProvider` in `apps/worker/src/wallets.ts` is a stub that throws. Server wallets with policies (PRD 7.4) are future work. Do not add these until the provider exists. |

Trading wallets need Base ETH for gas, because provisioning step f sends the USDC approval from the trading wallet and waits for gas.

## 7. Contracts (Base)

**Prerequisites:** Foundry (`forge`, `cast`), `jq` (for `export-abis.sh`), and `forge-std`: `cd contracts && forge install foundry-rs/forge-std --no-git`.

Deploy inputs (read by `contracts/script/Deploy.s.sol`):

| Variable | Default | Req | Notes |
|---|---|---|---|
| `USDC_ADDRESS` | none | T, D | Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Confirm both on BaseScan. |
| `CRE_FORWARDER` | none | T, D | Simulation mock forwarder: Base Sepolia `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`, Base `0x5e342a8438b4f5d39e72875fcee6f76b39cce548`. Production KeystoneForwarder: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`. Confirm against the CRE forwarder directory. The values are in `packages/shared/src/chains.ts` (`CRE_FORWARDERS`) and `cre/lib/chains.ts`. |
| `RELAYER_ADDRESS` | none | T, D | Base address that receives top-up USDC (`AgentTreasury.relayer`). The relayer process does not read it. Use a dedicated address. |
| `PLATFORM_TREASURY` | none | T, D | Receives the platform share of fork fees. |
| `PLATFORM_BPS` | `3000` | opt | Platform share of fork fees, onchain. Must be at most 10000. |
| `DEFAULT_DAILY_TOPUP_CAP_USD6` | `2000000` | opt | Per-agent daily top-up cap in USDC with 6 decimals (2 USDC). |
| `RESERVE_FLOOR_USD6` | `0` | opt | Minimum reserve each agent keeps in its treasury. |
| `BASESCAN_API_KEY` | none | D (for `--verify`) | Read by `contracts/foundry.toml`. Get it from BaseScan (account, API keys). |

**Deploy** (the signer comes from a Foundry keystore account, never from the repo):

```bash
cd contracts
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export CRE_FORWARDER=0x82300bd7c3958625581cc2f77bc6464dcecdf3e5   # simulation mock on Base Sepolia
export RELAYER_ADDRESS=<relayer-base-address>
export PLATFORM_TREASURY=<platform-address>
forge script script/Deploy.s.sol --rpc-url base_sepolia --account <keystore-name> --broadcast --verify -vvvv
```

Dry run: omit `--broadcast`. Mainnet: use `--rpc-url base`, a funded signer, and recheck every variable.

**Where each printed address goes:**

| Contract | Goes to |
|---|---|
| AgentRegistry | `REGISTRY_ADDRESS` (worker); CRE WF1 config `agentRegistry` |
| StrategyMarketplace | `NEXT_PUBLIC_MARKETPLACE_ADDRESS` (web) |
| PerformanceRegistry | `PERF_REGISTRY_ADDRESS` (worker); CRE WF1 config `performanceRegistry` |
| AgentTreasury | `TREASURY_ADDRESS` (worker); `NEXT_PUBLIC_TREASURY_ADDRESS` (web) |
| RiskOracle | `RISK_ORACLE_ADDRESS` (worker); CRE WF2 config `riskOracle` |
| CRE forwarder | Constructor argument for PerformanceRegistry and RiskOracle. Not generated by this repo. |

**Post-deploy wiring:**

- **Forwarder.** PerformanceRegistry and RiskOracle accept reports only from their forwarder. If you deployed with the simulation mock, the owner calls `setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)` on each contract before the live demo.
- **Platform admin.** If `PLATFORM_ADMIN_PRIVATE_KEY` is not the deployer, the owner calls `AgentRegistry.setPlatform(<address>)`.
- **Relayer.** The deploy sets `relayer` from `RELAYER_ADDRESS`. Change it later with `AgentTreasury.setRelayer` if needed.
- **Verify** a single contract manually (from `contracts/README.md`):
  ```bash
  forge verify-contract <address> src/PerformanceRegistry.sol:PerformanceRegistry \
    --chain base_sepolia --constructor-args $(cast abi-encode "constructor(address)" $CRE_FORWARDER)
  ```
- **ABIs.** `./export-abis.sh` (needs `jq`) writes `contracts/abi/`. The worker (`apps/worker/src/abi.ts`) and the web app (`apps/web/lib/abi.ts`) keep their own copies. Update them when an ABI changes.

## 8. Chainlink CRE

**Setup:** `cd cre && bun install && bun x cre-setup`, then install the CRE CLI with checksum verification (steps in `cre/README.md`), then `cre login` (opens a browser). Live deployment needs Chainlink approval: request access with `cre account access` on day 1 (PRD 1.4).

`cre/.env` (copy from `cre/.env.example`):

| Variable | Req | Read by | Notes |
|---|---|---|---|
| `CRE_ETH_PRIVATE_KEY` | T (for `--broadcast`), D | The CRE CLI, not repo code | Base Sepolia ETH for writes. A dummy key works for dry runs. Use a dedicated key, not `OPERATOR_PRIVATE_KEY`. |
| `FLASH_API_KEY` | T, D | WF1 via `cre/secrets.yaml` → `runtime.getSecret` (`cre/wf1-performance-attestor/main.ts`) | Same value as `DEFINITIVE_API_KEY`. Read-only, cannot move funds. |
| `ZG_API_KEY` | only if `llm.enabled` | WF2 via `cre/secrets.yaml` (`cre/wf2-crash-sentinel/main.ts`) | Both committed configs have `llm.enabled: false`. |

**Config files to fill** (committed values are zero addresses or placeholders, and the workflow fails fast on zero addresses):

- `cre/wf1-performance-attestor/config.staging.json` and `config.production.json`:
  - `agentRegistry` and `performanceRegistry`: the deployed addresses
  - `httpAuthorizedKeys`: operator EVM addresses. Empty means simulate-only, and it is accepted only for simulation.
  - `feeds`: Base mainnet ETH/USD and BTC/USD are marked VERIFY in `cre/README.md`. The BTC/USD address is not confirmed.
  - `humanWallets` (optional)
- `cre/wf2-crash-sentinel/config.staging.json` and `config.production.json`:
  - `riskOracle`: the deployed address
  - `httpAuthorizedKeys`: as above
  - `allowSimulate`: `true` on staging only. `false` on production.
  - `llm.model`: still `SET-FROM-0G-ROUTER-MODELS`. Set it from the 0G Router model list before enabling the LLM signal.
- `cre/lib/chains.ts` holds copies of the addresses and feeds. Keep them in sync with the JSON configs and `packages/shared/src/chains.ts`.

**Simulate** (from `cre/`, `--target staging-settings` for testnet):

```bash
cre workflow simulate wf1-performance-attestor --target staging-settings
cre workflow simulate wf1-performance-attestor --target staging-settings --broadcast
cre workflow simulate wf2-crash-sentinel --non-interactive --trigger-index 1 \
  --http-payload @wf2-crash-sentinel/payloads/simulate-crash.json --target staging-settings
```

Add `--broadcast` to write the report onchain through the mock forwarder. The other WF2 payloads are `simulate-caution.json` and `simulate-clear.json`.

## 9. Web (`apps/web`)

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `SESSION_SECRET` | unset (sign-in disabled) | D | `apps/web/lib/server/env.ts` (`sessionSecret`) | At least 32 characters. **Generate:** `openssl rand -hex 32`. Without it, or if it is shorter than 32 characters, sign-in is disabled. Platform AI routes and trade submission require a session. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | placeholder | D | `apps/web/lib/wagmi.ts` | WalletConnect Cloud project ID. **How:** cloud.walletconnect.com, create a project, copy the ID. A placeholder works locally, but the relay may rate-limit. |
| `NEXT_PUBLIC_CHAIN` | `base` (mainnet) | L, T, D | `apps/web/lib/contracts.ts` | `base` or `baseSepolia`. **Must match the worker `CHAIN`.** |
| `NEXT_PUBLIC_MARKETPLACE_ADDRESS` | empty ("not deployed") | T, D | `apps/web/lib/contracts.ts` | From deploy (section 7). |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | empty ("not deployed") | T, D | `apps/web/lib/contracts.ts` | From deploy (section 7). |
| `NEXT_PUBLIC_USDC_ADDRESS` | native USDC for the chosen chain | opt | `apps/web/lib/contracts.ts` | Override only for a custom token. |
| `NEXT_PUBLIC_BASE_EXPLORER` | `https://basescan.org` | opt | `apps/web/lib/format.ts` | Set `https://sepolia.basescan.org` on testnet. |
| `NEXT_PUBLIC_TELEGRAM_BOT` | `arena_demo_bot` | opt | `apps/web/components/portfolio/portfolio-view.tsx` | Your bot's username, without the `@`. |

The web app also reads these server-side variables from the root `.env`: `DATABASE_URL`, `NETWORK`, `EXECUTION_MODE`, `GLOBAL_KILL_SWITCH`, `DEFINITIVE_API_KEY`, `ZG_API_KEY`, `ZG_ROUTER_URL`, `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `RESERVE_DAYS`, `COMMISSION_BPS_DEFAULT`, `SESSION_SECRET`. `NODE_ENV` is set by Next.js.

## 10. Telegram (`apps/telegram`)

| Variable | Default | Req | Read by | Notes and how to get it |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | none | D (if the bot is shown) | `apps/telegram/src/index.ts` | Without it the bot logs a message and exits 0. The worker is unaffected. **How:** message @BotFather, send `/newbot`, copy the token. Never log it. |
| `WEB_URL` | `http://localhost:3000` | D | `apps/telegram/src/index.ts` (links in messages) | Your deployed web URL. |
| `NETWORK` | `testnet` | D | `apps/telegram/src/index.ts` (BaseScan host) | Same as the platform `NETWORK`. |
| `BASESCAN_URL` | derived from `NETWORK` | opt | `apps/telegram/src/index.ts` | Override the BaseScan host. |
| `ZG_EXPLORER_URL` | none | opt | `apps/telegram/src/index.ts` (0G tx links) | Base URL of the 0G explorer. The PRD references `chainscan.0g.ai`. |
| `TG_STATE_FILE` | `./.telegram-state.json` (gitignored) | opt | `apps/telegram/src/index.ts` | Bot state (links, cursors, digests). |

The bot also needs `DATABASE_URL` (or `PGLITE_DIR`) as in section 2.

## 11. Not used, or missing from `.env.example`

Declared but not read at runtime: `FORK_PLATFORM_BPS` (section 1).

Read by code but not in `.env.example`: `DEV_AGENT_MNEMONIC`, `OPERATOR_PRIVATE_KEY`, `PLATFORM_ADMIN_PRIVATE_KEY`, `RELAYER_ZG_PRIVATE_KEY`, `ZG_MGMT_KEY`, `AGENT_KEY_ENCRYPTION_KEY`, `ZG_RPC_URL`, `ZG_STORAGE_INDEXER`, `ZG_PRIVATE_KEY`, `ZG_PER_USDC`, `AGENT_SEED_CREDIT_0G`, `AGENT_DAILY_0G_CAP`, `INSIGHT_RSS_FEEDS`, `REGISTRY_ADDRESS`, `TREASURY_ADDRESS`, `PERF_REGISTRY_ADDRESS`, `RISK_ORACLE_ADDRESS`, `PERF_REGISTRY_FROM_BLOCK`, `LOG_CHUNK_BLOCKS`, `CHAIN`, `WORKER_MAX_CONCURRENCY`, `RELAYER_MAX_REQUEST_USD`, `RELAYER_POLL_SEC`, `RELAYER_CURSOR_FILE`, `DB_POOLED`, `PGLITE_DIR`, `SESSION_SECRET`, `NEXT_PUBLIC_CHAIN`, `NEXT_PUBLIC_MARKETPLACE_ADDRESS`, `NEXT_PUBLIC_TREASURY_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_BASE_EXPLORER`, `NEXT_PUBLIC_WC_PROJECT_ID`, `NEXT_PUBLIC_TELEGRAM_BOT`, `WEB_URL`, `BASESCAN_URL`, `ZG_EXPLORER_URL`, `TG_STATE_FILE`, and the Foundry and CRE variables. Add the ones you use.

## 12. Go-live order of operations

Keep `EXECUTION_MODE=paper` until step 9.

1. **Pre-flight (local).** `bun run test`, `bun run typecheck`, `cd cre && bun test`, `cd contracts && forge test -vv`. Run gitleaks on staged changes (`.githooks/pre-commit`).
2. **Deploy contracts on Base Sepolia** (section 7). Record every address.
3. **Set forwarder and platform.** Keep the simulation forwarder for the rehearsal. Before mainnet, call `setForwarder` on PerformanceRegistry and RiskOracle with the production forwarder. If `PLATFORM_ADMIN_PRIVATE_KEY` is not the deployer, call `setPlatform`.
4. **Configure CRE.** Fill the WF1 and WF2 configs (section 8), run `cre login`, then simulate both workflows on staging with `--broadcast`. Confirm the report lands in PerformanceRegistry and RiskOracle. If the mock forwarder does not call `onReport`, the attestation fallback is a relayed report, and you must disclose it.
5. **Fund the relayer float.** Send 0G to the `RELAYER_ZG_PRIVATE_KEY` address. Set `ZG_RPC_URL` and `TREASURY_ADDRESS`, then run `bun run --filter @arena/worker relayer`.
6. **Onboard demo agents.** Set `ZG_MGMT_KEY` and `AGENT_KEY_ENCRYPTION_KEY`. Run provisioning for each agent: `cd apps/worker && bun --env-file=../../.env src/index.ts provision <agentId>`. That creates the trading wallet and 0G wallet, mints the capped 0G key (`AGENT_DAILY_0G_CAP`), registers the agent, syncs its config, and sets the USDC allowance. Then fund the trading wallet with Base ETH and USDC. The code creates 0G keys only through `ZG_MGMT_KEY`. Keys created by hand in the pc.0g.ai console have no import path in the worker, so manual onboarding is a fallback only.
7. **Rehearse the self-funding loop on testnet.** Run `cd apps/worker && bun run tick <agentId>`, then confirm the commission collection, the top-up, the relayer deposit, and the next request IDs being billed. Record each tx hash.
8. **Deploy to Base mainnet.** Repeat step 2 with `--rpc-url base`. Set `NETWORK=mainnet`, `CHAIN=base`, `NEXT_PUBLIC_CHAIN=base`, the mainnet `NEXT_PUBLIC_*` addresses, and a private `BASE_RPC_URL`. Flash has no testnet, so live orders settle on mainnet, and the contracts must be on mainnet for a real commission.
9. **Switch to live with tiny caps.** Set `EXECUTION_MODE=live`, keep `GLOBAL_KILL_SWITCH=false`, and keep `MAX_TRADE_USD=1` and the other defaults. Check that `/api/platform` reports `flashLive: true`. Run one $1 order and confirm the fill on BaseScan.
10. **Rehearse the crash path.** Trigger `simulate-crash` on WF2 and watch the worker logs. In live mode, cancels and stop changes record an error, because Flash cancel and PATCH are not wired (see the README's known gaps). Plan the demo around this, or keep the demo to paper mode for that beat.
11. **Record evidence for the README.** Commission tx, top-up tx, 0G deposit tx, first paid request ID, CRE report tx hashes, and the BaseScan links for the fills.
12. **Stop switch.** If anything looks wrong, set `GLOBAL_KILL_SWITCH=true` and restart the worker. New orders stop, and pending entries are cancelled.
