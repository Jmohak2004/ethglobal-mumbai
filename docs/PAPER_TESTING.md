# Paper Testing Guide

Test the whole platform **without spending money**. In paper mode, agents and the trade terminal get **real Flash quotes at real prices**, but nothing is submitted. Fills are simulated at the quoted price.

**What paper mode covers:** the leaderboard, wallet sign-in, creating agents, AI decisions on 0G, the safety rules, quotes, simulated fills, the decision log, social insights, crash protection (simulated), the Telegram bot, pause/resume, and the Humans opt-in.

**What paper mode can't cover:** real fills on BaseScan, Flash order cancels and stop changes, and anything that needs deployed contracts (fork, fund, withdraw, commission, top-ups). See "What's next" at the end.

---

## 1. One-time setup

```bash
bun install
docker compose up -d                # local Postgres on :5432 (OrbStack/Docker must be running)
cp .env.example .env                # if you already have a .env, copy SESSION_SECRET over first
```

Then set these values in `.env`:

| Variable | Value for paper testing | Why |
|---|---|---|
| `EXECUTION_MODE` | `paper` | Never submits orders. This is the default. |
| `DATABASE_URL` | `postgres://arena:arena@localhost:5432/arena` | Local Docker Postgres, shared by web, worker and bot |
| `DEFINITIVE_API_KEY` | your Flash key (app.definitive.fi → More → Flash → Create Flash Key) | Paper fills use real quotes. Without it, quotes fail and the trade screen returns 503. |
| `ZG_API_KEY` | your `sk-` key (pc.0g.ai → Dashboard → API Keys), with a small deposit or the hackathon credits | Agent decisions, digests, reflection. Without it, every tick records "ZG_API_KEY is not set". |
| `ZG_ROUTER_URL` | `https://router-api.0g.ai/v1` | **Important.** `NETWORK=testnet` would otherwise point at the 0G testnet router, which wasn't reachable during research. Your key is a mainnet key. |
| `DEV_AGENT_MNEMONIC` | a **fresh** 12-word phrase (unfunded is fine for paper) | New agents need a wallet address to be provisioned; otherwise their ticks say "not provisioned". Generate it offline or with a BIP-39 tool. |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -hex 32`) | Wallet sign-in on the web app |
| `NETWORK`, `CHAIN`, `NEXT_PUBLIC_CHAIN` | `testnet`, `baseSepolia`, `baseSepolia` | Keep `CHAIN` and `NEXT_PUBLIC_CHAIN` equal |
| `TELEGRAM_BOT_TOKEN` | optional, from @BotFather | Only to test the bot |
| Contract addresses (`REGISTRY_ADDRESS`, `TREASURY_ADDRESS`, `RISK_ORACLE_ADDRESS`, `NEXT_PUBLIC_*_ADDRESS`, …) | **leave empty** | Onchain steps are skipped cleanly. Risk is read from the database instead. |

## 2. Seed demo data

```bash
cd packages/db && bun --env-file=../../.env src/seed.ts && cd ../..
bun run --filter @arena/worker seed-demo
```

This creates 8 demo agents and 4 humans, all labelled `[demo]` and `PAPER`, plus a NORMAL risk state.

## 3. Start everything (3 terminals)

```bash
bun run dev:web        # http://localhost:3000
bun run dev:worker     # agent loop, insights, stats, crash handling
bun run dev:bot        # Telegram (skip if no token)
```

The worker prints one JSON log line per event. `decision failed … ZG_API_KEY` means the 0G key is missing. `not provisioned` means `DEV_AGENT_MNEMONIC` is missing.

---

## 4. Test checklist

Work through these in order. Each has what to do and what you should see.

### A. Leaderboard and agent pages
1. Open http://localhost:3000. You should see the leaderboard with Agents / Humans / All tabs, `[demo]` agents, PAPER labels and a 🟢 NORMAL risk pill.
2. Click an agent. You see **stats only**: no trades, no strategy settings.
3. Open `/trade`. The chart should show live Coinbase candles and update about every 15 seconds.

### B. Wallet sign-in
1. Connect any wallet (MetaMask, Rabby…) on Base Sepolia. **No funds needed.**
2. Sign the sign-in message. This is a free signature, not a transaction.
3. Open `/portfolio`. It should show your address and an empty "my agents" list.

### C. Create an agent
1. Go to `/create`, pick **Momentum**, keep the defaults, and click **Create agent**.
2. Within about 30 seconds the worker provisions it: a trading wallet and a 0G wallet address appear in the logs (`provisioned`).
3. On `/portfolio` the agent shows as `paper`, `active`.

### D. Run one decision by hand
Copy the agent id from the URL (or use `demo-agent-momentum`), then:
```bash
cd apps/worker && bun --env-file=../../.env src/index.ts tick <agentId>
```
The printed JSON should contain:
- `decision.forecast`: for example ETH up/down, an expected move and a confidence
- `decision.proposal`: buy / sell / hold with an order type, TP and SL
- `inference.requestId`: **the 0G request ID** (keep a few for the README)
- `verdict.kind`: `approve`, `clamp` (shows reasons), `reject` or `noop`
- `flashOrderIds`: a paper order id when approved

`hold` / `noop` are normal outcomes. Run it a few times; the market decides.

### E. Owner console
1. Open your agent's page while signed in as the owner.
2. Check the **decision log**: time, forecast, action, verdict colour, 0G request ID (copy button), TEE ✓.
3. Check **guardrail blocks**: any clamp/reject shows its reason (for example "notional clamped to max trade").
4. Check the **budget tier** meter and the lessons list. Lessons appear after reflection runs.

### F. Manual trading in paper mode
1. On `/trade`, choose WETH, Market, Buy, **$1**, then submit.
2. You should get a **real quote** (price, fees) and a **simulated fill** labelled PAPER. Nothing is signed or sent.
3. Try **Limit**, **TWAP**, **Stop** and **Bracket**. Each should quote. Try $10 to see the server-side cap reject it (above `MAX_TRADE_USD`).
4. On Open Orders, **Cancel** a paper order. It's marked cancelled locally with a paper label.

### G. AI features (0G)
1. On `/trade`, click **AI chart read**, paste or upload a chart screenshot. You should get trend, key levels, a suggested template and a 0G request ID.
2. On an agent page, click **Share card**. You should get an AI-generated image, or the static card if no key is set.
3. Optional (iAI bonus path): paste your **own** 0G key in the nav settings popover. Calls now say "billed to your 0G account".

### H. Social insights
```bash
cd apps/worker && bun --env-file=../../.env src/index.ts insights demo-agent-social
```
This prints a digest per asset (bullish / bearish / neutral with confidence) built from CoinDesk, Cointelegraph and Decrypt RSS plus 0G web search, with a 0G request ID.

### I. Crash protection (simulated, no Chainlink needed)
With no `RISK_ORACLE_ADDRESS`, the worker reads the risk level from the database, so you can flip it by hand.

1. Let an agent hold a paper position or a resting paper limit order (step D or F).
2. Set HALT:
   ```bash
   docker exec ethglobal-mumbai-postgres-1 psql -U arena -d arena -c \
   "INSERT INTO risk_states (id, level, reason_code, as_of) VALUES ('manual-halt-' || extract(epoch from now())::bigint, 'HALT', 5, (extract(epoch from now())*1000)::bigint);"
   ```
3. Within about 30 seconds:
   - the nav pill turns 🔴 HALT
   - worker logs show the HALT actions: pending paper entries cancelled; stops tightened or position flattened, per the agent's crash mode
   - the decision log shows episodes with reason **"RiskOracle HALT"**
   - new buys are rejected by the safety rules
   - Telegram (if running and followed) sends a 🔴 HALT alert
4. Clear it:
   ```bash
   docker exec ethglobal-mumbai-postgres-1 psql -U arena -d arena -c \
   "INSERT INTO risk_states (id, level, reason_code, as_of) VALUES ('manual-clear-' || extract(epoch from now())::bigint, 'NORMAL', 0, (extract(epoch from now())*1000)::bigint);"
   ```
5. Optional: try `CAUTION` (reason 2). Trade sizes should halve.

### J. Telegram bot
1. Message your bot: `/start`, `/top`, `/humans`, `/agent momentum`, `/risk`.
2. `/follow <agent>`. You'll get rank changes, risk changes and a daily digest, **never individual trades**.
3. `/link <your 0x address>`. You'll now get **owner alerts** for your agents (orders, guardrail blocks, budget tier).
4. `/fork <agent>` replies with a deep link to the agent page.

### K. Owner controls
1. On `/portfolio`, **Pause** your agent. The worker logs skip it. **Resume** it again.
2. Toggle **Join Humans board**. After you make paper trades, you appear on the Humans tab after the next stats cycle (about 5 minutes).

### L. Automated tests (no keys)
```bash
for d in packages/policy packages/flash packages/zerog packages/db apps/worker apps/telegram; do (cd $d && bunx tsc -p . && bun test); done
(cd apps/web && bunx tsc --noEmit -p .); (cd cre && bunx tsc --noEmit && bun test); (cd contracts && forge test)
```

---

## 5. Reset

```bash
docker compose down -v && docker compose up -d     # wipes the local database
```
Then rerun step 2.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Web shows mock agents (e.g. "Trend Tara") instead of `[demo]` | `DATABASE_URL` not set or an old server is still running on the port. Check with `lsof -i :3000` and kill it. |
| `ZG_API_KEY is not set` | Add the key. If it's set but calls fail, check `ZG_ROUTER_URL` is the mainnet router and the account has credit. |
| `402` / insufficient balance from 0G | Deposit on pc.0g.ai or use the hackathon credits. The agent drops to the Critical budget tier instead of crashing. |
| `DEFINITIVE_API_KEY is not set` / trade screen 503 | Add the Flash key |
| Tick says `not provisioned` | Set `DEV_AGENT_MNEMONIC`, wait 30 seconds or run `bun --env-file=../../.env src/index.ts provision <agentId>` in `apps/worker` |
| Sign-in fails | `SESSION_SECRET` missing or under 32 characters |
| Docker errors | Start OrbStack / Docker Desktop first |

## 7. What's next (needs money or deployed contracts)

- **Base Sepolia (free test tokens):** deploy the contracts (`contracts/README.md`), fill in the addresses, then test fund, fork, withdraw and commission with Circle test USDC.
- **Chainlink CRE:** `cre login`, then simulate both workflows (`cre/README.md`). The crash sentinel replaces step I's manual SQL.
- **Live demo (~$2 USDC + ~$0.50 ETH on Base mainnet):** set `EXECUTION_MODE=live` and one agent to live. See the demo storyline.
