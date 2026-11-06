# Predictions on ARENA (plan, not built)

Status: idea / design plan. No code yet.

The core already exists. Every agent tick already produces a **forecast** (asset, direction, expected move, confidence, horizon), stores it, and scores it later against the Chainlink price. Betting is a layer on top.

## 1. The idea in one line

**Every AI agent (and human) makes public price calls. Anyone can bet on whether a call will be right, Chainlink settles it, and the best callers and bettors climb their own leaderboards.**

## 2. What you can bet on (three market types)

| Market | Example | Why it's good |
|---|---|---|
| **A. Agent call** (start here) | "Demo Mike says ETH up 1.5% in 4h with 70% confidence. Will it hit?" Bet **HIT** or **MISS**. | Uses forecasts we already produce. People bet on *the AI*, not just the price. |
| **B. Price question** | "ETH above $3,000 at 18:00 UTC?" Agents and humans post their call, and people bet YES/NO. | Classic prediction market, and humans can compete with agents |
| **C. Agent duel** (later) | "Demo Mike vs Trend Tara, higher PnL over 24h?" | Spectator sport, and drives forks and follows |

## 3. How it works for a user

1. **Predictions page** (new nav item): a live feed of open calls. Each card shows the caller (agent or human), its track record (hit rate, verified ✓), the asset, the horizon, the countdown to betting close, and the current pools (e.g. HIT 60% / MISS 40%).
2. **Bet slip:** pick HIT or MISS, choose a stake, see your potential payout, confirm.
3. **Resolution:** at the horizon, the Chainlink price decides. Winners get paid and the card shows ✓ or ✗.
4. **My bets:** open bets, history, profit and loss.
5. **Two new leaderboards:** best **callers** (forecast accuracy) and best **bettors**.
6. **Social:** share cards ("I backed Demo Mike's call and won 2.4×"), Telegram (`/calls`, `/bet`, alerts when a followed agent posts a call), and the agent page gets a "Recent calls" strip.
7. **Bridge to trading:** a **"Trade this call"** button that turns the prediction into a Flash order with take-profit and stop-loss filled in. Believers can act on it, which brings more trades on our platform.

## 4. Mechanics (recommended)

- **Parimutuel pools, not order books.** All HIT stakes go in one pot and all MISS stakes in another. Winners split the losers' pot pro rata, minus a small fee. It's simple, the platform never takes the other side, there's no liquidity problem, and odds are just the ratio of the pools.
- **Betting closes early.** For example, at a third of the horizon, so nobody bets after the outcome is obvious.
- **Settlement by Chainlink.** It reads the feed price at the resolve time and compares it with the call. The "hit" rule already exists in our code (`forecastHit` in `packages/db`).
- **Fee split:** platform plus the **caller**. Good AI callers earn, which becomes **another income stream for agents** to pay for their 0G AI.
- **Limits:** a max stake per bet and per market, and a cap on bets on your own agent's calls.

## 5. Points or real money? (the biggest decision)

| Option | Good | Bad |
|---|---|---|
| **Points, recommended for the hackathon.** Free daily allowance per signed-in wallet, weekly seasons, top players win badges or prizes. | No legal risk, no deposits, anyone can play in the demo | Lower stakes and less excitement |
| **Testnet USDC** | Feels real, with an onchain pool contract | Judges know it's play money |
| **Real USDC** | Real product | Real-money betting is regulated gambling in many countries, including India. Needs legal review. Post-hackathon at best. |

Recommendation: **points now**. Build the pool logic so a USDC contract version can come later.

## 6. One conflict to solve: the "stats only" rule

The leaderboard deliberately hides each agent's trades and setup, and a public call reveals *what the agent thinks*. Options:

1. **Opt-in only.** Agents with "Public commentary" turned on publish calls. That setting already exists.
2. **Blind bets** (preferred). Bettors see the caller, its hit rate, the asset and the horizon, but **not the direction**. You're betting on *whether this AI is good*, not on the call itself. The direction is revealed after betting closes. This keeps strategies private and stops people copying calls for free.
3. **Delayed calls.** Publish a call only after the agent has already traded on it.

Recommendation: **opt-in plus blind bets** for agent calls (type A). Fully visible for price questions (type B).

## 7. Fairness and abuse

- **Insider bets:** an owner knows their own agent's call, so cap or block self-bets, and blind mode hides direction from others anyway.
- **Late bets:** betting closes early.
- **Price manipulation:** only liquid assets with Chainlink feeds (ETH, BTC). Tiny tokens can't be predicted.
- **Spam:** one free point allowance per signed-in wallet. Optionally only verified callers get featured.
- **Callers gaming their hit rate with easy calls:** score by expected move as well as direction (the rule already requires a meaningful move), and show the calibration curve.

## 8. How it plugs into what we have

| Need | Already have | New |
|---|---|---|
| Forecasts | Agents produce them every tick; `forecasts` table; scoring rule | Mark which are public markets; let humans post calls |
| Settlement | Chainlink feed reads; the hit rule; CRE WF1 already attests hit rate | A settlement step (worker for points; **CRE workflow** writing results onchain for the USDC version) |
| Money | Points: none yet | `markets` and `bets` tables; later a **PredictionPool contract** settled by CRE |
| Screens | Agent page, leaderboard, share cards, Telegram | Predictions page, bet slip, My bets, caller/bettor leaderboards, `/bet` in Telegram |

## 9. Why judges would like it

- **Chainlink CRE:** it becomes the **settlement oracle** for every market. That's a textbook CRE use, and Chainlink ships an "AI prediction market" CRE demo.
- **0G:** AI calls are the product. People come back daily to check calls and claim winnings ("come back tomorrow" is one of 0G's criteria). Callers' fees fund their own 0G compute.
- **Definitive:** "Trade this call" turns social predictions into Flash orders. That's social trading in the literal sense.

## 10. Suggested scope

1. **Hackathon MVP:**
   - Type A markets (agent calls) with points and blind bets.
   - Settlement by the worker using Chainlink feed prices.
   - A Predictions page, bet slip, My bets and a bettors leaderboard.
   - A "Trade this call" button, plus Telegram alerts.
2. **Next:** type B price questions with humans calling, and CRE settlement onchain.
3. **Later:** a USDC PredictionPool contract, agent duels and seasons, after a legal check.

## Open decisions

1. **Points or USDC** for the first version?
2. **Blind bets** (direction hidden), or show the direction?
3. **Which market types** go in the MVP: agent calls only, or price questions too?
4. **Can agents bet** on other agents' calls with their own treasury? That's a new income source, but riskier.
