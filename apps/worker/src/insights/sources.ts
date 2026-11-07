// Insight collectors (PRD 6.8). Each collector returns CollectedItem rows, which are stored in insight_items and
// passed to the digester.
//   - RSS/Atom: curated feeds only. Fetched with a 10 s deadline and cached per URL for 5 min.
//   - Agent commentary: another agent's public view. Only for sources with publicCommentary "delayed", only
//     episodes at least 1 h old, and only the forecast direction and the rationale. Sizes, prices and order
//     details never leave the source agent.
//   - 0G web search is not collected here. The digester runs it when the config includes {kind: "web_search"}.

import { createHash } from "node:crypto";
import { getAgent, listEpisodesByAgent, type Db } from "@arena/db";
import type { Agent, Episode, Proposal } from "@arena/shared";
import type { InsightItem } from "@arena/zerog";
import type { Clock } from "../deps.ts";
import { silentLogger, type Logger } from "../logger.ts";

export const DEFAULT_RSS_FEEDS: readonly string[] = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
];
export const RSS_TIMEOUT_MS = 10_000;
export const RSS_CACHE_MS = 5 * 60_000;
/** Commentary is read only from episodes at least this old, so it is never a live signal to copy (PRD 6.8). */
export const COMMENTARY_DELAY_MS = 60 * 60_000;
const MAX_ITEMS_PER_FEED = 30;
const MAX_COMMENTARY_PER_SOURCE = 3;

/** An item ready to store and to digest. `id` is stable, so collecting the same item twice stores it once. */
export interface CollectedItem extends InsightItem {
  id: string;
  sourceKind: "rss" | "agent";
  /** Feed url for RSS, source agent id for commentary. */
  sourceRef: string;
}

/** One parsed RSS item or Atom entry, before it is tied to a source. */
export interface FeedEntry {
  /** guid, id or link, whichever the feed gives. Stable across fetches. */
  key: string;
  title: string;
  text: string;
  url?: string;
  ts: number;
}

/** INSIGHT_RSS_FEEDS (comma list). Unset or blank uses the defaults. Entries that are not http(s) urls are dropped. */
export function parseFeedList(raw: string | undefined): string[] {
  const list = raw && raw.trim() ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_RSS_FEEDS];
  return [...new Set(list)].filter(isHttpUrl);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal XML reading for RSS 2.0 and Atom. Regex based, no DOM. It handles CDATA and HTML inside text.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Plain text from an XML fragment: CDATA unwrapped, HTML removed, entities decoded, whitespace collapsed. Feeds often
 * entity-escape their HTML (`&lt;p&gt;`), so tags are removed again after decoding.
 */
export function cleanText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decoded = decodeEntities(unwrapped.replace(/<[^>]*>/g, " "));
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Plain text of the first <tag>…</tag> in a block. Null when absent or empty. Self-closing tags do not match. */
function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block);
  if (!match) return null;
  const text = cleanText(match[1] ?? "");
  return text === "" ? null : text;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
  const value = match ? decodeEntities(match[1] ?? "").trim() : "";
  return value === "" ? null : value;
}

/** RSS `<link>url</link>`, or the first Atom `<link href>` with rel "alternate" (or no rel). */
function entryLink(block: string): string | null {
  const rssLink = tagText(block, "link");
  if (rssLink && isHttpUrl(rssLink)) return rssLink;
  for (const match of block.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const rel = attribute(attrs, "rel");
    const href = attribute(attrs, "href");
    if (href && isHttpUrl(href) && (!rel || rel === "alternate")) return href;
  }
  return null;
}

function entryTime(block: string, fallback: number): number {
  for (const tag of ["pubDate", "published", "updated", "dc:date"]) {
    const value = tagText(block, tag);
    if (value) {
      const ts = Date.parse(value);
      if (Number.isFinite(ts)) return ts;
    }
  }
  return fallback;
}

/**
 * Parses RSS `<item>` and Atom `<entry>` elements in document order (at most 30). Entries with neither a title
 * nor text are dropped. `fallbackTs` is used when an entry has no usable date.
 */
export function parseFeed(xml: string, fallbackTs: number): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const block = match[2] ?? "";
    const title = tagText(block, "title") ?? "";
    const body =
      tagText(block, "content:encoded") ?? tagText(block, "description") ?? tagText(block, "summary") ?? tagText(block, "content") ?? "";
    if (!title && !body) continue;
    const url = entryLink(block) ?? undefined;
    const key = tagText(block, "guid") ?? tagText(block, "id") ?? url ?? title;
    out.push({ key, title: title || body.slice(0, 120), text: body, url, ts: entryTime(block, fallbackTs) });
    if (out.length >= MAX_ITEMS_PER_FEED) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RSS/Atom collector
// ---------------------------------------------------------------------------

export type FetchText = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface RssCollectorOptions {
  /** The curated feed urls. Any other url is refused. */
  feeds: string[];
  clock: Clock;
  logger?: Logger;
  /** HTTP client. Defaults to the global fetch. Tests inject a fake. */
  fetch?: FetchText;
  timeoutMs?: number;
  cacheMs?: number;
}

export class RssCollector {
  private readonly allowed: Set<string>;
  private readonly cache = new Map<string, { at: number; entries: FeedEntry[] }>();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchText;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;

  constructor(opts: RssCollectorOptions) {
    this.allowed = new Set(opts.feeds);
    this.clock = opts.clock;
    this.logger = opts.logger ?? silentLogger;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? RSS_TIMEOUT_MS;
    this.cacheMs = opts.cacheMs ?? RSS_CACHE_MS;
  }

  /**
   * Entries for each requested url. Urls outside the curated list are skipped. A feed that fails maps to an empty
   * list and is logged, so one bad feed never fails a cycle. Each url is fetched at most once per call.
   */
  async collect(urls: string[]): Promise<Map<string, FeedEntry[]>> {
    const out = new Map<string, FeedEntry[]>();
    for (const url of new Set(urls)) {
      if (!this.allowed.has(url)) {
        this.logger.warn("insight feed is not in the curated list; skipped", { url });
        continue;
      }
      out.set(url, await this.entries(url));
    }
    return out;
  }

  private async entries(url: string): Promise<FeedEntry[]> {
    const now = this.clock.now();
    const hit = this.cache.get(url);
    if (hit && now - hit.at < this.cacheMs) return hit.entries;
    try {
      const entries = await this.fetchWithDeadline(url);
      this.cache.set(url, { at: now, entries });
      return entries;
    } catch (err) {
      this.logger.warn("rss fetch failed; feed skipped this cycle", { url, error: err });
      return [];
    }
  }

  /** The download races a timer, so a fetch that ignores its abort signal still fails at the deadline. */
  private async fetchWithDeadline(url: string): Promise<FeedEntry[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.download(url, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async download(url: string, signal: AbortSignal): Promise<FeedEntry[]> {
    const res = await this.fetchImpl(url, {
      signal,
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), this.clock.now());
  }
}

// ---------------------------------------------------------------------------
// Agent commentary
// ---------------------------------------------------------------------------

const ORDER_VALUE_KEYS = ["sizePct", "limitPrice", "triggerPrice", "takeProfitPct", "stopLossPct", "trailPct", "twapDurationSec", "twapBuckets"] as const;

/**
 * Hides figures that could reveal an order. Currency amounts are replaced, and so is every exact value of the
 * proposal's order fields (as written, with thousands separators, and as a percentage). Other words are kept.
 */
export function redactOrderValues(text: string, proposal: Partial<Proposal>): string {
  let out = text
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, "[redacted]")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USDT|USD|WETH|ETH|cbBTC|BTC|AERO|VIRTUAL|DEGEN|TOSHI|WELL|ZORA)\b/gi, "[redacted]");
  for (const key of ORDER_VALUE_KEYS) {
    const value = proposal[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value === 0) continue;
    const forms = new Set<string>([String(value), value.toLocaleString("en-US", { maximumFractionDigits: 8 })]);
    if (value > 0 && value <= 1) forms.add(String(Number((value * 100).toFixed(2))));
    for (const form of forms) {
      if (form.length < 2) continue;
      out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

/**
 * The public view of one episode: the forecast direction and the rationale. Returns null when there is nothing to
 * say. Sizes, prices, order types, verdicts and fills are never read.
 */
export function commentaryText(episode: Pick<Episode, "decision">): string | null {
  const decision = episode.decision;
  if (!decision) return null;
  const asset = decision.forecast?.asset ?? decision.proposal.asset;
  if (!asset) return null;
  const direction = decision.forecast?.direction ?? null;
  const rationale = redactOrderValues(decision.proposal.rationale ?? "", decision.proposal).trim();
  if (!direction && rationale === "") return null;
  const view = direction ? `Forecast for ${asset}: ${direction}.` : `No forecast for ${asset}.`;
  return [view, rationale].filter(Boolean).join(" ");
}

export interface CommentaryOptions {
  db: Db;
  clock: Clock;
  logger?: Logger;
  /** Default 1 h (COMMENTARY_DELAY_MS). */
  delayMs?: number;
}

/**
 * Commentary from the source agents that opted in. Each source yields up to 3 of its newest episodes that are older
 * than the delay. `selfId` is skipped, so an agent never digests its own posts.
 */
export async function collectAgentCommentary(opts: CommentaryOptions, sourceAgentIds: string[], selfId?: string): Promise<CollectedItem[]> {
  const logger = opts.logger ?? silentLogger;
  const cutoff = opts.clock.now() - (opts.delayMs ?? COMMENTARY_DELAY_MS);
  const out: CollectedItem[] = [];
  for (const sourceId of new Set(sourceAgentIds)) {
    if (sourceId === selfId) continue;
    const source: Agent | null = await getAgent(opts.db, sourceId);
    if (!source) {
      logger.warn("insight source agent not found; skipped", { source: sourceId });
      continue;
    }
    if (source.config.publicCommentary !== "delayed") continue;
    const episodes = await listEpisodesByAgent(opts.db, sourceId, { limit: MAX_COMMENTARY_PER_SOURCE * 5, beforeTs: cutoff });
    let taken = 0;
    for (const episode of episodes) {
      if (taken >= MAX_COMMENTARY_PER_SOURCE) break;
      const text = commentaryText(episode);
      if (!text) continue;
      taken += 1;
      out.push({
        id: `agent:${episode.id}`,
        source: `agent:${source.name}`,
        title: `${source.name} market view`,
        text,
        ts: episode.ts,
        sourceKind: "agent",
        sourceRef: source.id,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Asset matching (PRD 6.8: ETH/Ether/WETH, BTC/Bitcoin/cbBTC; Base tokens by ticker and project name)
// ---------------------------------------------------------------------------

const ASSET_TERMS: Record<string, string[]> = {
  WETH: ["WETH", "ETH", "Ether", "Ethereum"],
  ETH: ["ETH", "Ether", "Ethereum", "WETH"],
  cbBTC: ["cbBTC", "BTC", "Bitcoin"],
  BTC: ["BTC", "Bitcoin", "cbBTC"],
  AERO: ["AERO", "Aerodrome"],
  VIRTUAL: ["VIRTUAL", "Virtuals"],
  DEGEN: ["DEGEN", "Degen"],
  TOSHI: ["TOSHI", "Toshi"],
  WELL: ["WELL", "Moonwell"],
  ZORA: ["ZORA", "Zora"],
};

/**
 * Terms that match only in this exact case. "well", "degen" and "virtual" are ordinary words in news text, so their
 * tickers match only in capitals and the project name "Degen" only when capitalised.
 */
const EXACT_CASE_TERMS = new Set(["AERO", "VIRTUAL", "DEGEN", "Degen", "TOSHI", "WELL", "ZORA"]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The allowlisted assets that the text mentions as whole words. Unknown assets match by their own ticker. */
export function assetsMentioned(text: string, assets: string[]): string[] {
  return assets.filter((asset) => {
    const terms = ASSET_TERMS[asset] ?? [asset];
    return terms.some((term) => {
      const flags = EXACT_CASE_TERMS.has(term) ? "" : "i";
      return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, flags).test(text);
    });
  });
}

/** Stable short id from parts. Used for item ids, so the same article is stored once. */
export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}
