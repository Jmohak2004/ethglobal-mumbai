# Integration debrief (DRAFT)

> **DRAFT.** The friction items below were pre-filled from our PRDs (`PRD.md`, `PRD_SIMPLE.md`), code TODOs, and the CRE README "Deviations" and "Day-1 checklist". The team must verify each item, add what we actually hit, and fill every `[TBD]` before this is submitted. Delete items that turn out to be our mistake, not the vendor's.

Submission note: the PRD (section 15) asks for debriefs in `docs/feedback/`. This draft is one file at `docs/FEEDBACK.md`, as requested.

Fields per vendor:

- **Time to first success:** how long from first API key to the first successful call that matters (a live order, an onchain decision, a CRE write).
- **Friction:** concrete things that cost us time.
- **Missing docs or capabilities:** what we needed and could not find.
- **Top improvement:** one change that would help most.

---

## 1. Definitive Flash

**Our use:** limit, TWAP, stop-buy, bracket (take-profit and stop-loss), and trailing-stop orders from the worker and the manual trading terminal, plus quotes, fills, and cancel and PATCH for crash handling. Code: `packages/flash/`.

**Time to first success:** [TBD: time from key to first quote; time from first quote to first live fill, with date and network]

**Friction (pre-filled, verify each):**

- **No testnet, sandbox, or dry-run flag.** Every test order is a mainnet order, so paper mode can fetch quotes but cannot prove execution. PRD_SIMPLE section 14.1.
- **Minimum notional is not documented.** We cannot size the demo budget (`MAX_TRADE_USD`) until we probe it. PRD section 16 and PRD_SIMPLE section 13.1.
- **TWAP minimum duration differs from our reading of the docs.** The API enforces `durationSeconds >= 300` (`packages/flash/src/mapping.ts`, `types.ts`). Our PRD says 10 minutes. We followed the API. Confirm the documented minimum.
- **Cancel and PATCH need a signed message, and its format is not in the docs we used.** `CancelOrderRequestSchema` requires `cancelMessage`. Nothing in our repo produces it yet, so live cancel and stop changes are not wired (`apps/worker/src/runtime.ts`, `orderControl: null`). This directly affects the crash circuit breaker demo. [TBD: confirm whether the docs cover this now]
- **Units are ambiguous.** Our CRE attestor assumes `targetAmount` is a human-unit string of the traded asset and `notional` and `feeNotional` are USD. We have not verified that with a real order. `cre/README.md` (Day-1 checklist). [TBD: confirm with one real order]
- **List endpoint returns orders without fills.** Fills come from `GET /orders/{orderId}`. `cre/README.md` (Deviations).
- **Status filter value.** We use `ORDER_STATUS_FILLED`. The docs we read showed `filled`. `cre/README.md` (Deviations). [TBD: is the doc now updated?]
- **Rate limit is 5 requests per second per endpoint per key.** This is not enforced in our client, and our attestor makes one detail call per filled order. PRD section 11.2 and `cre/README.md`.
- **Cross-chain orders can redirect funds through `recipientAddress`.** We disabled them. Add a note to the docs that integrators should disable them too. PRD section 11.1.
- **Integrator fee and where it is set.** `FLASH_INTEGRATOR_FEE_BPS` is ours to set. We could not find the docs for the exact on-chain effect in the sources we used. [TBD]

**Missing docs or capabilities:**

- [TBD] A testnet or a way to dry-run an order.
- [TBD] Minimum order size per token and per chain.
- [TBD] The `cancelMessage` and PATCH signing format, with an example.
- [TBD] Documented rate limits and WebSocket reconnection behaviour.

**Top improvement:** [TBD: team's pick. Our suggestion is a testnet or dry-run endpoint, since it would unblock the whole test loop.]

---

## 2. 0G (Private Computer, Router, Storage, Payment Layer)

**Our use:** per-agent decisions through the Router (with request IDs), reflections and lessons, chart vision, share-card images, 0G Storage for memory roots, and the Payment Layer deposit that funds each agent's compute credit. Code: `packages/zerog/`, `apps/worker/src/economics/relayer.ts`, `apps/worker/src/provisioner.ts`.

**Time to first success:** [TBD: time from platform key to first decision with a request ID; time to first Payment Layer deposit]

**Friction (pre-filled, verify each):**

- **Per-agent account and key setup is manual.** We could not find a documented programmatic way to create a Router account per agent. Our code mints a capped key through the management key (`ZeroGAccount`, `POST /v1/api-keys`), but account creation is not covered. PRD section 16 and `packages/zerog/src/account.ts`. [TBD: confirm the current docs]
- **Payment Layer deposit ABI is unclear on testnet.** The mainnet proxy's implementation is verified (`depositFor(address user) payable`). The Galileo proxy points at an unverified implementation, so we assume the same ABI. `packages/zerog/src/payment.ts` (TODO testnet). [TBD: did a zero-value `eth_call` dry run confirm it?]
- **Testnet router was not reachable during research.** `router-api-testnet.integratenetwork.work/v1` could not be reached, and the testnet model list is unknown. PRD_SIMPLE section 14.1. [TBD: retest]
- **Testnet faucet gives 0.1 0G per day.** Direct-mode ledgers need roughly 3 to 4 0G, which makes testing slow. PRD_SIMPLE section 14.1.
- **No "sign in with 0G" or OAuth is documented.** We cannot offer the iAI bonus flow without the BYOK fallback. PRD section 1.2. [TBD: answer from the booth]
- **Model discovery.** Our CRE WF2 config has a placeholder `llm.model` (`SET-FROM-0G-ROUTER-MODELS`) because we could not find a stable model ID list to pin. `cre/wf2-crash-sentinel/config.*.json`. [TBD: which model ID is recommended for classification?]
- **No public 0G price feed.** The relayer uses CoinGecko (`zero-gravity` ID) and falls back to a manual `ZG_PER_USDC`. `apps/worker/src/economics/relayer.ts`.
- **Storage testnet indexer addresses may change.** PRD_SIMPLE section 14.1. [TBD: current addresses]

**Missing docs or capabilities:**

- [TBD] Programmatic account and per-agent key creation, with the scopes of `mk-` management keys.
- [TBD] A verified, documented Payment Layer deposit ABI for each network.
- [TBD] Stable testnet endpoints and a testnet model list.
- [TBD] A documented sign-in (OAuth or equivalent) for the user-funded AI flow.
- [TBD] A machine-readable model list with pricing.

**Top improvement:** [TBD: team's pick. Our suggestion: a documented, programmatic per-agent account and key API, so agents can be onboarded without the console.]

---

## 3. Chainlink CRE

**Our use:** WF1 (Performance and Commission Attestor, cron every 15 minutes plus HTTP trigger) reads `AgentRegistry`, Chainlink feeds, and Flash fills, then writes a consensus report to `PerformanceRegistry`. WF2 (Crash Sentinel, cron every 2 minutes plus HTTP trigger) reads feeds and CoinGecko, optionally a 0G LLM score, then writes to `RiskOracle`. Code: `cre/`.

**Time to first success:** [TBD: time from `cre login` to first successful simulation; time to first `--broadcast` report on Base Sepolia]

**Time to first success, live deployment:** [TBD: approval status for `cre account access`]

**Friction (pre-filled, verify each):**

- **Mock forwarder: unclear whether `--broadcast` calls `onReport`.** Our contracts only accept reports from their forwarder, so if the simulation does not reach `onReport`, nothing lands onchain. We need a clear answer on how the simulation forwarder relates to `onReport`. `cre/README.md` (Day-1 checklist, Forwarder), PRD section 16. [TBD: result of our test]
- **Cron format.** The docs define a 6th optional field as seconds, so the PRD's `"0 */15 * * * *"` is ambiguous. We use 5-field expressions in the committed configs. `cre/README.md` (Deviations).
- **Secrets are not available in node mode.** `NodeRuntime` has no `getSecret`, so secrets are read on the DON runtime and passed into node mode as input. `cre/README.md` (Deviations).
- **Consensus fails if nodes see different fills.** `identical` aggregation requires every node to produce the same bytes. We added 60-second cached GETs to keep nodes aligned. `cre/README.md` (WF1 step 4 and Day-1 checklist).
- **HTTP trigger authorization.** The committed configs have empty `httpAuthorizedKeys`. The docs say an empty list is accepted only for simulation, and we want that stated more clearly. `cre/README.md` (Day-1 checklist).
- **`cacheSettings` dedup is best-effort, so duplicate LLM calls are possible.** `cre/README.md` (WF2 step 3).
- **Forwarder addresses come from the CRE docs, not a single source.** We keep copies in `packages/shared/src/chains.ts` and `cre/lib/chains.ts`. `contracts/README.md`.
- **Base mainnet feed addresses need verification.** We confirmed ETH/USD only partially and could not confirm BTC/USD. Both are marked VERIFY in our code. `cre/README.md` (Day-1 checklist).
- **Deploy approval.** Live deployment needs Chainlink approval, and our day-1 request has [TBD: status]. PRD sections 1.4 and 11.1.
- **CCIP wording in the prize rules is ambiguous.** It is unclear whether the CCIP requirement applies to the CRE prize. PRD section 16 and PRD_SIMPLE section 14.4. [TBD: booth answer]
- **Runtime restrictions surface only at compile time.** `cre-compile` rejects `fetch`, `setTimeout`, and `node:*`, and it rejects `Date.now()` and `new Date()` without arguments. The rules are clear once you hit them, but the docs could state them up front. `cre/README.md`.
- **Test mode and writes.** Whether CRE's test mode writes into our contracts, or needs deploy approval, was an open question. PRD_SIMPLE section 13.4. [TBD]

**Missing docs or capabilities:**

- [TBD] The exact semantics of `--broadcast` through the mock forwarder, with an example that ends in an `onReport` call.
- [TBD] A single page listing forwarder addresses per chain, simulation and production.
- [TBD] Guidance on consensus when a node's HTTP view differs (for example, use cached reads or a dedicated aggregation).
- [TBD] A clear and quick path to deploy access for hackathon teams.

**Top improvement:** [TBD: team's pick. Our suggestion: a one-command simulation that proves an `onReport` write through the mock forwarder, with the transaction hash printed.]

---

## Cross-cutting (optional)

- [TBD] Anything that helped most. For example, sample repos or templates.
- [TBD] Anything we would tell the next team to avoid.
