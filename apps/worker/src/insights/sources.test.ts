// Insight collectors: RSS/Atom parsing on fixtures, the curated-feed rule, the per-URL cache and deadline, the
// commentary delay, and the rule that sizes and prices never leave a source agent.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertEpisode, type Db } from "@arena/db";
import type { DecisionOutput, Episode } from "@arena/shared";
import { silentLogger } from "../logger.ts";
import { fixedClock, memoryDb, NOW, seedAgent } from "../test-fixtures.ts";
import {
  assetsMentioned,
  cleanText,
  collectAgentCommentary,
  commentaryText,
  parseFeed,
  parseFeedList,
  redactOrderValues,
  RssCollector,
  type FetchText,
} from "./sources.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Crypto wire</title>
    <item>
      <title><![CDATA[Ether <b>rallies</b> past resistance]]></title>
      <link>https://news.example/ether-rally</link>
      <guid>guid-1</guid>
      <pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate>
      <description>&lt;p&gt;ETH &amp; WETH bid &#8211; &#x27;strong&#x27; demand&lt;/p&gt;</description>
    </item>
    <item>
      <title>Bitcoin ETF flows turn positive</title>
      <link>https://news.example/btc-flows</link>
      <guid>guid-2</guid>
      <pubDate>not a date</pubDate>
      <content:encoded><![CDATA[<div>Spot <em>BTC</em> funds saw inflows.</div>]]></content:encoded>
    </item>
    <item>
      <title></title>
      <description>   </description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Alpha desk</title>
  <link rel="self" href="https://alpha.example/feed.xml"/>
  <entry>
    <title>cbBTC basis widens</title>
    <link rel="alternate" href="https://alpha.example/posts/cbbtc"/>
    <id>tag:alpha.example,2026:cbbtc</id>
    <updated>2026-11-06T09:30:00Z</updated>
    <summary type="html">&lt;b&gt;Funding&lt;/b&gt; is hot on cbBTC.</summary>
  </entry>
</feed>`;

describe("cleanText", () => {
  test("unwraps CDATA, strips tags, decodes entities and collapses whitespace", () => {
    expect(cleanText("  <![CDATA[<i>Hi</i>  &amp; bye]]>\n  ")).toBe("Hi & bye");
    expect(cleanText("&lt;p&gt;Hi&lt;/p&gt; &#65;&#x42; &unknown;")).toBe("Hi AB &unknown;");
  });
});

describe("parseFeed", () => {
  test("reads RSS items: CDATA titles, HTML-stripped descriptions, guid, link and RFC 822 dates", () => {
    const entries = parseFeed(RSS_FIXTURE, NOW);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: "guid-1",
      title: "Ether rallies past resistance",
      text: "ETH & WETH bid – 'strong' demand",
      url: "https://news.example/ether-rally",
      ts: Date.parse("Fri, 06 Nov 2026 10:00:00 GMT"),
    });
  });

  test("uses content:encoded as the body and the fallback time for an unparseable date", () => {
    const second = parseFeed(RSS_FIXTURE, NOW)[1];
    expect(second?.text).toBe("Spot BTC funds saw inflows.");
    expect(second?.ts).toBe(NOW);
  });

  test("reads Atom entries: rel=alternate link href, ISO updated date, id as key, summary text", () => {
    const entries = parseFeed(ATOM_FIXTURE, NOW);
    expect(entries).toEqual([
      {
        key: "tag:alpha.example,2026:cbbtc",
        title: "cbBTC basis widens",
        text: "Funding is hot on cbBTC.",
        url: "https://alpha.example/posts/cbbtc",
        ts: Date.parse("2026-11-06T09:30:00Z"),
      },
    ]);
  });

  test("ignores self links and non-http links, and returns nothing for a non-feed document", () => {
    const xml = `<feed><entry><title>x</title><link rel="self" href="https://a.example/x"/><link href="javascript:alert(1)"/></entry></feed>`;
    expect(parseFeed(xml, NOW)[0]?.url).toBeUndefined();
    expect(parseFeed("<html><body>not a feed</body></html>", NOW)).toEqual([]);
  });
});

describe("parseFeedList", () => {
  test("uses the defaults when unset or blank, and an env list when given", () => {
    expect(parseFeedList(undefined)).toContain("https://cointelegraph.com/rss");
    expect(parseFeedList("   ")).toHaveLength(3);
    expect(parseFeedList(" https://a.example/rss , https://a.example/rss,ftp://no.example, not-a-url ")).toEqual(["https://a.example/rss"]);
  });
});

describe("RssCollector", () => {
  /** A fetch that serves `body` and counts calls. */
  function fakeFetch(body: string) {
    const calls: string[] = [];
    const fetchText: FetchText = async (url) => {
      calls.push(url);
      return new Response(body, { status: 200 });
    };
    return { calls, fetchText };
  }

  test("fetches a curated feed once per 5 minutes and refuses urls outside the list", async () => {
    const clock = fixedClock();
    const { calls, fetchText } = fakeFetch(RSS_FIXTURE);
    const rss = new RssCollector({ feeds: ["https://news.example/feed"], clock, fetch: fetchText, logger: silentLogger });

    const first = await rss.collect(["https://news.example/feed", "https://evil.example/feed"]);
    expect([...first.keys()]).toEqual(["https://news.example/feed"]);
    expect(calls).toEqual(["https://news.example/feed"]);

    clock.advance(4 * 60_000);
    await rss.collect(["https://news.example/feed"]);
    expect(calls).toHaveLength(1);

    clock.advance(2 * 60_000);
    await rss.collect(["https://news.example/feed"]);
    expect(calls).toHaveLength(2);
  });

  test("a failed feed maps to no entries and is not cached", async () => {
    const clock = fixedClock();
    let fail = true;
    const fetchText: FetchText = async () => (fail ? new Response("down", { status: 503 }) : new Response(RSS_FIXTURE));
    const rss = new RssCollector({ feeds: ["https://news.example/feed"], clock, fetch: fetchText, logger: silentLogger });

    expect((await rss.collect(["https://news.example/feed"])).get("https://news.example/feed")).toEqual([]);
    fail = false;
    expect((await rss.collect(["https://news.example/feed"])).get("https://news.example/feed")).toHaveLength(2);
  });

  test("gives up at the deadline even when the fetch never answers", async () => {
    const clock = fixedClock();
    const hang: FetchText = () => new Promise<Response>(() => undefined);
    const rss = new RssCollector({ feeds: ["https://news.example/feed"], clock, fetch: hang, timeoutMs: 20, logger: silentLogger });
    expect((await rss.collect(["https://news.example/feed"])).get("https://news.example/feed")).toEqual([]);
  });
});

describe("assetsMentioned", () => {
  test("matches the PRD aliases as whole words", () => {
    const assets = ["WETH", "cbBTC"];
    expect(assetsMentioned("Ether breaks out", assets)).toEqual(["WETH"]);
    expect(assetsMentioned("Bitcoin and ETH both up", assets)).toEqual(["WETH", "cbBTC"]);
    expect(assetsMentioned("Wethering the storm", assets)).toEqual([]);
    expect(assetsMentioned("Ethereal mood", assets)).toEqual([]);
  });
});

describe("redactOrderValues", () => {
  test("removes currency amounts and the exact order values, in every written form", () => {
    const proposal = { action: "buy" as const, sizePct: 0.4, limitPrice: 3412.5, rationale: "" };
    const out = redactOrderValues("Size 40% at 3,412.5 after $1,234.50 of inflow; ETH 3412.5 holds.", proposal);
    expect(out).not.toMatch(/40%|3,412|3412|1,234|\$/);
    expect(out).toContain("holds");
  });
});

describe("collectAgentCommentary", () => {
  const openDb = async (): Promise<Db> => {
    const db = await memoryDb();
    dbs.push(db);
    return db;
  };

  function decision(rationale: string): DecisionOutput {
    return {
      forecast: { asset: "WETH", horizonMin: 15, direction: "up", expectedMovePct: 1.2, confidence: 0.7 },
      proposal: {
        action: "buy",
        asset: "WETH",
        orderType: "limit",
        sizePct: 0.4,
        limitPrice: 3412.5,
        takeProfitPct: 3,
        stopLossPct: 2,
        rationale,
      },
    };
  }

  function episode(agentId: string, id: string, ts: number, d: DecisionOutput | null): Episode {
    return {
      id,
      agentId,
      ts,
      riskLevel: "NORMAL",
      budgetTier: "healthy",
      market: [],
      decision: d,
      inference: null,
      verdict: { kind: "noop", reasons: [] },
      flashOrderIds: [],
      zgStorageRoot: null,
      error: null,
    };
  }

  test("reads only episodes at least 1 h old, and only from delayed sources", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const source = await seedAgent(db, {
      name: "[test] delayed source",
      assets: ["WETH"],
      config: { publicCommentary: "delayed" },
    });
    const silent = await seedAgent(db, { name: "[test] silent source", assets: ["WETH"], config: { publicCommentary: "off" } });

    const rationale = "Momentum is up; spending $1,234.50 at 3412.5 with 40% of allocation. ETH holds the range.";
    await insertEpisode(db, episode(source.id, "fresh", NOW - 30 * 60_000, decision("fresh call on ETH")));
    await insertEpisode(db, episode(source.id, "old-1", NOW - 2 * 3_600_000, decision(rationale)));
    await insertEpisode(db, episode(source.id, "old-2", NOW - 3 * 3_600_000, decision("ETH consolidating")));
    await insertEpisode(db, episode(silent.id, "silent-1", NOW - 5 * 3_600_000, decision("ETH rally ahead")));

    const items = await collectAgentCommentary({ db, clock, logger: silentLogger }, [source.id, silent.id]);

    expect(items.map((i) => i.id)).toEqual([`agent:old-1`, `agent:old-2`]);
    expect(items.every((i) => i.sourceKind === "agent" && i.sourceRef === source.id)).toBe(true);
    const text = items[0]?.text ?? "";
    expect(text).toContain("Forecast for WETH: up.");
    expect(text).toContain("ETH holds the range.");
    // No sizes, prices, order types or currency amounts leave the source.
    expect(text).not.toMatch(/\$|1,234|3412|40%|\b40\b|market|limit|buy/i);
    expect(text).not.toMatch(/sizePct|limitPrice|takeProfit|stopLoss/);
    expect(items.some((i) => i.text.includes("fresh call"))).toBe(false);
  });

  test("never digests the consuming agent's own episodes", async () => {
    const db = await openDb();
    const self = await seedAgent(db, { name: "[test] self", assets: ["WETH"], config: { publicCommentary: "delayed" } });
    await insertEpisode(db, episode(self.id, "mine", NOW - 2 * 3_600_000, decision("my own view")));
    expect(await collectAgentCommentary({ db, clock: fixedClock(), logger: silentLogger }, [self.id], self.id)).toEqual([]);
  });

  test("commentaryText has nothing to say for a hold with no forecast and no rationale", () => {
    expect(commentaryText({ decision: null })).toBeNull();
    expect(commentaryText({ decision: { forecast: null, proposal: { action: "hold", rationale: "" } } })).toBeNull();
  });
});
