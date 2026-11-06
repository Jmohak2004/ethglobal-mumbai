# Continuity — Codex Build Spec

> Drop this file in the repo root (or `docs/`) and ask Codex:
> `Implement Continuity per CONTINUITY_SPEC.md. Start with Phase 0–1. Dry-run by default. Do not spend funds unless EXECUTION_MODE=live.`

## Product one-liner

**Continuity** is a Telegram-facing panic agent: detect or manually fire a risk event → **warden policy** → exit to USDC on **Base** via **Definitive Flash MCP**. Creativity track primary; Spot trading is proof that Flash fills work. Optional second intent: **trust-gated X copy-trade** through the same warden.

Flash MCP is **not** the product. It is the execution toolkit (`@definitive-fi/flash-mcp`).

## Non-goals (v1)

- Full DCA / trading shop UI
- Blind social copy / firehose scraping
- LP manager as the headline (LP withdraw may be a pre-step later)
- Hardware FlashLatch
- Multi-chain panic (Base only for demo)

## Stack

- **Runtime:** Node.js 20+, TypeScript
- **Queue:** Redis (`BRPOP` / `LPUSH` on `panic:queue`)
- **Bot:** `grammy` or `telegraf` (Telegram)
- **Flash:** `@definitive-fi/flash-mcp` tools via thin client wrapper (or Flash REST equivalent if MCP stdio is awkward in-process — prefer calling the same semantics)
- **Config:** `dotenv` + env vars below
- **Monorepo layout (suggested):**

```
packages/
  agent/
    src/
      panic/
        worker.ts
        policy.ts
        propose.ts
        flash.ts
        ledger.ts
        types.ts
      copy/
        signal.ts
        parse.ts
      bot/
        telegram.ts
        commands.ts
      index.ts
    package.json
  shared/
    src/types.ts
.env.example
CONTINUITY_SPEC.md
README.md
```

## Environment

```bash
EXECUTION_MODE=dry_run          # dry_run | live
PANIC_SEVERITY_MIN=0.7
MAX_EXIT_USD=500
FLASH_STABLE=USDC
FLASH_CHAIN=base
REDIS_URL=redis://127.0.0.1:6379
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=      # comma-separated
DEFINITIVE_API_KEY=
DEFINITIVE_PRIVATE_KEY=
# optional copy-trade
COPY_ALLOWLIST_HANDLES=         # e.g. some_trader
COPY_MAX_USD=50
```

## Core types

```ts
export type ExecutionMode = "dry_run" | "live";

export type PanicEvent = {
  id: string;
  severity: number; // 0..1
  reason: "depeg" | "exploit" | "pool" | "price" | "manual" | "copy";
  funder: `0x${string}`;
  chain: "base";
  positions: { asset: string; qty: string; usdEstimate?: number }[];
  safeRecipient?: `0x${string}`;
  source?: { kind: "scanner" | "telegram" | "x"; ref?: string };
  createdAt: string; // ISO
};

export type PolicyDecision =
  | { ok: true; mode: ExecutionMode; maxUsd: number }
  | { ok: false; code: string; message: string };

export type ExitPlan = {
  eventId: string;
  orderType: "market" | "twap" | "stop" | "bracket";
  legs: {
    targetAsset: string;   // sell this
    contraAsset: string;   // USDC
    qty: string;
    chain: "base";
    twapBucketCount?: number;
  }[];
  estimatedUsd: number;
  confirmationText: string; // e.g. "FLEE"
};

export type LedgerRow = {
  at: string;
  eventId: string;
  kind: "refused" | "planned" | "submitted" | "filled" | "cancelled" | "error";
  detail: Record<string, unknown>;
};
```

## Phase 0 — Skeleton

**Deliverables**

- [ ] Package bootstrap, `tsconfig`, scripts: `dev`, `worker`, `bot`
- [ ] `.env.example` + README “how to run”
- [ ] Redis ping + empty worker loop that logs “idle”
- [ ] Telegram bot replies `/ping` → `pong` (allowlist users only)
- [ ] `flash.ts` stub: `status()` returns mock if no key; real `flash_status` when configured
- [ ] `ledger.ts`: append JSONL under `data/ledger.jsonl`

**Acceptance:** `pnpm worker` + `pnpm bot` start without crashing; `/ping` works.

## Phase 1 — Continuity core (dry-run)

**Worker loop**

1. `BRPOP panic:queue 5`
2. Parse `PanicEvent`
3. `policy_check(event)`
4. If refuse → ledger `refused` → Telegram notify → continue
5. `propose_exit(event)` → ledger `planned` → Telegram plan card
6. If `dry_run` → fake fill after 1s → ledger `filled` (simulated) → **do not** call Flash submit
7. If `live` → require recent `/confirm FLEE` (60s TTL in Redis) else refuse

**Policy rules**

- `severity >= PANIC_SEVERITY_MIN` (manual `/panic` may set severity=1)
- `chain === "base"`
- Each asset symbol/address on allowlist (start with WETH, USDC, cbETH — configurable)
- Sum `usdEstimate` ≤ `MAX_EXIT_USD`
- `EXECUTION_MODE` respected

**Propose rules**

- `estimatedUsd < 100` or `severity >= 0.9` → `market`
- else → `twap` with `twapBucketCount` 4–8
- All legs → `FLASH_STABLE` (USDC) on Base

**Telegram commands**

| Command | Behavior |
|---------|----------|
| `/status` | mode, redis ok, last ledger rows, flash_status summary |
| `/arm` | enable accepting panic (flag in Redis) |
| `/disarm` | disable auto/manual exits |
| `/panic` | push manual PanicEvent (severity=1) for configured demo positions |
| `/confirm FLEE` | set live confirm key 60s |
| `/balances` | flash balances for funder (read-only) |

**Acceptance:** Disarmed → panic refused. Armed + low severity → refused. Armed + `/panic` → dry plan + simulated fill in Telegram. No chain txs.

## Phase 2 — Flash live (Spot proof)

**flash.ts real methods**

- `quote(leg)` → `flash_quote`
- `submit(leg)` → `flash_submit_order` **or** prefer `flash_submit_signed_order` if external sign path is wired
- `getOrder(id)` / `listOrders()` / `cancel(id)`

**Live path**

1. Confirm TTL valid
2. Per leg: quote → submit → poll until terminal (`filled` / `cancelled` / failed)
3. Ledger + Telegram: orderId, fill vs quote, explorer link if available
4. Hard cap: abort if quote notional > `MAX_EXIT_USD`

**Safety**

- Default `EXECUTION_MODE=dry_run`
- Refuse live if `DEFINITIVE_PRIVATE_KEY` missing
- Never log private keys or full "xxaxxpixxkey"
- No blind retry on submit timeout — `getOrder` / `listOrders` first

**Acceptance:** With tiny funded wallet + `live` + confirm, one dust sell to USDC on Base completes and shows in `/status`.

## Phase 3 — Protect polish

- Pre-arm: `/protect` places optional Flash `stop` or `bracket` while calm (document params in code)
- Severity mapping: `< min` alert only; mid TWAP; high market + cancel open non-protect orders if list available
- Telegram “receipt” template: eventId, orderType, quoteUsd, fillUsd, slippage bps, fees if present

**Acceptance:** Demo script: refuse → dry TWAP → live dust → receipt.

## Phase 4 — Copy-trade agent (stretch)

**Do not** scrape Twitter firehose. Support:

1. Allowlisted handle via official X API **or**
2. Demo path: `/copy <tweet_url_or_text>` paste

**Flow**

- Parse rough intent: side, asset, size (usd or qty) — fail closed if ambiguous
- Build `PanicEvent` with `reason: "copy"` and moderate severity
- **Same** `policy_check` with `COPY_MAX_USD`
- Plan card → `/confirm COPY` → dry or live Flash

Commands: `/follow`, `/unfollow`, `/copy`, `/confirm COPY`

**Acceptance:** Pasted sample tweet → refused if over cap → dry plan → optional dust live.

## Phase 5 — Optional

- `safeRecipient` cross-chain after USDC (Flash recipient field)
- YAML policy file (`policy.yaml`) loaded at boot
- Minimal web page: last 20 ledger rows + Fire button (POST → Redis)
- Uniswap LP withdraw hook **before** Flash legs (separate module; not headline)

## Demo script (judges)

1. `/status` — dry_run, armed  
2. Push low-severity event → refused  
3. `/panic` → plan card (TWAP/market) → simulated fill  
4. Flip `live`, fund dust, `/confirm FLEE`, `/panic` → real Flash fill + receipt  
5. (Optional) `/copy` sample → gated plan  

## README must include

- What Continuity is vs Flash MCP  
- Env table  
- Phase status checklist  
- Security: dry_run default, allowlist Telegram IDs, no keys in chat  
- Definitive links: https://www.npmjs.com/package/@definitive-fi/flash-mcp and https://flash.definitive.fi/docs  

## Coding rules for Codex

1. Implement phases in order; do not skip to copy-trade before Phase 1 works.  
2. Every Flash submit path must check `EXECUTION_MODE` and policy.  
3. Prefer small pure functions in `policy.ts` / `propose.ts` with unit tests.  
4. Telegram handlers must catch errors and never crash the process.  
5. Use structured logging (JSON lines), never print secrets.  
6. If Flash MCP stdio is hard in-process, implement `flash.ts` against Flash HTTP API with the **same** tool semantics and document the choice in README.  
7. Idempotency: store `event.id` processed set in Redis; skip duplicates.  
