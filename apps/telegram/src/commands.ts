// Command handlers. Pure logic over a context object ({ chatId, args, reply }), so they are testable
// with a fake context. index.ts adapts grammy contexts to this shape.

import { getAgent, latestRisk, listByOwner, listTelegramSubscriptions, leaderboard, subscribeTelegram, unsubscribeTelegram, type Db } from "@arena/db";
import {
  esc,
  leaderboardTable,
  riskStatus,
  statsCard,
  utcDay,
  type ExplorerLinks,
} from "./format.ts";
import { followedAgents, loadBoard, loadPublicAgents, loadHumans, matchAgents } from "./queries.ts";
import { digestKey, type StateStore } from "./state.ts";

export interface CommandContext {
  chatId: string;
  /** Text after the command, trimmed. */
  args: string;
  reply(html: string): Promise<void>;
}

export interface CommandDeps {
  db: Db;
  state: StateStore;
  links: ExplorerLinks;
  /** Public web app base URL, no trailing slash. */
  webUrl: string;
  now?: () => number;
}

export const COMMANDS = [
  { name: "start", usage: "/start", description: "What this bot is and how to use it" },
  { name: "top", usage: "/top [n]", description: "Agent leaderboard" },
  { name: "humans", usage: "/humans", description: "Human traders board" },
  { name: "agent", usage: "/agent <name>", description: "Agent stats card" },
  { name: "follow", usage: "/follow <agent>", description: "Daily digest and rank changes" },
  { name: "unfollow", usage: "/unfollow <agent>", description: "Stop following an agent" },
  { name: "following", usage: "/following", description: "Agents you follow" },
  { name: "risk", usage: "/risk", description: "Current platform risk level" },
  { name: "fork", usage: "/fork <agent>", description: "Fork an agent's strategy" },
  { name: "link", usage: "/link <0xaddress>", description: "Link this chat to your wallet (owner alerts)" },
  { name: "help", usage: "/help", description: "Command list" },
] as const;

export type CommandName = (typeof COMMANDS)[number]["name"];

const PUBLIC_INTRO =
  "👋 <b>Arena agents</b>: AI trading agents on Base. Every stat is verified by Chainlink CRE.\n" +
  "Public views show stats only. Individual trades are never shown publicly.";

const LINK_NOTE =
  "<i>Demo-grade: linking is not verified, so anyone can link any wallet. " +
  "Owner alerts for agents owned by that wallet start after you link.</i>";

export function commandListHtml(): string {
  const lines = COMMANDS.map((c) => `${esc(c.usage)} · ${esc(c.description)}`);
  return lines.join("\n");
}

const usage = (cmd: string, hint: string) => `Usage: <code>${esc(cmd)}</code> ${esc(hint)}`;

export function createCommandHandlers(deps: CommandDeps): Record<CommandName, (ctx: CommandContext) => Promise<void>> {
  const { db, state, links, webUrl } = deps;
  const now = deps.now ?? Date.now;

  const notFound = (query: string) => `No agent matches <code>${esc(query)}</code>. Try /top to see names.`;
  const ambiguous = (query: string, names: string[]) =>
    `Several agents match <code>${esc(query)}</code>: ${names.map(esc).join(", ")}. Be more specific.`;

  /** Resolves a public agent by name or id, or returns the reply to send instead. */
  async function resolvePublic(query: string): Promise<{ id: string; name: string } | { error: string }> {
    const m = matchAgents(await loadPublicAgents(db), query);
    if (m.kind === "one") return m.item;
    if (m.kind === "many") return { error: ambiguous(query, m.items.map((a) => a.name)) };
    return { error: notFound(query) };
  }

  return {
    async start(ctx) {
      await ctx.reply(`${PUBLIC_INTRO}\n\n${commandListHtml()}\n\n${LINK_NOTE}`);
    },

    async help(ctx) {
      await ctx.reply(`${commandListHtml()}\n\n${LINK_NOTE}`);
    },

    async top(ctx) {
      const parsed = Number.parseInt(ctx.args, 10);
      const n = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 25) : 10;
      const rows = await leaderboard(db, { kind: "agent", limit: n });
      if (rows.length === 0) {
        await ctx.reply("No agents on the board yet.");
        return;
      }
      await ctx.reply(
        `🏆 <b>Agent leaderboard</b> · all time\n${leaderboardTable(rows)}\n✓ verified by Chainlink CRE · stats only · /agent &lt;name&gt; for a card`,
      );
    },

    async humans(ctx) {
      const rows = await loadHumans(db, 10);
      if (rows.length === 0) {
        await ctx.reply("No humans on the board yet.");
        return;
      }
      await ctx.reply(`👥 <b>Humans board</b> · all time\n${leaderboardTable(rows)}\nStats only.`);
    },

    async agent(ctx) {
      if (!ctx.args) return ctx.reply(usage("/agent", "<name or id>"));
      const m = matchAgents(await loadPublicAgents(db), ctx.args);
      if (m.kind === "none") return ctx.reply(notFound(ctx.args));
      if (m.kind === "many") return ctx.reply(ambiguous(ctx.args, m.items.map((a) => a.name)));

      const agent = m.item;
      const board = await loadBoard(db);
      const row = board.agents.find((r) => r.entityId === agent.id);
      if (!row) {
        await ctx.reply(
          `🏆 <b>${esc(agent.name)}</b> · ${esc(agent.template.replace(/_/g, " "))} · <i>${agent.mode === "paper" ? "PAPER" : "LIVE"}</i>\nNo stats yet.`,
        );
        return;
      }
      const rank = board.rankById.get(agent.id);
      await ctx.reply(statsCard(row, { links, rank }));
    },

    async follow(ctx) {
      if (!ctx.args) return ctx.reply(usage("/follow", "<agent>"));
      const target = await resolvePublic(ctx.args);
      if ("error" in target) return ctx.reply(target.error);

      const existing = await listTelegramSubscriptions(db, ctx.chatId);
      if (existing.some((s) => s.agentId === target.id)) {
        return ctx.reply(`Already following <b>${esc(target.name)}</b>. /unfollow to stop.`);
      }
      await subscribeTelegram(db, { chatId: ctx.chatId, agentId: target.id, level: "public" });
      // Today's digest is covered by the card below, so the next digest is tomorrow's.
      state.state.digestDays[digestKey(ctx.chatId, target.id)] = utcDay(now());
      state.save();

      const board = await loadBoard(db);
      const row = board.agents.find((r) => r.entityId === target.id);
      const intro = `✅ Following <b>${esc(target.name)}</b>. You will get a daily digest, rank changes and risk-level alerts.`;
      await ctx.reply(row ? `${intro}\n\n${statsCard(row, { links, rank: board.rankById.get(target.id) })}` : intro);
    },

    async unfollow(ctx) {
      if (!ctx.args) return ctx.reply(usage("/unfollow", "<agent>"));
      const followed = await followedAgents(db, ctx.chatId);
      const m = matchAgents(followed, ctx.args);
      if (m.kind === "none") {
        return ctx.reply(`You are not following <code>${esc(ctx.args)}</code>. /following lists yours.`);
      }
      if (m.kind === "many") return ctx.reply(ambiguous(ctx.args, m.items.map((a) => a.name)));
      await unsubscribeTelegram(db, ctx.chatId, m.item.id);
      delete state.state.digestDays[digestKey(ctx.chatId, m.item.id)];
      state.save();
      await ctx.reply(`Unfollowed <b>${esc(m.item.name)}</b>.`);
    },

    async following(ctx) {
      const followed = await followedAgents(db, ctx.chatId);
      if (followed.length === 0) {
        await ctx.reply("You are not following any agents yet. Try /top, then /follow &lt;agent&gt;.");
        return;
      }
      await ctx.reply(`📌 <b>Following</b>\n${followed.map((f) => `• ${esc(f.name)}`).join("\n")}`);
    },

    async risk(ctx) {
      const risk = await latestRisk(db);
      if (!risk) {
        await ctx.reply("No platform risk state has been recorded yet.");
        return;
      }
      await ctx.reply(riskStatus(risk, links));
    },

    async fork(ctx) {
      if (!ctx.args) return ctx.reply(usage("/fork", "<agent>"));
      const target = await resolvePublic(ctx.args);
      if ("error" in target) return ctx.reply(target.error);
      const agent = await getAgent(db, target.id);
      if (!agent || !agent.config.fork.forkable) {
        await ctx.reply(`<b>${esc(target.name)}</b> is not available for forking.`);
        return;
      }
      const href = `${webUrl}/agents/${encodeURIComponent(agent.id)}?fork=1`;
      await ctx.reply(
        `🍴 Fork <b>${esc(target.name)}</b>. Fork fee: $${agent.config.fork.priceUsd.toFixed(2)}.\n<a href="${esc(href)}">Open the fork page</a>`,
      );
    },

    async link(ctx) {
      const address = ctx.args.split(/\s+/)[0] ?? "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return ctx.reply(usage("/link", "<0xaddress> (a 40-hex-digit wallet)"));
      }
      const wallet = address.toLowerCase();
      state.state.links[ctx.chatId] = wallet;
      state.save();
      const owned = await listByOwner(db, wallet);
      const count = owned.length === 1 ? "1 agent" : `${owned.length} agents`;
      await ctx.reply(
        `🔗 Linked to <code>${esc(`${wallet.slice(0, 6)}...${wallet.slice(-4)}`)}</code>. ` +
          `It owns ${count}. Owner alerts (orders, fills, guardrail blocks, budget tier, top-ups, CRE attestations) are now on for those agents.\n${LINK_NOTE}`,
      );
    },
  };
}
