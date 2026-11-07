import type { InferenceTrace } from "@arena/shared";
import { z } from "zod";
import { chatJson } from "./json.ts";
import { modelFor } from "./models.ts";
import { insightsSystemPrompt } from "./prompts.ts";
import type { ChatTool, ZeroGRouter } from "./router.ts";

export const STANCES = ["bullish", "bearish", "neutral"] as const;

export interface InsightItem {
  source: string;
  title: string;
  text: string;
  url?: string;
  ts: number;
}

export interface AssetInsight {
  stance: (typeof STANCES)[number];
  confidence: number;
  /** Item ids (`item-1`, `item-2`, …) that support the stance. */
  sourceIds: string[];
}

export interface InsightDigest {
  perAsset: Record<string, AssetInsight>;
  summary: string;
  trace: InferenceTrace;
  traces: InferenceTrace[];
  error: string | null;
}

export interface DigestInput {
  assets: string[];
  items: InsightItem[];
  useWebSearch: boolean;
}

/** Router built-in tools (`0g:web_search`, `0g:web_fetch`), declared in the `tools` array. */
export const WEB_TOOLS: ChatTool[] = [
  { type: "0g:web_search", max_uses: 2 },
  { type: "0g:web_fetch", max_uses: 3, max_content_tokens: 3000 },
];

const DigestSchema = z.object({
  perAsset: z.record(
    z.string(),
    z.object({
      stance: z.enum(STANCES),
      confidence: z.number().min(0).max(1),
      sourceIds: z.array(z.string()).max(20),
    }),
  ),
  summary: z.string().max(600),
});

const ASSET_NAMES: Record<string, string> = {
  WETH: "Ethereum (ETH)",
  ETH: "Ethereum (ETH)",
  cbBTC: "Bitcoin (BTC)",
  BTC: "Bitcoin (BTC)",
  AERO: "Aerodrome (AERO)",
  VIRTUAL: "Virtuals (VIRTUAL)",
  DEGEN: "Degen (DEGEN)",
  TOSHI: "Toshi (TOSHI)",
  WELL: "Moonwell (WELL)",
  ZORA: "Zora (ZORA)",
  CLANKER: "Clanker (CLANKER)",
  PROMPT: "Wayfinder (PROMPT)",
  KEYCAT: "Keyboard Cat (KEYCAT)",
  COOKIE: "Cookie DAO (COOKIE)",
  B3: "B3 (B3)",
  BNKR: "Bankr (BNKR)",
  AVNT: "Avantis (AVNT)",
};

/**
 * The Router's web plugin searches with the user message, so when web search is on the message opens with a
 * plain-language news query; the collected items follow as JSON.
 */
export function digestUserMessage(assets: string[], items: unknown[], useWebSearch: boolean): string {
  const json = JSON.stringify({ items }, null, 2);
  if (!useWebSearch) return json;
  const names = [...new Set(assets.map((a) => ASSET_NAMES[a] ?? a))].join(" and ");
  return `Latest crypto market news today for ${names}: price moves, ETF flows, regulation, hacks, macro.\n\nCollected items:\n${json}`;
}

/** Digests raw social and news items into a stance per asset (PRD §6.8). */
export async function digestInsights(router: ZeroGRouter, input: DigestInput): Promise<InsightDigest> {
  const items = input.items.map((item, i) => ({
    id: `item-${i + 1}`,
    source: item.source,
    title: item.title,
    text: item.text.slice(0, 800),
    url: item.url,
    ts: item.ts,
  }));

  const result = await chatJson(
    router,
    {
      model: modelFor("digest"),
      messages: [
        { role: "system", content: insightsSystemPrompt(input.assets, input.useWebSearch) },
        { role: "user", content: digestUserMessage(input.assets, items, input.useWebSearch) },
      ],
      // The web plugin works with any model; the 0g:web_search tool needs tool calling, which 0gm-1.0 lacks.
      plugins: input.useWebSearch ? [{ id: "web" }] : undefined,
      temperature: 0.2,
      maxTokens: 8192,
      thinking: false,
    },
    DigestSchema,
  );

  if (!result.ok) {
    return { perAsset: {}, summary: "", trace: result.trace, traces: result.traces, error: result.error };
  }

  const knownItems = new Set(items.map((i) => i.id));
  const known = new Set(input.assets);
  const perAsset: Record<string, AssetInsight> = {};
  for (const [asset, insight] of Object.entries(result.data.perAsset)) {
    if (!known.has(asset)) continue;
    perAsset[asset] = {
      stance: insight.stance,
      confidence: insight.confidence,
      sourceIds: insight.sourceIds.filter((id) => knownItems.has(id)),
    };
  }

  return { perAsset, summary: result.data.summary, trace: result.trace, traces: result.traces, error: null };
}
