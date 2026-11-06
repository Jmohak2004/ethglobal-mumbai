# Project Overview (Simple Version)

> A plain-language companion to `PRD.md`. It covers what we're building, what each part does, what each part uses, and why we decided things the way we did. For exact details, see `PRD.md`.

---

## 1. The idea in one paragraph

We're building a **trading app where AI agents trade for you, and everyone can see who's best**.

1. You pick a strategy template, adjust a few sliders, and put a small amount of USDC into your agent.
2. The agent uses AI (running on **0G**) to decide what to trade, and places orders through **Definitive Flash**.
3. A public leaderboard ranks agents and human traders. The stats are checked by **Chainlink** so nobody can fake them.
4. If you like someone's agent, you can **pay to copy its setup**.
5. The agents **pay for their own AI** using a small cut of the profit they make.

---

## 2. The 4 prizes we're going for

| Sponsor | Prize | What they want, in one line |
|---|---|---|
| Definitive | Best Use of Flash Advanced Orders in a **Social** App | Use Flash's smart order types (limit, stop-loss, take-profit, TWAP…) in an app where trading is social |
| 0G | Build with 0G Private Computer | AI on 0G is the heart of the app, not a gimmick. People should want to come back tomorrow. |
| 0G | Agents That Pay for Themselves | The agent earns money, and that money pays for its own AI, with no human topping it up |
| Chainlink | Best workflow with CRE | Use Chainlink CRE to connect blockchain data with outside data (APIs, AI) in a way that actually matters |

---

## 3. Who uses it

| Person | What they do | Do they pay? |
|---|---|---|
| **Spectator** | Browses the leaderboard, follows agents on Telegram, shares cards | No |
| **Agent owner** | Creates and funds an agent; earns money when others copy it | Funds their agent |
| **Copier ("forker")** | Pays to copy a top agent's setup into their own agent | Yes, a fork fee |
| **Manual trader** | Trades by hand and competes on the "Humans" leaderboard | Only trading fees |

---

## 4. The big picture

```
                 ┌──────────────────────────────────────────┐
   You  ───────► │  WEB APP: leaderboard, build agent,      │
                 │  copy agent, manual trading              │
                 └───────────────┬──────────────────────────┘
                                 │
                 ┌───────────────▼──────────────────────────┐
                 │  AGENT (runs every few minutes)          │
                 │   1. look at prices                      │
                 │   2. ask the AI brain (0G)  ─────────────┼──► 0G Private Computer
                 │   3. check the safety rules              │
                 │   4. check the crash light   ◄───────────┼─── Chainlink CRE (Crash Sentinel)
                 │   5. place the order        ─────────────┼──► Definitive Flash ──► Base chain
                 │   6. save memory            ─────────────┼──► 0G Storage
                 └───────────────┬──────────────────────────┘
                                 │ trades happen
                 ┌───────────────▼──────────────────────────┐
                 │  Chainlink CRE (Performance checker)     │
                 │  reads trades from Flash, computes real  │
                 │  profit, writes it onchain                │
                 └───────────────┬──────────────────────────┘
                                 │
         ┌───────────────────────┴──────────────────────┐
         ▼                                              ▼
  Leaderboard shows                         Agent takes its commission
  "Verified" stats                          ──► converts it to 0G credit
                                            ──► pays for its own AI
```

---

## 5. The parts, one by one

### 5.1 Leaderboard (free to view)
- **What it does.** Ranks agents and humans by profit, win rate, biggest loss, and how accurate their predictions were.
- **What you see.** Stats only. No individual trades and no settings. Those are what people pay for.
- **Uses.** Our database plus the numbers Chainlink CRE writes onchain.
- **Why.** The free leaderboard draws people in. Hiding the details gives a reason to pay for a copy.

### 5.2 Agent builder (templates + sliders)
- **What it does.** You choose a strategy type and tune it with sliders:
  - **Momentum.** Ride trends.
  - **Mean Reversion.** Buy dips, sell spikes.
  - **Breakout.** Buy when price breaks a range.
  - **Smart DCA.** Buy slowly over time.
  - **Social Sentiment.** Trade on news and other agents' views.
- **Sliders.** Trade size, take-profit %, stop-loss %, which coins are allowed, max loss per day, and so on.
- **Why templates and not free text.** Templates are easier to build and safer, and they make it easy to keep the agent inside its strategy.

### 5.3 The agent's brain (0G Private Computer)
- **What it does.** Every few minutes the agent sends the AI the current prices, its recent memory, and the news. The AI returns two things:
  - **A prediction.** For example: "ETH up 2% in 4 hours, 70% confident."
  - **A proposed action.** For example: "buy $1 of ETH with a limit order, take-profit +3%, stop-loss −2%."
- **Uses.** 0G's AI models (similar to OpenAI's API). Each call returns a **request ID**, which proves the AI call happened on 0G.
- **Other AI uses:**
  - Reading a chart image you upload (vision model).
  - Making shareable profit card images (image model).
  - Writing daily "lessons learned."

### 5.4 Safety rules (the "policy engine")
- **What it does.** A plain code checker, not AI, that every AI suggestion must pass. Is this coin allowed? Is the size too big? Is there a stop-loss? Have we lost too much today?
- **Outcomes.** Approve, shrink, or block. Blocked attempts are shown to the owner.
- **Why.** AI can make mistakes or go off-strategy. This is the hard wall that keeps the agent inside its strategy.

### 5.5 Placing trades (Definitive Flash)
- **What it does.** Turns an approved decision into a real order on the blockchain.
- **Order types we use:**
  - **Limit.** Buy at a set price.
  - **TWAP.** Spread a buy over time; we use it for "DCA."
  - **Stop-buy.**
  - **Take-profit and stop-loss**, attached to every buy.
  - **Trailing stop.**
- **Chain.** Base (see §9 for other options).
- **Why attach take-profit and stop-loss to every buy.** Even if our servers or the AI go down, Flash still protects the position.

### 5.6 Agent wallet (where the agent's money sits)
- **What it does.** Each agent gets its own wallet that you fund with a little USDC. You can withdraw any time.
- **Uses.** Privy or Turnkey "server wallets." The keys are held securely by that provider, and their rules only let the wallet do three things: sign Flash orders, approve the treasury, and send money back to you.
- **Why not Chainlink CRE for the keys.** Every Chainlink node would see the key, orders could be sent several times over, and live CRE deployment needs Chainlink's approval.

### 5.7 Crash protection (Chainlink CRE "Crash Sentinel")
Explained in detail in §8. In short, it's a **shared green/yellow/red traffic light**, stored onchain and set by Chainlink, that every agent checks before trading.

### 5.8 Verified stats (Chainlink CRE "Performance checker")
- **What it does.** Every 15 minutes, Chainlink's network does three things:
  1. Reads each agent's filled trades from Flash.
  2. Reads real prices from Chainlink price feeds.
  3. Calculates profit, win rate, and so on, plus how much commission the agent has earned.
- **Output.** Writes the result to a smart contract on Base.
- **Why.** Stats come from a neutral network, not from us, so they can't be faked. That's why we can hide individual trades and still be trusted. It's also the *only* number the agent's commission is based on, so an agent can't overcharge its owner.

### 5.9 The agent pays for itself (commission → 0G credit)
1. The agent makes a profit on a trade.
2. The Performance checker writes "this agent is owed $X of commission" (for example 10% of profit) onchain.
3. The **AgentTreasury** smart contract pulls that $X from the agent's wallet and keeps it.
4. When the agent's AI credit runs low, it asks the treasury to top up.
5. A small automated service of ours (the **relayer**) receives the USDC and sends the agent the same value in 0G tokens. The agent deposits them as AI credit.
6. The agent keeps running on its own money.

Some extra rules:

- **Reserve.** The treasury keeps a few days of AI costs aside. The owner can withdraw everything above that.
- **Spend cap.** Each agent's 0G key has a daily spending limit, enforced by 0G itself.
- **Running low.** The agent switches to a cheaper AI model and thinks less often. When nearly empty it stops opening new trades, though existing stop-losses still protect it. It never crashes.
- **Why a relayer instead of swapping and bridging each time.** Bridging USDC to the 0G chain costs a fixed fee, often more than the tiny commission itself. The relayer costs fractions of a cent per top-up, and we refill its 0G occasionally in bulk.

### 5.10 Memory and learning
- **What it does.** Every decision and its result is saved. After trades close, and once a day, the AI writes "lessons." For example: "breakouts on low volume failed 3 times; require higher volume."
- **Using lessons.** They go into future decisions.
- **Auto-tune (optional).** The AI may nudge sliders within limits the owner sets.
- **Uses.** Postgres for fast access, plus **0G Storage** for a tamper-proof copy, shown as a "memory proof" hash.

### 5.11 Copying agents (the marketplace)
- **What it does.** Pay a fork fee in USDC and you get an exact copy of a top agent's settings in your own agent, which then trades on its own.
- **Where the fee goes.** Split between the **creator** and the **platform**. Percentages are decided later.
- **Insights.** Agents can also take insights from other sources: other agents' public market views, news and RSS feeds, and 0G's built-in web search. We don't use the X/Twitter API; it costs money.

### 5.12 Sharing and Telegram
- **Share cards.** AI-generated images showing an agent's verified stats and rank. Post them to X or TikTok with one click; no X API needed.
- **Telegram bot.** This is the "agent-run product" people can follow:
  - `/top` shows the leaderboard.
  - `/follow` gives daily updates.
  - `/fork` links to copy an agent.
  - Owners get full trade alerts.

### 5.13 Manual trading
- **What it does.** A normal trading screen with every Flash order type. You sign with your own wallet.
- **AI helper.** Upload a chart and the AI reads it (paid from your own 0G credits).
- **Leaderboard.** Humans compete on a **Humans vs Agents** board.

---

## 6. Main decisions at a glance

| Question | What we chose | Why | What we didn't choose |
|---|---|---|---|
| What does "market prediction" mean? | AI price forecasts that drive trades and get scored | Fits trading; makes the AI essential | Polymarket-style betting |
| Which chain? | **Base** | Cheap, lots of USDC, supported by Chainlink CRE | Solana (different wallet tech) |
| How do agents hold money? | Server wallet with strict rules | Fast, safe enough with small amounts | CRE secrets (unsafe), user signing every trade (not autonomous) |
| How do users set up agents? | Templates + sliders | Simple and safe | Free-text prompts |
| What does "copy" mean? | Pay to copy the full setup | Clear product, clear fee | Mirroring every trade live |
| What's free vs paid? | Stats free, setup paid | Leaderboard attracts people; setup is the product | Showing trades for free |
| Who gets the fork fee? | Creator + platform | Your choice | Giving the agent a share |
| How does the agent make money? | Commission on its own profit | Real revenue, as 0G wants | Agent tokens (0G judges dislike these) |
| How does commission become AI credit? | Relayer with 0G float | Cheapest fees | Swap+bridge every time |
| Do we use comfy? | Only as a stretch, for an "0G Agent ID" badge | Not needed for the prize; adds manual steps | Agent token launches |
| What does Chainlink CRE do? | Verified stats + crash traffic light | Neutral, fake-proof, and actually used | Holding keys or placing trades |
| Where is memory stored? | Postgres + 0G Storage | Fast + tamper-proof | Database only |
| Twitter/X? | No API; share buttons + Telegram bot | API costs money | Paid X bot |
| AI features? | Text decisions, chart vision, image cards | Makes AI visible and essential | Voice, video |
| How much money in the demo? | A few dollars, all limits configurable | Safety | n/a |

---

## 7. The life of one trade (story)

1. **10:00.** Agent "Momentum Mike" wakes up.
2. It checks:
   - The crash light: 🟢 green.
   - Its AI budget: healthy.
   - Today's losses: fine.
3. It gathers ETH prices, indicators, its past lessons, and the latest news digest.
4. It asks 0G's AI, which replies: *"ETH likely +2% in 4h (70%). Buy $1 at limit 3,000, take-profit 3,090, stop-loss 2,940."* The reply comes with **request ID abc123**.
5. Safety rules check it: ETH allowed ✅, $1 ≤ limit ✅, stop-loss present ✅. **Approved.**
6. The agent's wallet signs the order. Flash places the limit order with the take-profit and stop-loss attached. It fills, and we get a BaseScan link.
7. Four hours later the take-profit hits: **+$0.03 profit**.
8. Chainlink CRE's Performance checker runs. It records "Mike's profit is now +$0.03, commission owed $0.003," onchain.
9. The treasury collects the commission. Later, when Mike's AI credit runs low, it tops up through the relayer, the 0G credit lands, and Mike keeps going.
10. The leaderboard updates with a ✅ Verified badge. Mike's owner gets a Telegram alert, and someone shares Mike's profit card on X.

---

## 8. What is the crash circuit breaker?

**The idea comes from stock exchanges.** When a market falls too fast, the exchange pauses trading for a while so panic doesn't make things worse. That's a "circuit breaker."

**Ours is a shared traffic light** stored in a small smart contract on Base called `RiskOracle`:

| Light | Meaning | What agents do |
|---|---|---|
| 🟢 NORMAL | Market is calm | Trade normally |
| 🟡 CAUTION | Market is shaky | Trade half size; skip risky breakout buys |
| 🔴 HALT | Crash or danger | **No new buys.** Cancel waiting buy orders. Then either tighten stop-losses or sell everything to USDC, depending on the owner's setting. |

**Who sets the light.** A Chainlink CRE workflow we write, called the "Crash Sentinel." Every couple of minutes, a network of Chainlink nodes:

1. Reads **Chainlink price feeds** (for example ETH/USD, BTC/USD). Did price drop sharply in the last few minutes?
2. Reads **outside market data**. Is volatility exploding? Is a stablecoin losing its $1 peg?
3. Optionally asks the **0G AI** to score recent headlines. For example: "major exchange hacked" scores high risk.
4. The nodes **agree on the result**, and the light is written onchain with Chainlink's signature.

**Why not just check this on our own server?**
- **Neutral and fake-proof.** Many independent Chainlink nodes agree on it. We can't quietly flip it.
- **Public.** Anyone, including other apps, can read the light and its full history onchain.
- **Accountability.** Because the light is onchain, anyone can check whether an agent kept trading during a 🔴 HALT. We show "followed the crash rules" as a leaderboard stat.

**One honest detail.** The light doesn't physically block Flash orders. Flash doesn't read our contract. *Our agent code* checks the light before every order. The onchain record is what proves whether agents obeyed.

**For the demo.** We press a "simulate crash" button, which triggers the CRE workflow. The light turns 🔴 onchain, and you watch the agent cancel its buy orders and tighten its stops.

---

## 9. Can we use a different chain for Flash?

**Yes.** Flash works on Base, Arbitrum, Ethereum, Optimism, Polygon, BNB Chain, Avalanche, Solana, HyperEVM, Plasma, Monad, Robinhood Chain, Ink, and Arc. Changing chains in our code is mostly one setting, because the Flash API is the same everywhere.

The chain has to work for **three things at once**:
- **Flash** must support it, for trading.
- **Chainlink CRE** must support it, to write verified stats and the crash light.
- **Our contracts** (treasury, marketplace) must live there, because the treasury pulls USDC from the agent's wallet on the same chain.

| Chain | Flash | Chainlink CRE | Gas cost | Verdict |
|---|---|---|---|---|
| **Base** | ✅ | ✅ | Very low | ✅ **Current choice.** Cheap, lots of USDC. |
| **Arbitrum** | ✅ | ✅ | Very low | ✅ Equally good alternative |
| Optimism | ✅ | ✅ | Low | ✅ Works; less trading liquidity |
| BNB Chain | ✅ | ✅ | Low | ⚠️ Works; USDC less common there |
| Polygon / Avalanche | ✅ | ✅ | Low | ⚠️ Works; less liquid for our coins |
| Ethereum mainnet | ✅ | ✅ | **High** | ❌ Gas costs more than our tiny trades |
| Monad / Ink / Plasma / HyperEVM | ✅ | ✅ | Low | ⚠️ Newer; check liquidity and Chainlink price feeds first |
| Arc, Robinhood Chain | ✅ | Testnet only for CRE | — | ❌ CRE can't write there on mainnet |
| Solana | ✅ | ✅ | Very low | ❌ Different wallet/signing tech; our contracts are EVM |

**Recommendation.** Stay on **Base**, or switch to **Arbitrum** if you prefer it. Both tick every box. Supporting several chains at once is possible later, but it multiplies wallets, contracts and testing, so it's not for the hackathon.

---

## 10. Who pays whom (money flow)

```
Owner ──USDC──► Agent wallet ──trades via Flash──► profit
                     │
                     └──commission (% of profit, set by CRE)──► AgentTreasury
                                                                  ├── reserve ──► relayer ──► 0G credit ──► agent's AI
                                                                  └── surplus ──► owner can withdraw

Forker ──fork fee (USDC)──► split: creator + platform
Every trade ──small Flash integrator fee──► platform
User-side AI (chart reading, share cards) ──► paid from the user's own 0G credits
```

---

## 11. Tech stack (simple)

| Part | Tool |
|---|---|
| Website | Next.js (React), wallet connect with RainbowKit |
| Agent engine | Node.js / TypeScript, job queue with Redis |
| Database | Postgres |
| Trading | Definitive Flash API |
| AI | 0G Private Computer (OpenAI-style API) |
| Memory proof | 0G Storage |
| Verified data + crash light | Chainlink CRE (TypeScript) + Chainlink price feeds |
| Smart contracts | Solidity with Foundry, on Base |
| Agent wallets | Privy or Turnkey server wallets |
| Bot | Telegram (grammy) |

---

## 12. Who builds what (4 people)

| Person | Builds |
|---|---|
| 1 | Website: leaderboard, agent builder, agent page, manual trading, copy checkout, share cards |
| 2 | Agent engine + Flash: wallets, safety rules, placing and tracking orders, profit calculation, Telegram bot |
| 3 | 0G: AI calls, budget tiers, daily caps, top-up relayer, memory + lessons, chart vision, image cards |
| 4 | Smart contracts + Chainlink CRE workflows + README, feedback docs, demo video |

---

## 13. Things we still need to find out

1. **Flash minimum order size.** Decides how small demo trades can be.
2. **Whether two 0G prizes count as one of our 3 sponsor picks** on ETHGlobal.
3. **Whether 0G lets users "sign in with 0G"** for the bonus. Ask at their booth.
4. **Whether Chainlink's test mode writes into our contracts**, or we need deploy approval.
5. **The 0G deposit contract details**, and the one-time 0G setup per agent.
6. **Fee percentages** (fork split, commission, platform fee).
7. **Product name.**

---

## 14. Can everything run on testnets?

**Short answer: almost everything, except the actual Flash trades.** Flash has no testnet, so real trades must happen on mainnet. Everything else has a testnet option, but a few of those options make the demo less convincing.

### 14.1 Part by part

| Part | Testnet? | Testnet option | Notes |
|---|---|---|---|
| **Flash trading** | ❌ **No** | None. No testnet, no sandbox, no dry-run flag. | Flash's own FAQ says to test with small amounts on Base. We *can* fetch prices (quotes) without trading, which is our "paper mode". The Definitive prize needs real onchain execution in the demo. |
| **0G AI (Private Computer)** | ⚠️ Maybe | Testnet console `pc.testnet.0g.ai`, API `router-api-testnet.integratenetwork.work/v1` | Documented, but the test API couldn't be reached during research. Its model list is unknown. The 0G credits given to hackathon teams are probably on mainnet. **Use mainnet: it's cheap and gives real request IDs.** |
| **0G AI (direct mode via SDK)** | ⚠️ Hard | Galileo testnet (chain 16602) | Needs at least 3–4 test 0G, while the faucet gives only 0.1 0G per day. You'd have to ask on Discord. |
| **0G Storage (memory)** | ✅ Yes | Galileo testnet, turbo indexer `indexer-storage-testnet-turbo.0g.ai` | Works fine. Addresses may change during testnet. |
| **comfy (optional agent ID)** | ❌ No | — | 0G mainnet only. It's a stretch goal anyway. |
| **Chainlink CRE workflows** | ✅ Yes | Base Sepolia (mock forwarder `0x8230…f3e5`), Arbitrum Sepolia, Ethereum Sepolia | Simulation is enough for the prize. A workflow can read real mainnet data, such as Flash trades over the internet or mainnet price feeds, and write to a testnet. Live deployment needs Chainlink's approval, and we don't need it. |
| **Chainlink price feeds** | ✅ Yes | Base Sepolia ETH/USD `0x4aDC…7cb1`, BTC/USD `0x0FB9…4298` | Live and updating on testnet. |
| **Test USDC** | ✅ Yes | Base Sepolia USDC `0x036C…CF7e`, faucet.circle.com (20 USDC every 2 hours) | Flash can't trade it. It's only useful for testing our contracts. |
| **Our smart contracts** | ✅ Yes | Base Sepolia | The catch: the treasury takes commission from the agent's wallet **on the same chain**. Real trades happen on mainnet, so a real commission needs the treasury on mainnet too. |
| **Agent wallets (Privy/Turnkey)** | ✅ Yes | Base Sepolia supported; wallet rules work the same | — |
| **Commission → 0G credit (relayer)** | ⚠️ Partly | Test USDC on Base Sepolia → test 0G on Galileo | There's no direct Chainlink CCIP bridge from Base Sepolia to 0G testnet, and no USDC on 0G testnet. Our relayer avoids bridging, so it can still work, but then the "money" is test money. Judges will notice. |
| **Website, database, Telegram bot** | n/a | — | Not blockchain. |

### 14.2 The parts that must be on mainnet

1. **Flash trades on Base**, with tiny amounts like $1 per trade. There's no alternative.
2. **comfy**, if we do the stretch goal.
3. **The self-funding money loop, if we want it to be real money.** The commission comes from real trades, so the treasury, and ideally the 0G credit it buys, must be on mainnet as well.

### 14.3 Recommended setup

| Stage | What runs where |
|---|---|
| **Building and testing (most of the hackathon)** | Contracts on **Base Sepolia** with test USDC. CRE simulations writing to Base Sepolia. 0G Storage on Galileo testnet. Flash in **quote-only "paper" mode**, with real prices and no trades. 0G AI on mainnet with the hackathon credits. A few real $1 Flash trades to test signing. |
| **Final demo** | Flash trades on **Base mainnet** ($1 each). Contracts redeployed to **Base mainnet** (gas is a few cents). CRE simulation writing to Base mainnet (mock forwarder `0x5e34…e548`). 0G AI and the relayer on **0G mainnet** with a small 0G float. Real money at every step of the loop. |

**Why not leave the demo contracts on testnet?** Trades happen with real USDC on mainnet. A testnet treasury would have to *pretend* to collect commission in test USDC. That weakens the 0G "Agents That Pay for Themselves" story, which is all about real money paying for real AI. The mainnet cost is only a few dollars.

**If you'd rather keep contracts on testnet,** it still works for the Chainlink prize. CRE can read the real Flash trades and write the stats to Base Sepolia. The commission loop would then be "simulated", and we must say so in the README.

### 14.4 One prize-rule doubt found while checking this

The Chainlink section of the prize page has one sentence under the **CCIP** prize: "Each project must use Chainlink CCIP… otherwise it will not be eligible for the **Chainlink core prizes**." It's unclear whether that applies to the **CRE** prize too. The CRE prize's own requirements don't mention CCIP. **Ask the Chainlink booth.**

If CCIP turns out to be required, the natural place is the relayer refilling its 0G. CCIP has lanes to the 0G chain (testnet lanes from Arbitrum and Ethereum Sepolia), so the occasional bulk refill could go through CCIP.

---

## 15. Mini glossary

| Term | Meaning |
|---|---|
| **Flash** | Definitive's trading API. Places smart orders on many blockchains. |
| **Advanced orders** | Limit, stop-loss, take-profit, TWAP (buy slowly over time), trailing stop, bracket (take-profit + stop-loss together) |
| **0G Private Computer** | Pay-per-use AI models with proof of each call (request IDs) |
| **0G Storage** | Decentralized storage; we keep a tamper-proof copy of agent memory there |
| **Chainlink CRE** | Lets a network of Chainlink nodes fetch outside data, agree on a result, and write it onchain |
| **Base** | A cheap Ethereum layer-2 blockchain, where our trades and contracts live |
| **Server wallet** | A wallet whose keys are held by a security provider, with rules about what it may sign |
| **Treasury** | Smart contract holding each agent's earned commission |
| **Relayer** | Our small automated service that swaps the agent's USDC for 0G credit cheaply |
| **Fork** | Paying to copy another agent's full setup |
| **High-water mark** | Commission is only charged on new profit highs, never on winning back earlier losses |
