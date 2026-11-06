// @arena/telegram entry point: Telegram bot (grammy, long polling) plus the notifier loop.
//
// Env:
//   TELEGRAM_BOT_TOKEN  required. Without it the process logs a message and exits 0.
//   WEB_URL             web app base URL. Default http://localhost:3000.
//   NETWORK             testnet (default) or mainnet. Picks the BaseScan host.
//   BASESCAN_URL        optional override for the BaseScan host.
//   ZG_EXPLORER_URL     optional 0G explorer base for 0G tx links.
//   TG_STATE_FILE       bot state JSON (links, cursors, digests). Default ./.telegram-state.json.
//   DATABASE_URL / PGLITE_DIR are read by @arena/db.

import { resolve } from "node:path";
import { Bot, type Context } from "grammy";
import { closeDb, createDb, migrate } from "@arena/db";
import { COMMANDS, createCommandHandlers, type CommandName } from "./commands.ts";
import { type ExplorerLinks } from "./format.ts";
import { createNotifier } from "./notifier.ts";
import { createSendQueue } from "./sendQueue.ts";
import { createStateStore } from "./state.ts";

const log = (msg: string) => console.log(`[telegram] ${msg}`);
const warn = (msg: string) => console.warn(`[telegram] ${msg}`);

function linksFromEnv(): ExplorerLinks {
  const mainnet = process.env.NETWORK === "mainnet";
  const basescan = process.env.BASESCAN_URL || (mainnet ? "https://basescan.org" : "https://sepolia.basescan.org");
  return {
    basescanUrl: basescan.replace(/\/+$/, ""),
    zgExplorerUrl: process.env.ZG_EXPLORER_URL ? process.env.ZG_EXPLORER_URL.replace(/\/+$/, "") : null,
  };
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    log("TELEGRAM_BOT_TOKEN is not set, so the Telegram bot is disabled. Add it to .env to run @arena/telegram.");
    process.exit(0);
  }

  const webUrl = (process.env.WEB_URL || "http://localhost:3000").replace(/\/+$/, "");
  const links = linksFromEnv();
  const statePath = process.env.TG_STATE_FILE || resolve(process.cwd(), ".telegram-state.json");

  const db = createDb();
  await migrate(db);
  const state = createStateStore(statePath);

  const bot = new Bot(token);
  const queue = createSendQueue({
    send: async (chatId, html) => {
      await bot.api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    },
    log: warn,
  });

  const handlers = createCommandHandlers({ db, state, links, webUrl });
  for (const { name } of COMMANDS) {
    const handler = handlers[name as CommandName];
    bot.command(name, async (c: Context) => {
      const args = typeof c.match === "string" ? c.match.trim() : "";
      await handler({
        chatId: String(c.chat?.id ?? ""),
        args,
        reply: async (html) => {
          await c.reply(html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        },
      });
    });
  }
  bot.catch((err) => {
    // Log the message only: the underlying error may carry request URLs, which contain the token.
    warn(`update failed: ${(err.error as Error | undefined)?.message ?? err.message}`);
  });

  try {
    await bot.api.setMyCommands(COMMANDS.map((c) => ({ command: c.name, description: c.description })));
  } catch (err) {
    warn(`could not register bot commands: ${(err as Error).message}`);
  }

  const notifier = createNotifier({
    db,
    state,
    links,
    send: (chatId, html) => queue.enqueue(chatId, html),
    log: warn,
  });
  notifier.start(30_000);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    await notifier.stop();
    const timeout = new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 10_000));
    await Promise.race([queue.drain(), timeout]);
    try {
      await bot.stop();
    } catch {
      // Not running yet, or already stopped.
    }
    state.save();
    await closeDb(db);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log(`polling started (web: ${webUrl}, basescan: ${links.basescanUrl})`);
  await bot.start({
    onStart: (me) => log(`connected as @${me.username}`),
  });
}

main().catch((err: unknown) => {
  warn(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
