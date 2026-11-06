import type {
  BudgetTier,
  DecisionOutput,
  InferenceTrace,
  Lesson,
  MarketSnapshot,
  Proposal,
  RiskLevel,
  StrategyConfig,
} from "@arena/shared";
import { z, type ZodType } from "zod";
import { chatJson } from "./json.ts";
import { modelFor } from "./models.ts";
import { PROPOSAL_ACTIONS, ORDER_TYPES, decisionSystemPrompt, decisionUserPrompt } from "./prompts.ts";
import type { InsightDigest } from "./insights.ts";
import type { ZeroGRouter } from "./router.ts";

/** Schema for a model-produced proposal. Null or missing optional fields are normalized to undefined. */
const opt = <S extends ZodType>(schema: S) => schema.nullish().transform((v) => v ?? undefined);

export const ProposalSchema = z.object({
  action: z.enum(PROPOSAL_ACTIONS),
  asset: opt(z.string().min(1)),
  orderType: opt(z.enum(ORDER_TYPES)),
  sizePct: opt(z.number().min(0).max(1)),
  limitPrice: opt(z.number().positive()),
  triggerPrice: opt(z.number().positive()),
  takeProfitPct: opt(z.number().positive()),
  stopLossPct: opt(z.number().positive()),
  trailPct: opt(z.number().positive()),
  twapDurationSec: opt(z.number().int().positive()),
  twapBuckets: opt(z.number().int().positive()),
  rationale: z.string().max(1000),
});

export const ForecastSchema = z
  .object({
    asset: z.string().min(1),
    horizonMin: z.number().positive(),
    direction: z.enum(["up", "down", "flat"]),
    expectedMovePct: z.number(),
    confidence: z.number().min(0).max(1),
  })
  .nullish()
  .transform((v) => v ?? null);

export const DecisionOutputSchema = z.object({
  forecast: ForecastSchema,
  proposal: ProposalSchema,
});

export interface DecideInput {
  agentName: string;
  config: StrategyConfig;
  templateSummary: string;
  market: MarketSnapshot[];
  lessons: Lesson[];
  insights?: InsightDigest;
  risk: RiskLevel;
  budget: BudgetTier;
  openPositions: unknown[];
}

export interface DecideResult {
  output: DecisionOutput;
  /** Trace of the last attempt (the one that produced `output`, or the final failed one). */
  trace: InferenceTrace;
  /** Traces of every attempt, so each billed request can be recorded. */
  traces: InferenceTrace[];
  /** True when both attempts were invalid and the hold fallback was used. */
  fallback: boolean;
  error: string | null;
}

/**
 * Asks the decision model for a forecast and a proposal.
 * Never throws for bad model output: after an invalid reply and one retry, returns a "hold" proposal.
 * API errors (e.g. `InsufficientBalanceError` on 402) still throw.
 */
export async function decide(router: ZeroGRouter, input: DecideInput): Promise<DecideResult> {
  const result = await chatJson(
    router,
    {
      model: modelFor("decision", input.config.modelTier, input.budget),
      messages: [
        {
          role: "system",
          content: decisionSystemPrompt({
            agentName: input.agentName,
            config: input.config,
            templateSummary: input.templateSummary,
            risk: input.risk,
            budget: input.budget,
          }),
        },
        {
          role: "user",
          content: decisionUserPrompt({
            config: input.config,
            openPositions: input.openPositions,
            market: input.market,
            lessons: input.lessons,
            insights: input.insights,
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: 2048,
    },
    DecisionOutputSchema,
  );

  if (result.ok) {
    return { output: result.data, trace: result.trace, traces: result.traces, fallback: false, error: null };
  }
  return {
    output: holdOutput(result.error),
    trace: result.trace,
    traces: result.traces,
    fallback: true,
    error: result.error,
  };
}

export function holdOutput(reason: string): DecisionOutput {
  const proposal: Proposal = {
    action: "hold",
    rationale: `Model output was rejected after retry, holding. ${reason}`.slice(0, 280),
  };
  return { forecast: null, proposal };
}
