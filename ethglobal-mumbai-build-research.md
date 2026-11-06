# ETHGlobal Mumbai — bounty resources and GitHub-based protocol ideas

Prepared 6 November 2026 from the [official ETHGlobal Mumbai prize page][1], linked official documentation, and a read-only inspection of seven public GitHub repositories. Scope assumption: the four bounty categories are **Chainlink CRE workflow**, **Whitechain Operate**, **Whitechain Tokenize**, and **Uniswap Build**. This is four categories across three sponsors; it excludes Chainlink CCIP, which is an adjacent separate bounty.

## The key architectural constraint

Do not force the four categories into one cross-chain transaction. The CRE TypeScript supported-network page, last updated 19 October 2026, does not list Whitechain Sepolia. It does list Ethereum Sepolia, Base Sepolia, OP Sepolia, Arc Testnet, and Unichain Sepolia. Run `cre workflow supported-chains` for the builder’s tenant before committing to a CRE destination. The published Uniswap deployment list includes v4 PoolManager deployments on chains such as Sepolia, Base Sepolia, OP Sepolia, and Unichain Sepolia; it does not list Whitechain in the current published list.[2] [3]

Whitechain Sepolia is chain ID **1874**, with public RPC `https://rpc.testnet.whitechain.io`, WBT as native gas token, and the bounty’s specified USDT test token at `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`. The Whitechain bounty requires a real test-USDT settlement in the main flow; a self-minted token does not count.[1] [4]

A modular repo can still use one shared invoice domain model, but present three distinct deployments/integrations: Whitechain for merchant settlement or invoice lifecycle; a CRE-supported EVM testnet for external-data attestation; and a chain with an official Uniswap v4 deployment for the hook/tooling module. Explain those boundaries honestly. Generic EVM compatibility is not proof that CRE supports a chain or that Uniswap contracts exist there.

## Official docs and resources from the four bounty categories

### Chainlink CRE workflow

- [CRE docs overview](https://docs.chain.link/cre) is the entry point for concepts, CLI, examples, and workflow templates.[5]
- [Part 1: project setup and simulation](https://docs.chain.link/cre/getting-started/part-1-project-setup) covers `cre init`, configuration, and the first local simulation.
- [Part 2: fetching offchain data](https://docs.chain.link/cre/getting-started/part-2-fetching-data) covers HTTP requests, node-mode execution, and consensus aggregation.
- [Part 3: reading onchain](https://docs.chain.link/cre/getting-started/part-3-reading-onchain-value) connects a workflow to contract reads.
- [Part 4: writing onchain](https://docs.chain.link/cre/getting-started/part-4-writing-onchain) covers signed reports and consumer-contract writes.
- [CRE TypeScript supported networks](https://docs.chain.link/cre/supported-networks-ts.md) is the chain/version list; verify the selected tenant with the CLI before coding a target-specific workflow.[2]
- [Official CRE templates repository](https://github.com/smartcontractkit/cre-templates) is the linked example collection.[6]
- [Intro to CRE video playlist](https://www.youtube.com/playlist?list=PLVP9aGDn-X0S-JmwQKGTao6o_CMitvv2_) is the linked learning resource.

The adjacent Chainlink section also links [CCIP docs](https://docs.chain.link/ccip), a [CCIP 2.0 LinkLab video](https://www.youtube.com/watch?v=jt2fM84DGVE), and a [Chainlink workshop video](https://www.youtube.com/watch?v=WXRnxM6gNGI). Those are useful stretch resources, but CCIP is not included in the four-category scope assumed here.[1]

### Whitechain Operate and Tokenize

Whitechain repeats most resource links across its four tracks. Its [docs index](https://docs.whitechain.io/llms.txt) lists the available Markdown pages and templates.

- [Whitechain docs landing page](https://docs.whitechain.io) and [Whitechain Sepolia network reference](https://docs.whitechain.io/learn/network/testnet.md) cover chain setup, chain ID, RPC, gas, and network details.[4]
- [Deploy a contract](https://docs.whitechain.io/learn/get-started/deploy-a-contract.md) supports Remix, Hardhat, or Foundry deployment on the standard EVM chain.
- [Next.js dapp starter guide](https://docs.whitechain.io/build/dapps/dapp-with-nextjs.md) and its [GitHub template directory](https://github.com/whitechain-labs/templates/tree/main/whitechain-dapp-nextjs) provide wallet connection and contract read/write wiring.[7]
- [Vite dapp template](https://docs.whitechain.io/build/dapps/dapp-with-vite.md) and [viem guide](https://docs.whitechain.io/build/dapps/use-viem.md) are alternatives for a smaller frontend.
- [Official Whitechain Sepolia faucet](https://faucet.testnet.whitechain.io) supplies test WBT for gas. The current page states one drip per GitHub account and a minimum GitHub-account age of 30 days.
- [Whitechain Sepolia explorer](https://explorer.testnet.whitechain.io) is for transaction and contract verification.
- [Ankr RPC activation link for hackers](https://www.ankr.com/rpc/?utm_referral=Whitechain2026) is linked for the event; check access and current limits in the portal.
- [Optimism](https://optimism.io) and the [OP Stack docs](https://docs.optimism.io) provide chain-framework context; implementing a rollup is not required by these Whitechain bounties.
- [Whitechain Builders Program](https://whitechain.io/builders) is a separate post-hackathon ecosystem/funding resource, not a hackathon qualification requirement.
- [YetiTrade testnet](https://testnet.yetitrade.fi) links its [quickstart](https://docs.yetitrade.fi/quickstart) and [API docs](https://docs.yetitrade.fi/api/overview). The test environment shows swaps and pools; the site warns that its test assets have zero monetary value.
- [Whitechain workshop video: “How to Win on Whitechain, Tracks and Tips”](https://www.youtube.com/watch?v=KULaCM9UslE) is the linked workshop recording.

The distinction between these two bounty categories matters. Operate favors a merchant-usable payment link/widget/SDK or plugin, both merchant and customer views, and a useful follow-up such as a refund, renewal, webhook, or export. A plain transfer/tip jar is not enough. Tokenize expects an asset lifecycle with actual contract-enforced rules; invoice financing belongs there, while merely paying an invoice belongs in Operate. Both require the specified USDT test settlement, verified contracts, a public repository with steady progress, a short demo, and `WHITECHAIN_FEEDBACK.md`.[1]

### Uniswap Build

- [Uniswap Developer docs](https://developers.uniswap.org/docs) cover the API, v2/v3/v4 protocols, SDKs, liquidity, and integration paths.[8]
- [Uniswap v4 hook guide](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/getting-started) walks through local setup and the `v4-template` starter.
- [Hook deployment guide](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment) explains permission bits encoded in the hook address and HookMiner/CREATE2 deployment patterns.
- [Uniswap deployments](https://developers.uniswap.org/deployments) and [Swap API supported chains/tokens](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains) should be checked before picking the target chain.[3]
- [Uniswap Developer Platform](https://developers.uniswap.org/dashboard/welcome) links the API/developer dashboard.
- [Uniswap AI Skills](https://www.skills.sh/uniswap/uniswap-ai) is optional tooling; using it does not require the product itself to be agentic.
- [Uniswap Developer Feedback Form](https://developers.uniswap.org/hackathon-feedback) is a required submission item alongside a public open-source repo and `FEEDBACK.md`. The form asks about integration, blockers, documentation/support, and whether the team plans to continue.[1] [9]
- [Official Uniswap v4-template GitHub repository](https://github.com/Uniswap/v4-template) is the starter referenced by the hook guide.[10]

## GitHub repositories inspected and what to build from them

The following are useful public codebases, not ready-made ETHGlobal submissions. **Directly adapting a template/example** is different from borrowing a pattern and writing your own implementation. None of these repo reviews establishes Whitechain/CRE/Uniswap chain compatibility beyond the evidence stated below.

### 1. Chainlink CRE SDK TypeScript — best direct foundation for a CRE MVP

The [CRE SDK TypeScript repository][11] includes examples for HTTP fetches, onchain writes, and CRE workflow compilation. In the inspected [HTTP-fetch workflow](https://github.com/smartcontractkit/cre-sdk-typescript/blob/main/packages/cre-sdk-examples/src/workflows/http-fetch/main.ts), an HTTP request is run in node mode and aggregated. The [onchain-write workflow](https://github.com/smartcontractkit/cre-sdk-typescript/blob/main/packages/cre-sdk-examples/src/workflows/on-chain-write/main.ts) demonstrates a trigger, config validation, onchain read, report generation, `writeReport`, and transaction-status handling.

**Build idea:** a non-agent *Invoice Milestone Attestor*. A scheduled workflow reads a delivery/approval status and invoice hash from a test API, rejects malformed or stale evidence, applies a stated agreement rule, and writes a signed report to a small receiver contract. A plain dashboard shows invoice ID, status, timestamp, evidence hash, and transaction. Use a categorical match/majority rule, not a numeric median. Keep this as an attestation demo; the repo does not provide invoice finance, Whitechain deployment, Uniswap integration, or a production oracle.

**Caveats:** inspected examples target configured CRE chains such as Sepolia and do not establish Whitechain support. The SDK package uses BUSL-1.1 with an Additional Use Grant; check the actual terms before commercial/production use. The SDK is tooling, not a turnkey product, and its examples are not an audit.[2] [11]

### 2. Chainlink CRE templates — strongest example for data-to-contract flow

The [official templates repo][6] contains a BYOD/NAV example that fetches external data, aggregates inputs, produces a CRE report, and writes it to EVM receivers. The [template README](https://github.com/smartcontractkit/cre-templates/blob/main/starter-templates/bring-your-own-data/README.md) calls the example educational/demo code, unaudited, and not production-ready. Its numeric NAV example uses floating-point parsing, which should not be copied for financial amounts.

**Build idea:** adapt the request/config/simulation pattern for an invoice-status API and a minimal receiver contract. Use integer minor units or validated decimal strings; enforce invoice uniqueness, authorization, freshness, and maximum amounts. This is direct adaptation of a workflow skeleton, not of an invoice product.

**Caveats:** the inspected NAV config targets Ethereum Sepolia and Base Sepolia; no Whitechain compatibility is shown. The repo is MIT licensed; preserve notices. It is the best starting point for a CRE demo, but not production data verification.[6]

### 3. Commerce Layer RAIL0 — payment lifecycle inspiration for Whitechain Operate

[RAIL0][12] implements an EVM stablecoin payment lifecycle: authorize, capture, charge, void, release, refund, and dispute signal. The inspected [`RAIL0.sol`](https://github.com/commercelayer/rail0/blob/main/contracts/src/RAIL0.sol) uses payment IDs, role checks, bounded balances, and lifecycle events; its tests cover partial captures/refunds. It is not a Whitechain checkout app and the repo notes that payment records/webhooks and SDK functionality live in separate components.

**Build idea:** a non-agent merchant payment-link/checkout kit on Whitechain with invoice creation, official test-USDT settlement, merchant receipt/webhook status, and a partial-refund action. Build a target-specific contract and thin SDK/widget. Borrow RAIL0’s explicit state machine and balance accounting rather than deploying it unchanged.

**Caveats:** RAIL0 requires EIP-3009 `receiveWithAuthorization` for accepted tokens; the Whitechain bounty’s specified USDT interface must be verified first. Its source pins Solidity 0.8.38 and Cancun/EIP-1153 behavior, so verify the target testnet’s opcode support before reuse. Its README says no external security audit has been completed. MIT license; follow its notices.[12]

### 4. Centrifuge Protocol — request/approval/claim pattern for receivables

[Centrifuge Protocol][13] is a substantial vault and tokenized-asset system, not a small invoice app. Its inspected [`AsyncVault.sol`](https://github.com/centrifuge/protocol/blob/main/src/vaults/AsyncVault.sol) demonstrates a staged request/manager approval/claim lifecycle; [`AsyncVaultFactory.sol`](https://github.com/centrifuge/protocol/blob/main/src/vaults/factories/AsyncVaultFactory.sol) demonstrates deterministic CREATE2 deployment.

**Build idea:** a small receivables pool in which investors request stablecoin participation, an issuer/manager processes one batch, and approved investors claim shares after a CRE-verified invoice milestone. Keep only one request/approve/claim path; do not port the full hub-and-spoke protocol.

**Caveats:** the repo is too large for a hackathon port and does not establish Whitechain support or CRE/Uniswap integration. Its primary license is BSL-1.1 with an Additional Use Grant; production use needs license review. The repo distinguishes main from deployed/release branches. It is inspiration, not a turnkey open-source drop-in.[13]

### 5. CMTA CMTAT — permissioned RWA token patterns

[CMTAT][14] is a modular security-token framework, with examples for role-gated issuance, allowlists, freezes, pauses, and document references. Its [allowlist documentation](https://github.com/CMTA/CMTAT/blob/master/doc/modules/options/allowlist/allowlist.md) and [enforcement tests](https://github.com/CMTA/CMTAT/blob/master/test/standard/modules/EnforcementModule.test.js) show checks around transfer sender/recipient and privileged freeze operations.

**Build idea:** a simple invoice-receivable token demo: hash the invoice document off-chain, register its face value/due date, permit only approved investor wallets to receive the claim token, and show issuance plus redemption after repayment. Borrow the permissioning and lifecycle model; do not place confidential invoice files onchain.

**Caveats:** it is not an invoice marketplace or Whitechain-ready submission. Its Foundry config uses Solidity 0.8.38/Osaka and the inspected deployment uses transient-storage protection; check opcodes/compiler support before deploying on Whitechain. CMTAT uses MPL-2.0. The latest observed v3.3.0 release (4 Nov 2026) says it is unaudited; README identifies v3.0.0 as the latest audited release. New work based on it requires careful version-specific review.[14]

### 6. Uniswap v4-template — cleanest Uniswap hook starter

The [official v4-template][10] is a Foundry starter whose [`Counter.sol`](https://github.com/Uniswap/v4-template/blob/main/src/Counter.sol) records `beforeSwap`/`afterSwap` and liquidity callback counts by PoolId. Its [tests](https://github.com/Uniswap/v4-template/blob/main/test/Counter.t.sol) exercise a local PoolManager, pool setup, swaps, and liquidity changes.

**Build idea:** a small *Pool Policy or Health Hook*: record a narrow set of pool events, enforce one transparent pool-specific rule (for example, an allowlisted fee tier or simple circuit-breaker threshold), and expose readable events to a dashboard. Add tests around allowed and rejected swaps. A CRE alert is optional and separate; the template itself includes no CRE workflow.

**Caveats:** this is a hook skeleton, not payments or invoice finance. Hooks need a compatible PoolManager and, for public deployment, correctly mined hook permissions/address. Use a network with an official Uniswap deployment; the repo does not establish Whitechain support. MIT license. Its visible latest main-branch commit was Oct. 2025, so inspect current dependencies before starting.[10]

### 7. Uniswap Universal Router — command-plan design inspiration, not a starter

[Universal Router][15] composes token operations using command bytes and encoded inputs. Its [`Commands.sol`](https://github.com/Uniswap/universal-router/blob/main/contracts/libraries/Commands.sol) and [`Dispatcher.sol`](https://github.com/Uniswap/universal-router/blob/main/contracts/base/Dispatcher.sol) are useful for understanding bounded plans, required versus optional steps, and sweep/refund cleanup.

**Build idea:** a deterministic, non-agent *QR Invoice Payment Plan Compiler*. It turns an invoice into a human-readable plan with an exact token transfer, deadline, minimum output, and receipt. The user reviews and signs it. Build a narrow contract/SDK rather than copy Universal Router wholesale.

**Caveats:** this is a large production-oriented router, not a checkout starter. It needs chain-specific Uniswap/Permit2 dependencies and deployed addresses; Whitechain is not established as a target. Its root license and Solidity SPDX headers say GPL-3.0-or-later, while `package.json` says GPL-2.0-or-later; resolve that inconsistency before reuse. Review exact-version security and license terms.[15]

## Other buildable protocol ideas and suggested scope

1. **Invoice Milestone Attestor — cleanest CRE-focused MVP.** One API, a CRE workflow, one supported test chain, one small registry, and a read-only UI. This avoids financial-custody complexity and directly demonstrates the Chainlink bounty’s core.
2. **Merchant Invoice Checkout Kit — strongest Whitechain Operate product.** Payment link/widget, official USDT payment, order receipt/webhook, and refund/partial refund. This is a better fit than a generic “pay” button. Verify token behavior before choosing EIP-3009 or another authorization method.
3. **Permissioned Receivable Token — Whitechain Tokenize alternative.** Issuance, allowlist transfer, maturity/payment condition, and one repayment/redemption. Keep it to a single asset and one lifecycle path; do not build an unrestricted marketplace.
4. **Uniswap v4 Pool Health/Policy Hook — Uniswap-focused protocol option.** A small hook plus rigorous local tests and an event dashboard; deploy only where a compatible PoolManager is confirmed.
5. **Invoice Settlement Toolkit with separate chain adapters — one repo, modular modules.** Share an `Invoice` schema, SDK, and lifecycle vocabulary, but treat Whitechain checkout, CRE attestation, and Uniswap liquidity as distinct adapters/deployments. Do not claim an atomic cross-chain action until supported chain lanes and deployed contracts are proven.
6. **Deterministic QR payment-plan compiler — tooling-heavy option.** Compile an invoice into a user-reviewed bounded transaction plan with deadline, amount limits, explicit refunds/cleanup, and a receipt event. Borrow router design ideas, but implement a small allowlisted command set rather than a general-purpose router.

### My recommendation

For **one focused MVP**, choose the *Invoice Milestone Attestor* if the main priority is the Chainlink prize: CRE explicitly accepts a successful CLI simulation, and the official current network list shows Sepolia support. Keep stablecoin settlement out of the attestor’s main function.

If the priority is a **more user-facing product and Whitechain**, anchor the repo on the *Merchant Invoice Checkout Kit* and treat invoice financing as a separate stretch. The event requires genuine test-USDT settlement and both merchant/customer views, so implement and demo those before adding a v4 hook or CRE module. A later version can share invoice IDs and status schemas across chain-specific adapters without representing them as one integrated network.

## References

[1]: https://ethglobal.com/events/mumbai/prizes "ETHGlobal Mumbai prize tracks"
[2]: https://docs.chain.link/cre/supported-networks-ts.md "Chainlink CRE supported networks for TypeScript"
[3]: https://developers.uniswap.org/deployments "Uniswap protocol deployment addresses"
[4]: https://docs.whitechain.io/learn/network/testnet.md "Whitechain Sepolia network reference"
[5]: https://docs.chain.link/cre "Chainlink CRE documentation"
[6]: https://github.com/smartcontractkit/cre-templates "Chainlink CRE templates"
[7]: https://github.com/whitechain-labs/templates/tree/main/whitechain-dapp-nextjs "Whitechain Next.js dapp template"
[8]: https://developers.uniswap.org/docs "Uniswap Developer documentation"
[9]: https://developers.uniswap.org/hackathon-feedback "Uniswap Developer Feedback Form"
[10]: https://github.com/Uniswap/v4-template "Uniswap v4 template"
[11]: https://github.com/smartcontractkit/cre-sdk-typescript "Chainlink CRE TypeScript SDK"
[12]: https://github.com/commercelayer/rail0 "Commerce Layer RAIL0"
[13]: https://github.com/centrifuge/protocol "Centrifuge Protocol"
[14]: https://github.com/CMTA/CMTAT "CMTA CMTAT"
[15]: https://github.com/Uniswap/universal-router "Uniswap Universal Router"
