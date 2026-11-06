import type { BudgetTier, Episode, InferenceTrace, Lesson, ModelTier } from "@arena/shared";
import { z } from "zod";
import { chatJson } from "./json.ts";
import { modelFor } from "./models.ts";
import { reflectionSystemPrompt, reflectionUserPrompt } from "./prompts.ts";
import type { ZeroGRouter } from "./router.ts";

export interface ClosedTrade {
  episodeId?: string;
  asset: string;
  side: "buy" | "sell";
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
}

export interface ReflectInput {
  agentId: string;
  agentName: string;
  episodes: Episode[];
  closedTrades: ClosedTrade[];
  existingLessons: Lesson[];
  /** Current slider values. Suggestions for unknown keys are dropped when provided. */
  sliders?: Record<string, number>;
  modelTier?: ModelTier;
  budget?: BudgetTier;
}

export interface SliderSuggestion {
  key: string;
  from: number;
  to: number;
  reason: string;
}

export interface ReflectResult {
  lessons: Omit<Lesson, "id" | "zgStorageRoot">[];
  /** Advisory only. The runtime must still clamp to the owner's ±range and hard limits. */
  sliderSuggestions: SliderSuggestion[];
  trace: InferenceTrace;
  traces: InferenceTrace[];
  /** Set when the model output was unusable; lists are empty in that case. */
  error: string | null;
}

const ReflectionSchema = z.object({
  lessons: z
    .array(
      z.object({
        lesson: z.string().min(1).max(400),
        evidenceEpisodeIds: z.array(z.string()).max(20),
        confidence: z.number().min(0).max(1),
        appliesTo: z.array(z.string()).max(10),
      }),
    )
    .max(10),
  sliderSuggestions: z
    .array(
      z.object({
        key: z.string(),
        from: z.number(),
        to: z.number(),
        reason: z.string().max(300),
      }),
    )
    .max(5),
});

/** Turns recent episodes and closed trades into lessons and slider suggestions (PRD §6.6). */
export async function reflect(router: ZeroGRouter, input: ReflectInput): Promise<ReflectResult> {
  const result = await chatJson(
    router,
    {
      model: modelFor("reflection", input.modelTier, input.budget),
      messages: [
        { role: "system", content: reflectionSystemPrompt() },
        {
          role: "user",
          content: reflectionUserPrompt({
            agentName: input.agentName,
            episodes: input.episodes.map(compactEpisode),
            closedTrades: input.closedTrades,
            existingLessons: input.existingLessons,
            sliders: input.sliders,
          }),
        },
      ],
      temperature: 0.3,
      maxTokens: 8192,
      thinking: false,
    },
    ReflectionSchema,
  );

  if (!result.ok) {
    return { lessons: [], sliderSuggestions: [], trace: result.trace, traces: result.traces, error: result.error };
  }

  const knownEpisodes = new Set(input.episodes.map((e) => e.id));
  const now = Date.now();
  const lessons = result.data.lessons.map((l) => ({
    agentId: input.agentId,
    ts: now,
    lesson: l.lesson,
    evidenceEpisodeIds: l.evidenceEpisodeIds.filter((id) => knownEpisodes.has(id)),
    confidence: l.confidence,
    appliesTo: l.appliesTo,
  }));
  const sliders = input.sliders;
  const sliderSuggestions = result.data.sliderSuggestions.filter((s) => !sliders || Object.hasOwn(sliders, s.key));

  return { lessons, sliderSuggestions, trace: result.trace, traces: result.traces, error: null };
}

function compactEpisode(e: Episode) {
  return {
    id: e.id,
    ts: e.ts,
    riskLevel: e.riskLevel,
    budgetTier: e.budgetTier,
    market: e.market.map((m) => ({ asset: m.asset, priceUsd: m.priceUsd })),
    proposal: e.decision?.proposal ?? null,
    verdict: e.verdict.kind,
    reasons: e.verdict.kind === "approve" ? [] : e.verdict.reasons,
    flashOrderIds: e.flashOrderIds,
    error: e.error,
  };
}
