// Insight producer: budget gating, per-agent 0G key selection, the stored digest and its inference record, the
// 30-minute refresh before a tick, and one RSS fetch per cycle shared by every agent.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertZgKey, latestInsightDigest, type Db } from "@arena/db";
import { ZeroGRouter } from "@arena/zerog";
import { createAgentRouterFor } from "../inference-router.ts";
import { silentLogger } from "../logger.ts";
import { encryptSecret } from "../secrets.ts";
import { completion, fakeBudget, fixedClock, memoryDb, NOW, seedAgent } from "../test-fixtures.ts";
import { createInsightProducer } from "./producer.ts";
import { RssCollector, type FetchText } from "./sources.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const FEED = "https://news.example/feed";
const BASE = "https://router.test/v1";
const KEY = Buffer.alloc(32, 7);

const FEED_XML = `<rss><channel>
  <item><title>Ether breaks out</title><link>https://news.example/eth</link><guid>g1</guid><description>ETH bid strong</description></item>
  <item><title>Weather report</title><link>https://news.example/rain</link><guid>g2</guid><description>Rain all week</description></item>
</channel></rss>`;

const DIGEST_REPLY = JSON.stringify({
  perAsset: { WETH: { stance: "bullish", confidence: 0.7, sourceIds: ["item-1"] } },
  summary: "ETH bid on breakout news.",
});

/** Records every router request and answers with `reply`. */
function recordingFetch(reply: string) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return completion(reply, `req-${requests.length}`);
  };
  return { fetchFn, requests };
}

/** Counts feed fetches per url. Serves FEED_XML for every url. */
function countingRss() {
  const fetched: string[] = [];
  const fetchText: FetchText = async (url) => {
    fetched.push(url);
    return new Response(FEED_XML, { status: 200 });
  };
  return { fetched, fetchText };
}

async function openDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

const rssSources = [{ kind: "rss" as const, url: FEED }];

describe("insight producer: budget", () => {
  for (const tier of ["low", "critical", "empty"] as const) {
    test(`skips an agent in the ${tier} tier: no feed fetch, no inference, nothing stored`, async () => {
      const db = await openDb();
      const clock = fixedClock();
      const agent = await seedAgent(db, { assets: ["WETH"], config: { insightSources: rssSources } });
      const rss = countingRss();
      const producer = createInsightProducer({
        db,
        clock,
        logger: silentLogger,
        budget: fakeBudget(tier),
        agentRouterFor: async () => {
          throw new Error("no router may be used for a paused agent");
        },
        rss: new RssCollector({ feeds: [FEED], clock, fetch: rss.fetchText, logger: silentLogger }),
      });

      const run = await producer.produce(agent);

      expect(run.outcome).toBe("budget_skipped");
      expect(run.reason).toBe(`budget tier ${tier}`);
      expect(rss.fetched).toEqual([]);
      expect(await db.query.insightItems.findMany()).toHaveLength(0);
      expect(await latestInsightDigest(db, agent.id)).toBeNull();
    });
  }
});

describe("insight producer: per-agent 0G key", () => {
  test("createAgentRouterFor uses the stored key (payer agent), rebuilds on rotation, and falls back to the platform", async () => {
    const db = await openDb();
    const agent = await seedAgent(db, { assets: ["WETH"] });
    const bare = await seedAgent(db, { assets: ["WETH"], name: "[test] no key" });
    await insertZgKey(db, { keyId: "zgk-1", agentId: agent.id, creditLimit: 5, resetPeriod: "daily", createdAt: NOW - 1000, encryptedSecret: encryptSecret("sk-agent-one", KEY) });

    const built: string[] = [];
    const platform = new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: recordingFetch(DIGEST_REPLY).fetchFn });
    const routerFor = createAgentRouterFor({
      db,
      encryptionKey: KEY,
      platformRouter: () => platform,
      agentRouter: (apiKey) => {
        built.push(apiKey);
        return new ZeroGRouter({ apiKey, baseUrl: BASE, payer: "agent", fetch: recordingFetch(DIGEST_REPLY).fetchFn });
      },
    });

    const first = await routerFor(agent);
    expect(first.payer).toBe("agent");
    expect(await routerFor(agent)).toBe(first);
    expect(built).toEqual(["sk-agent-one"]);

    expect(await routerFor(bare)).toBe(platform);

    await insertZgKey(db, { keyId: "zgk-2", agentId: agent.id, creditLimit: 5, resetPeriod: "daily", createdAt: NOW, encryptedSecret: encryptSecret("sk-agent-two", KEY) });
    const rotated = await routerFor(agent);
    expect(rotated).not.toBe(first);
    expect(built).toEqual(["sk-agent-one", "sk-agent-two"]);
  });

  test("a stored key without AGENT_KEY_ENCRYPTION_KEY is an error, not a silent platform fallback", async () => {
    const db = await openDb();
    const agent = await seedAgent(db, { assets: ["WETH"] });
    await insertZgKey(db, { keyId: "zgk-x", agentId: agent.id, creditLimit: 5, resetPeriod: "daily", createdAt: NOW, encryptedSecret: encryptSecret("sk-x", KEY) });
    const routerFor = createAgentRouterFor({
      db,
      encryptionKey: null,
      platformRouter: () => {
        throw new Error("platform router must not be used");
      },
      agentRouter: () => {
        throw new Error("agent router must not be built without the key");
      },
    });
    await expect(routerFor(agent)).rejects.toThrow(/AGENT_KEY_ENCRYPTION_KEY/);
  });

  test("a digest is billed to the agent's own key and stored with the agent id, its item rows and its inference record", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const agent = await seedAgent(db, {
      assets: ["WETH"],
      config: { insightSources: [...rssSources, { kind: "web_search" }] },
    });
    await insertZgKey(db, { keyId: "zgk-1", agentId: agent.id, creditLimit: 5, resetPeriod: "daily", createdAt: NOW - 1000, encryptedSecret: encryptSecret("sk-agent-own", KEY) });

    const digest = recordingFetch(DIGEST_REPLY);
    const keysUsed: string[] = [];
    const routerFor = createAgentRouterFor({
      db,
      encryptionKey: KEY,
      platformRouter: () => {
        throw new Error("the platform key must not be used when the agent has its own");
      },
      agentRouter: (apiKey) => {
        keysUsed.push(apiKey);
        return new ZeroGRouter({ apiKey, baseUrl: BASE, payer: "agent", fetch: digest.fetchFn });
      },
    });
    const rss = countingRss();
    const producer = createInsightProducer({
      db,
      clock,
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: routerFor,
      rss: new RssCollector({ feeds: [FEED], clock, fetch: rss.fetchText, logger: silentLogger }),
    });

    const run = await producer.produce(agent);

    expect(run.outcome).toBe("stored");
    expect(run.itemsStored).toBe(1);
    expect(keysUsed).toEqual(["sk-agent-own"]);
    expect(digest.requests).toHaveLength(1);
    expect(digest.requests[0]?.plugins).toEqual([{ id: "web" }]);

    const items = await db.query.insightItems.findMany();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceKind: "rss", sourceRef: FEED, asset: "WETH" });

    const stored = await latestInsightDigest(db, agent.id, { asset: "WETH" });
    expect(stored).toMatchObject({ agentId: agent.id, stance: "bullish", confidence: 0.7, zgRequestId: "req-1" });
    // item-1 is stored as the item's id, not the transient digest label.
    expect(stored?.sourceIds[0]).toMatch(/^rss:/);

    const calls = await db.query.inferenceCalls.findMany({ where: (c, { eq }) => eq(c.agentId, agent.id) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ payer: "agent", purpose: "digest", requestId: "req-1" });
  });

  test("a rejected digest stores no digest and records the calls it made", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const agent = await seedAgent(db, { assets: ["WETH"], config: { insightSources: rssSources } });
    const digest = recordingFetch("I cannot produce JSON for this.");
    const producer = createInsightProducer({
      db,
      clock,
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: async () => new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: digest.fetchFn }),
      rss: new RssCollector({ feeds: [FEED], clock, fetch: countingRss().fetchText, logger: silentLogger }),
    });

    const run = await producer.produce(agent);

    expect(run.outcome).toBe("failed");
    expect(await latestInsightDigest(db, agent.id)).toBeNull();
    expect(await db.query.inferenceCalls.findMany({ where: (c, { eq }) => eq(c.agentId, agent.id) })).toHaveLength(2);
  });
});

describe("insight producer: refresh and cycles", () => {
  test("refreshIfStale digests once, then waits for the digest to be 30 min old", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const agent = await seedAgent(db, { assets: ["WETH"], config: { insightSources: rssSources } });
    const digest = recordingFetch(DIGEST_REPLY);
    const producer = createInsightProducer({
      db,
      clock,
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: async () => new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: digest.fetchFn }),
      rss: new RssCollector({ feeds: [FEED], clock, fetch: countingRss().fetchText, logger: silentLogger }),
    });

    await producer.refreshIfStale(agent);
    expect(digest.requests).toHaveLength(1);

    clock.advance(29 * 60_000);
    await producer.refreshIfStale(agent);
    expect(digest.requests).toHaveLength(1);

    clock.advance(2 * 60_000);
    await producer.refreshIfStale(agent);
    expect(digest.requests).toHaveLength(2);
  });

  test("refreshIfStale does nothing for an agent with no insight sources", async () => {
    const db = await openDb();
    const agent = await seedAgent(db, { assets: ["WETH"] });
    const digest = recordingFetch(DIGEST_REPLY);
    const producer = createInsightProducer({
      db,
      clock: fixedClock(),
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: async () => new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: digest.fetchFn }),
      rss: new RssCollector({ feeds: [FEED], clock: fixedClock(), fetch: countingRss().fetchText, logger: silentLogger }),
    });
    await producer.refreshIfStale(agent);
    expect(digest.requests).toHaveLength(0);
  });

  test("runCycle fetches each feed once for every agent, and skips paused agents", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const a = await seedAgent(db, { assets: ["WETH"], name: "[test] a", config: { insightSources: rssSources } });
    const b = await seedAgent(db, { assets: ["WETH"], name: "[test] b", config: { insightSources: rssSources } });
    const paused = await seedAgent(db, { assets: ["WETH"], name: "[test] paused", status: "paused", config: { insightSources: rssSources } });
    const rss = countingRss();
    const digest = recordingFetch(DIGEST_REPLY);
    const producer = createInsightProducer({
      db,
      clock,
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: async () => new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: digest.fetchFn }),
      rss: new RssCollector({ feeds: [FEED], clock, fetch: rss.fetchText, logger: silentLogger }),
    });

    const runs = await producer.runCycle([a, b, paused]);

    expect(rss.fetched).toEqual([FEED]);
    expect(runs.map((r) => r.agentId)).toEqual([a.id, b.id]);
    expect(runs.map((r) => r.outcome)).toEqual(["stored", "stored"]);
    expect(digest.requests).toHaveLength(2);
  });

  test("an agent whose feeds have nothing about its assets is skipped without an inference call", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const agent = await seedAgent(db, { assets: ["cbBTC"], config: { insightSources: rssSources } });
    const digest = recordingFetch(DIGEST_REPLY);
    const producer = createInsightProducer({
      db,
      clock,
      logger: silentLogger,
      budget: fakeBudget("healthy"),
      agentRouterFor: async () => new ZeroGRouter({ apiKey: "sk-platform", baseUrl: BASE, payer: "platform", fetch: digest.fetchFn }),
      rss: new RssCollector({ feeds: [FEED], clock, fetch: countingRss().fetchText, logger: silentLogger }),
    });
    const run = await producer.produce(agent);
    expect(run.outcome).toBe("no_items");
    expect(digest.requests).toHaveLength(0);
  });
});
