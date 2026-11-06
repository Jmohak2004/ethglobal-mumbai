import type {
  BudgetTier,
  Lesson,
  MarketSnapshot,
  FlashOrderType,
  ProposalAction,
  RiskLevel,
  StrategyConfig,
  TemplateId,
} from "@arena/shared";

export const ORDER_TYPES = [
  "market",
  "limit",
  "twap",
  "stop",
  "stop-loss",
  "take-profit",
  "bracket",
  "trailing-stop",
  "trailing-stop-limit",
] as const satisfies readonly FlashOrderType[];

export const PROPOSAL_ACTIONS = ["buy", "sell", "hold", "adjust_stops", "cancel"] as const satisfies readonly ProposalAction[];

export const TEMPLATE_IDS = [
  "momentum",
  "mean_reversion",
  "breakout",
  "smart_dca",
  "social_sentiment",
] as const satisfies readonly TemplateId[];

const TEMPLATE_LABELS: Record<TemplateId, string> = {
  momentum: "Momentum",
  mean_reversion: "Mean Reversion",
  breakout: "Breakout",
  smart_dca: "Smart DCA",
  social_sentiment: "Social Sentiment",
};

export interface DecisionPromptInput {
  agentName: string;
  config: StrategyConfig;
  templateSummary: string;
  risk: RiskLevel;
  budget: BudgetTier;
  openPositions: unknown[];
  market: MarketSnapshot[];
  lessons: Lesson[];
  insights?: unknown;
}

export function decisionSystemPrompt(input: Pick<DecisionPromptInput, "agentName" | "config" | "templateSummary" | "risk" | "budget">): string {
  const { agentName, config, templateSummary, risk, budget } = input;
  const riskNote =
    risk === "NORMAL" ? "" : risk === "CAUTION" ? " Risk is elevated (CAUTION): prefer hold or smaller sizes." : " Risk is HALT: propose only hold, cancel, or adjust_stops.";
  const budgetNote =
    budget === "healthy"
      ? ""
      : budget === "low"
        ? " Compute budget is low: only propose a new entry on a strong signal."
        : " Compute budget is critical or empty: do not propose new entries; use hold, cancel, adjust_stops, or sell.";

  return [
    `You are the decision engine for the autonomous trading agent "${agentName}". Reply with exactly one JSON object with keys "forecast" and "proposal".`,
    "",
    "Reply schema:",
    `{ "forecast": null | { "asset": string, "horizonMin": number, "direction": "up" | "down" | "flat", "expectedMovePct": number, "confidence": number between 0 and 1 },`,
    `  "proposal": { "action": ${PROPOSAL_ACTIONS.map((a) => `"${a}"`).join(" | ")},`,
    `    "asset"?: string, "orderType"?: ${ORDER_TYPES.map((o) => `"${o}"`).join(" | ")},`,
    `    "sizePct"?: number between 0 and 1, "limitPrice"?: number, "triggerPrice"?: number,`,
    `    "takeProfitPct"?: number, "stopLossPct"?: number, "trailPct"?: number,`,
    `    "twapDurationSec"?: number, "twapBuckets"?: number, "rationale": string (max 280 characters) } }`,
    "",
    "Hard rules. A deterministic policy engine checks every proposal and may clamp or reject it, but you must follow these anyway:",
    `- Only trade these assets: ${config.assets.join(", ")}. Use "hold" when there is no clear edge.`,
    `- Only use order types the template allows. Template (${TEMPLATE_LABELS[config.template]}): ${templateSummary}`,
    "- sizePct is a fraction of the agent's allocation, from 0 to 1 (0.25 means 25%).",
    "- Every buy MUST include takeProfitPct and stopLossPct as positive percentages.",
    "- Never propose orders on other assets or on other chains.",
    `- Respond with JSON only.${riskNote}${budgetNote}`,
  ].join("\n");
}

export function decisionUserPrompt(input: Omit<DecisionPromptInput, "agentName" | "templateSummary" | "risk" | "budget">): string {
  return JSON.stringify(
    {
      sliders: input.config.sliders,
      limits: input.config.limits,
      openPositions: input.openPositions,
      market: input.market.map(marketForPrompt),
      lessons: input.lessons.slice(0, 10).map((l) => ({ lesson: l.lesson, confidence: l.confidence, appliesTo: l.appliesTo })),
      insights: input.insights ?? null,
    },
    null,
    2,
  );
}

/** Compact view of a market snapshot: price, indicators and the last 24 closes. */
export function marketForPrompt(snapshot: MarketSnapshot) {
  return {
    asset: snapshot.asset,
    priceUsd: snapshot.priceUsd,
    indicators: snapshot.indicators,
    recentCloses: snapshot.candles.slice(-24).map((c) => c.c),
  };
}

export function reflectionSystemPrompt(): string {
  return [
    "You review a trading agent's recent decisions and their outcomes, then write short, evidence-based lessons.",
    'Reply with one JSON object: {"lessons": [{"lesson": string, "evidenceEpisodeIds": string[], "confidence": number 0..1, "appliesTo": string[]}], "sliderSuggestions": [{"key": string, "from": number, "to": number, "reason": string}]}.',
    "Rules:",
    "- Cite only episode IDs that appear in the input as evidence.",
    "- Do not repeat existing lessons.",
    "- sliderSuggestions may only change existing slider keys. Never suggest changes to the asset allowlist, max size, loss limits, or commission.",
    "- Reply with JSON only.",
  ].join("\n");
}

export function reflectionUserPrompt(input: {
  agentName: string;
  episodes: unknown[];
  closedTrades: unknown[];
  existingLessons: Lesson[];
  sliders?: Record<string, number>;
}): string {
  return JSON.stringify(
    {
      agent: input.agentName,
      sliders: input.sliders ?? null,
      existingLessons: input.existingLessons.map((l) => l.lesson),
      closedTrades: input.closedTrades,
      episodes: input.episodes,
    },
    null,
    2,
  );
}

export function insightsSystemPrompt(assets: string[], useWebSearch: boolean): string {
  return [
    "You digest crypto news and social posts into a directional stance per asset.",
    `Assets of interest: ${assets.join(", ")}. Ignore everything else.`,
    'Reply with one JSON object: {"perAsset": {"<ASSET>": {"stance": "bullish" | "bearish" | "neutral", "confidence": number 0..1, "sourceIds": string[]}}, "summary": string (max 600 characters)}.',
    "sourceIds must reference item ids from the input. Use an empty array when the stance comes only from web search.",
    useWebSearch
      ? "You may search the web for recent public posts and news on these assets. Keep searches short."
      : "Use only the items provided.",
    "Reply with JSON only.",
  ].join("\n");
}

export function visionSystemPrompt(): string {
  return [
    "You analyze a price chart screenshot for a trading agent builder.",
    'Reply with one JSON object: {"trend": "bullish" | "bearish" | "range", "keyLevels": number[] (up to 10 price levels), "suggestedTemplate": one of ' +
      TEMPLATE_IDS.join(", ") +
      ', "suggestedSliders": {"<name>": number}, "summary": string (max 600 characters)}.',
    "Only read levels that are visible on the chart. Do not invent prices. Reply with JSON only.",
  ].join("\n");
}

const SHARE_CARD_PROMPT_NOTE =
  "Clean dark trading-card design, minimal, neon accent lines, subtle grid background. No charts, no candles, no prices, no order details, no wallet addresses.";

export function shareCardPrompt(input: {
  name: string;
  pnlPct: number;
  winRateBps: number;
  rank: number;
  template: TemplateId;
  verified: boolean;
}): string {
  const pnl = `${input.pnlPct >= 0 ? "+" : ""}${input.pnlPct.toFixed(1)}%`;
  const winRate = `${(input.winRateBps / 100).toFixed(1)}%`;
  return [
    SHARE_CARD_PROMPT_NOTE,
    `Card title: "${input.name}". Strategy label: "${TEMPLATE_LABELS[input.template]}".`,
    `Large stat lines: rank #${input.rank}, PnL ${pnl}, win rate ${winRate}.`,
    input.verified ? 'Add a small "Verified" badge in the corner.' : "No verification badge.",
  ].join(" ");
}
