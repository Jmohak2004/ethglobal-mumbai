// Notifier loop. Every interval it reads rows newer than a per-source cursor and routes them:
//   - owners (chat linked to the agent's owner wallet): full alerts (orders, fills, guardrail blocks,
//     budget tier changes, top-ups, CRE attestations)
//   - public followers: only platform risk-level changes and one daily digest per follow
//     (stats card, rank delta, delayed market view). Never trade-level data.
//
// Cursor semantics: each source starts at "now" on the first tick, so history is not replayed.
// Rows are read in ts order with a per-tick batch cap. A row written with a ts older than its
// cursor is missed, because the db has no ingest sequence.

import { getAgent, latestRisk, listByOwner, listEpisodesByAgent, type Db } from "@arena/db";
import {
  attestationAlert,
  budgetTierAlert,
  digestMessage,
  esc,
  fillAlert,
  guardrailAlert,
  orderPlacedAlert,
  riskChangeAlert,
  statsCard,
  topupAlert,
  utcDay,
  type ExplorerLinks,
} from "./format.ts";
import { delayedForecast, loadBoard } from "./queries.ts";
import { digestKey, type Cursors, type StateStore } from "./state.ts";

const BATCH = 500;

export interface NotifierDeps {
  db: Db;
  state: StateStore;
  /** Non-blocking: the caller enqueues onto the rate-limited send queue. */
  send: (chatId: string, html: string) => void;
  links: ExplorerLinks;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Notifier {
  /** One pass. Throws on failure (start() catches and logs). */
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

interface Event {
  ts: number;
  chats: string[];
  html: string;
}

interface OwnedAgent {
  name: string;
  chats: string[];
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { db, state, send, links } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  /** Agents owned by linked wallets, mapped to the chats that asked for owner alerts. */
  async function ownerIndex(): Promise<{ byAgent: Map<string, OwnedAgent>; chats: Set<string> }> {
    const byWallet = new Map<string, string[]>();
    for (const [chat, wallet] of Object.entries(state.state.links)) {
      byWallet.set(wallet, [...(byWallet.get(wallet) ?? []), chat]);
    }
    const byAgent = new Map<string, OwnedAgent>();
    const chats = new Set<string>();
    for (const [wallet, walletChats] of byWallet) {
      walletChats.forEach((c) => chats.add(c));
      for (const agent of await listByOwner(db, wallet)) {
        byAgent.set(agent.id, { name: agent.name, chats: walletChats });
      }
    }
    return { byAgent, chats };
  }

  /** Reads new rows for every source and returns owner-routed events plus the advanced cursors. */
  async function ownerEvents(owned: Map<string, OwnedAgent>, c: Cursors): Promise<{ events: Event[]; next: Cursors }> {
    const events: Event[] = [];
    const next: Cursors = { ...c };

    // Orders placed.
    const orderRows = await db.query.orders.findMany({
      where: (o, { gt }) => gt(o.createdAt, c.orders),
      orderBy: (o, { asc }) => asc(o.createdAt),
      limit: BATCH,
      columns: { id: true, agentId: true, side: true, asset: true, orderType: true, notionalUsd: true, createdAt: true },
    });
    for (const o of orderRows) {
      next.orders = Math.max(next.orders, o.createdAt);
      const owner = o.agentId ? owned.get(o.agentId) : undefined;
      if (owner) events.push({ ts: o.createdAt, chats: owner.chats, html: orderPlacedAlert(owner.name, o) });
    }

    // Fills, joined to their parent order for side, asset and agent.
    const fillRows = await db.query.fills.findMany({
      where: (f, { gt }) => gt(f.ts, c.fills),
      orderBy: (f, { asc }) => asc(f.ts),
      limit: BATCH,
    });
    if (fillRows.length > 0) {
      const orderIds = [...new Set(fillRows.map((f) => f.orderId))];
      const parents = await db.query.orders.findMany({
        where: (o, { inArray }) => inArray(o.id, orderIds),
        columns: { id: true, agentId: true, side: true, asset: true },
      });
      const parentById = new Map(parents.map((p) => [p.id, p]));
      for (const f of fillRows) {
        next.fills = Math.max(next.fills, f.ts);
        const parent = parentById.get(f.orderId);
        const owner = parent?.agentId ? owned.get(parent.agentId) : undefined;
        if (parent && owner) {
          const txId = f.txId;
          events.push({
            ts: f.ts,
            chats: owner.chats,
            html: fillAlert(
              owner.name,
              { side: parent.side, asset: parent.asset, qty: f.qty, price: f.price, notionalUsd: f.notionalUsd, txId },
              links,
            ),
          });
        }
      }
    }

    // Guardrail blocks.
    const blocks = await db.query.guardrailBlocks.findMany({
      where: (g, { gt }) => gt(g.ts, c.guardrails),
      orderBy: (g, { asc }) => asc(g.ts),
      limit: BATCH,
    });
    for (const b of blocks) {
      next.guardrails = Math.max(next.guardrails, b.ts);
      const owner = owned.get(b.agentId);
      if (owner) events.push({ ts: b.ts, chats: owner.chats, html: guardrailAlert(owner.name, b.reasons, b.ts) });
    }

    // Budget tier changes: each new episode is compared with the agent's previous episode.
    const episodeRows = await db.query.episodes.findMany({
      where: (e, { gt }) => gt(e.ts, c.episodes),
      orderBy: (e, { asc }) => asc(e.ts),
      limit: BATCH,
      columns: { id: true, agentId: true, ts: true, budgetTier: true },
    });
    const tiersByAgent = new Map<string, { ts: number; budgetTier: string }[]>();
    for (const e of episodeRows) {
      next.episodes = Math.max(next.episodes, e.ts);
      if (!owned.has(e.agentId)) continue;
      tiersByAgent.set(e.agentId, [...(tiersByAgent.get(e.agentId) ?? []), { ts: e.ts, budgetTier: e.budgetTier }]);
    }
    for (const [agentId, rows] of tiersByAgent) {
      const owner = owned.get(agentId)!;
      const [previous] = await listEpisodesByAgent(db, agentId, { limit: 1, beforeTs: rows[0]!.ts });
      let last: string | null = previous?.budgetTier ?? null;
      for (const r of rows) {
        if (last !== null && r.budgetTier !== last) {
          events.push({ ts: r.ts, chats: owner.chats, html: budgetTierAlert(owner.name, last, r.budgetTier, r.ts) });
        }
        last = r.budgetTier;
      }
    }

    // Top-ups (Base and 0G transactions).
    const topupRows = await db.query.topups.findMany({
      where: (t, { gt }) => gt(t.ts, c.topups),
      orderBy: (t, { asc }) => asc(t.ts),
      limit: BATCH,
    });
    for (const t of topupRows) {
      next.topups = Math.max(next.topups, t.ts);
      const owner = owned.get(t.agentId);
      if (owner) events.push({ ts: t.ts, chats: owner.chats, html: topupAlert(owner.name, t, links) });
    }

    // CRE performance attestations. A report is matched to an owned agent when its payload names the
    // agent id, or when the agent's verified stats point at this report.
    const attestationRows = await db.query.attestations.findMany({
      where: (a, { and, eq, gt }) => and(eq(a.kind, "perf"), gt(a.asOf, c.attestations)),
      orderBy: (a, { asc }) => asc(a.asOf),
      limit: BATCH,
    });
    for (const a of attestationRows) next.attestations = Math.max(next.attestations, a.asOf);
    if (attestationRows.length > 0 && owned.size > 0) {
      const board = await loadBoard(db);
      for (const a of attestationRows) {
        for (const [agentId, owner] of owned) {
          const mentioned = JSON.stringify(a.payload).includes(agentId);
          const row = board.agents.find((r) => r.entityId === agentId);
          const verified = row?.verified
            ? row.verified.asOf === a.asOf ||
              (a.txHash !== null && row.verified.reportTx.toLowerCase() === a.txHash.toLowerCase())
            : false;
          if (mentioned || verified) {
            events.push({ ts: a.asOf, chats: owner.chats, html: attestationAlert(owner.name, a, links) });
          }
        }
      }
    }

    return { events, next };
  }

  /** Broadcasts a changed platform risk level to public followers and owner chats. */
  async function riskTick(ownerChats: Set<string>): Promise<void> {
    const risk = await latestRisk(db);
    if (!risk) return;
    const prev = state.state.riskLevel;
    if (prev === null) {
      // First observation is a baseline, not a change.
      state.state.riskLevel = risk.level;
      return;
    }
    if (prev === risk.level) return;
    state.state.riskLevel = risk.level;

    const publicRows = await db.query.tgSubscriptions.findMany({
      where: (t, { eq }) => eq(t.level, "public"),
      columns: { chatId: true },
    });
    const recipients = new Set([...publicRows.map((r) => r.chatId), ...ownerChats]);
    const html = riskChangeAlert(prev, risk, links);
    for (const chat of recipients) send(chat, html);
  }

  /** Once per UTC day, one digest per public follow, with rank deltas against the previous batch. */
  async function digestTick(t: number): Promise<void> {
    const today = utcDay(t);
    if (state.state.lastDigestDay === today) return;

    const board = await loadBoard(db);
    const subs = await db.query.tgSubscriptions.findMany({
      where: (s, { eq }) => eq(s.level, "public"),
      columns: { chatId: true, agentId: true },
    });
    for (const sub of subs) {
      const key = digestKey(sub.chatId, sub.agentId);
      if (state.state.digestDays[key] === today) continue;
      state.state.digestDays[key] = today;

      const agent = await getAgent(db, sub.agentId);
      if (!agent) continue;
      const row = board.agents.find((r) => r.entityId === sub.agentId);
      const rank = board.rankById.get(sub.agentId);
      const previousRank = state.state.rankSnapshot[sub.agentId];
      const rankDelta = rank !== undefined && previousRank !== undefined ? previousRank - rank : null;
      const card = row
        ? statsCard(row, { links, rank, rankDelta })
        : `🏆 <b>${esc(agent.name)}</b>\nNo stats yet.`;
      const commentary = agent.config.publicCommentary === "delayed" ? await delayedForecast(db, agent.id, t) : null;
      send(sub.chatId, digestMessage({ date: today, card, commentary }));
    }

    state.state.rankSnapshot = Object.fromEntries(board.rankById);
    state.state.lastDigestDay = today;
  }

  async function tick(): Promise<void> {
    const t = now();
    const st = state.state;
    try {
      if (st.cursors === null) {
        // First run: baseline everything at "now" so no history is replayed.
        const board = await loadBoard(db);
        st.cursors = { orders: t, fills: t, guardrails: t, episodes: t, topups: t, attestations: t };
        st.lastDigestDay = utcDay(t);
        st.rankSnapshot = Object.fromEntries(board.rankById);
        st.riskLevel = (await latestRisk(db))?.level ?? null;
        return;
      }

      const owned = await ownerIndex();
      const { events, next } = await ownerEvents(owned.byAgent, st.cursors);
      for (const e of events.sort((a, b) => a.ts - b.ts)) {
        for (const chat of new Set(e.chats)) send(chat, e.html);
      }
      st.cursors = next;

      await riskTick(owned.chats);
      await digestTick(t);
    } finally {
      state.save();
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let current: Promise<void> | null = null;

  return {
    tick,
    start(intervalMs = 30_000) {
      stopped = false;
      const loop = () => {
        current = tick()
          .catch((err: unknown) => log(`[telegram] notifier tick failed: ${(err as Error).message}`))
          .finally(() => {
            current = null;
            if (!stopped) timer = setTimeout(loop, intervalMs);
          });
      };
      loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (current) await current;
    },
  };
}
