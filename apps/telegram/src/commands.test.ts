import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, listTelegramSubscriptions, type Db } from "@arena/db";
import { createCommandHandlers, type CommandName } from "./commands.ts";
import { createStateStore, type StateStore } from "./state.ts";
import { HUMAN, LINKS, OWNER, WEB_URL, forbiddenHits, hash, seedDb } from "./test-fixtures.ts";

const CHAT = "1001";

let db: Db;
let state: StateStore;
let handlers: Record<CommandName, (ctx: { chatId: string; args: string; reply(html: string): Promise<void> }) => Promise<void>>;

/** Runs one command and returns what the bot would have sent. */
async function run(name: CommandName, args = "", chatId = CHAT): Promise<string[]> {
  const replies: string[] = [];
  await handlers[name]({
    chatId,
    args,
    reply: async (html) => {
      replies.push(html);
    },
  });
  return replies;
}

beforeEach(async () => {
  db = await seedDb();
  state = createStateStore(null);
  handlers = createCommandHandlers({ db, state, links: LINKS, webUrl: WEB_URL, now: () => Date.UTC(2026, 10, 6, 12) });
});

afterEach(async () => {
  await closeDb(db);
});

describe("/start and /help", () => {
  test("/start introduces the bot, lists commands and notes demo-grade linking", async () => {
    const [text] = await run("start");
    expect(text).toContain("Arena agents");
    for (const cmd of ["/top", "/agent", "/follow", "/unfollow", "/following", "/risk", "/fork", "/link", "/help"]) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("Demo-grade");
    expect(text).toContain("not verified");
  });

  test("/help lists commands", async () => {
    const [text] = await run("help");
    expect(text).toContain("/top [n]");
  });
});

describe("/top and /humans", () => {
  test("/top renders a monospace leaderboard, best PnL first, without trade data", async () => {
    const [text] = await run("top", "5");
    expect(text).toContain("<pre>");
    const mom = text!.indexOf("Momentum Alpha");
    const brk = text!.indexOf("Breakout Charlie");
    expect(mom).toBeGreaterThan(-1);
    expect(brk).toBeGreaterThan(mom);
    expect(text).not.toContain("Ada K.");
    expect(forbiddenHits(text!)).toEqual([]);
  });

  test("/top ignores non-numeric args and uses the default size", async () => {
    const [text] = await run("top", "abc");
    expect(text).toContain("Momentum Alpha");
  });

  test("/humans lists the humans board", async () => {
    const [text] = await run("humans");
    expect(text).toContain("Ada K.");
    expect(text).not.toContain("Momentum");
  });
});

describe("/agent", () => {
  test("shows the stats card with verified badge and rank", async () => {
    const [text] = await run("agent", "momentum alpha");
    expect(text).toContain("<b>[demo] Momentum Alpha</b>");
    expect(text).toContain("Verified by Chainlink CRE");
    expect(text).toContain("Rank #1");
    expect(text).toContain("⚡");
    expect(forbiddenHits(text!)).toEqual([]);
  });

  test("matches by id and by word prefix", async () => {
    expect((await run("agent", "agent-brk"))[0]).toContain("Breakout Charlie");
    expect((await run("agent", "charlie"))[0]).toContain("Breakout Charlie");
  });

  test("reports ambiguous matches with the candidate names", async () => {
    const [text] = await run("agent", "momentum");
    expect(text).toContain("Several agents match");
    expect(text).toContain("Momentum Beta");
    expect(text).toContain("Momentum Alpha");
  });

  test("reports no match, and usage when the argument is missing", async () => {
    expect((await run("agent", "nope"))[0]).toContain("No agent matches");
    expect((await run("agent", ""))[0]).toContain("Usage");
  });

  test("an agent with no stats yet shows a placeholder, not an error", async () => {
    const [text] = await run("agent", "Momentum Beta");
    expect(text).toContain("No stats yet");
  });

  test("escapes HTML in user input", async () => {
    const [text] = await run("agent", "<b>x</b>");
    expect(text).not.toContain("<b>x</b>");
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("/follow, /following, /unfollow", () => {
  test("follow stores a public subscription and replies with the card", async () => {
    const [text] = await run("follow", "breakout");
    expect(text).toContain("Following <b>[demo] Breakout Charlie</b>");
    const subs = await listTelegramSubscriptions(db, CHAT);
    expect(subs).toEqual([expect.objectContaining({ agentId: "agent-brk", level: "public" })]);
    expect(state.state.digestDays[`${CHAT}|agent-brk`]).toBe("2026-11-06");
  });

  test("following twice is idempotent and says so", async () => {
    await run("follow", "breakout");
    const [text] = await run("follow", "breakout");
    expect(text).toContain("Already following");
    expect(await listTelegramSubscriptions(db, CHAT)).toHaveLength(1);
  });

  test("/following lists followed agents, and says when there are none", async () => {
    expect((await run("following"))[0]).toContain("not following any agents");
    await run("follow", "momentum alpha");
    expect((await run("following"))[0]).toContain("• [demo] Momentum Alpha");
  });

  test("unfollow removes the subscription and digest bookkeeping", async () => {
    await run("follow", "breakout");
    const [text] = await run("unfollow", "breakout");
    expect(text).toContain("Unfollowed");
    expect(await listTelegramSubscriptions(db, CHAT)).toHaveLength(0);
    expect(state.state.digestDays[`${CHAT}|agent-brk`]).toBeUndefined();
  });

  test("unfollow only matches agents the chat follows", async () => {
    const [text] = await run("unfollow", "breakout");
    expect(text).toContain("not following");
  });

  test("follow with an unknown agent gives a helpful reply and stores nothing", async () => {
    const [text] = await run("follow", "zzz");
    expect(text).toContain("No agent matches");
    expect(await listTelegramSubscriptions(db, CHAT)).toHaveLength(0);
  });
});

describe("/risk and /fork", () => {
  test("/risk shows the current platform level", async () => {
    const [text] = await run("risk");
    expect(text).toContain("🟢");
    expect(text).toContain("NORMAL");
  });

  test("/fork links to the fork page for forkable agents", async () => {
    const [text] = await run("fork", "momentum alpha");
    expect(text).toContain(`href="${WEB_URL}/agents/agent-mom?fork=1"`);
    expect(text).toContain("Fork fee: $2.00");
    expect(forbiddenHits(text!)).toEqual([]);
  });

  test("/fork refuses agents that are not forkable", async () => {
    const [text] = await run("fork", "locked");
    expect(text).toContain("not available for forking");
    expect(text).not.toContain("?fork=1");
  });
});

describe("/link", () => {
  test("rejects anything that is not a 0x address", async () => {
    const [text] = await run("link", "0xnothex");
    expect(text).toContain("Usage");
    expect(state.state.links[CHAT]).toBeUndefined();
  });

  test("stores the lowercased wallet for the chat and reports owned agents", async () => {
    const mixed = `0x${"Dd".repeat(20)}`;
    const [text] = await run("link", mixed);
    expect(text).toContain("Linked to");
    expect(state.state.links[CHAT]).toBe(mixed.toLowerCase());
    expect(text).toContain("owns 0 agents");
  });

  test("counts agents owned by the linked wallet", async () => {
    const [text] = await run("link", OWNER);
    expect(text).toContain("owns 1 agent");
    expect(state.state.links[CHAT]).toBe(OWNER);
  });

  test("the link reply states that linking is demo-grade", async () => {
    const [text] = await run("link", HUMAN);
    expect(text).toContain("Demo-grade");
  });
});

describe("public command output", () => {
  test("no public command leaks order, fill or sizing fields", async () => {
    await run("follow", "momentum alpha");
    const outputs = [
      ...(await run("top")),
      ...(await run("humans")),
      ...(await run("agent", "momentum alpha")),
      ...(await run("agent", "breakout")),
      ...(await run("risk")),
      ...(await run("following")),
      ...(await run("fork", "momentum alpha")),
    ];
    expect(outputs.length).toBeGreaterThan(0);
    for (const out of outputs) expect(forbiddenHits(out)).toEqual([]);
  });

  test("the verified report link uses the stored report tx", async () => {
    const [text] = await run("agent", "momentum alpha");
    expect(text).toContain(hash(9));
  });
});
