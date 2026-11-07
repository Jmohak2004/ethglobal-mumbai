# Hosting

ARENA is three long-running processes that share one Postgres database (Neon):

| Service | Root | Build | Start | Instances |
|---|---|---|---|---|
| web | repo root | `bun install && cd apps/web && bun run build` | `cd apps/web && bun run start` | 1 |
| worker | repo root | `bun install` | `cd apps/worker && bun src/index.ts run` | exactly 1 |
| bot | repo root | `bun install` | `cd apps/telegram && bun src/index.ts` | exactly 1 |

Recommended host: **Railway** (one project, three services from the same GitHub repo, shared variables). Render or Fly work the same way.

## Why not serverless for the web app

The web server keeps sign-in nonces and Flash/paper quotes in process memory. On Vercel each request can land on a different instance, so sign-in and quote → order would fail at random. Run the web app as a single long-lived server, or move those stores to Postgres before using serverless.

## Why exactly one worker and one bot

- The worker serializes work per agent with an in-memory lock (`apps/worker/src/agent-lock.ts`). Two workers would double-trade.
- The bot uses Telegram long polling (one poller per token) and saves its state to `.telegram-state.json`. Mount a volume at `apps/telegram` or the follows reset on each deploy.

## Environment

- Copy every value from the root `.env` into the host's shared variables. The start scripts read `../../.env` when it exists and ignore it when it doesn't.
- `DATABASE_URL`: the same Neon pooled URL (`-pooler` host). Keep `DB_POOL_MAX` small (5).
- `NEXT_PUBLIC_*` values are compiled into the web build: set them before building, and redeploy after changing them.
- The web server listens on `PORT` (default 3000).
- Rotate `DEV_AGENT_MNEMONIC`, `OPERATOR_PRIVATE_KEY` and `PLATFORM_ADMIN_PRIVATE_KEY` before going public; new agent wallets then derive from the new mnemonic.

## Chainlink CRE

The workflows run with `cre workflow simulate … --broadcast` (see `cre/README.md`). Run them from a laptop during the demo, or on a schedule (for example a GitHub Actions cron with the CRE CLI and the `cre/.env` secrets). Deploying to the hosted CRE network needs Chainlink early access.

## Optional processes

- `cd apps/worker && bun src/index.ts relayer`: the 0G top-up relayer, once its wallet holds 0G.
