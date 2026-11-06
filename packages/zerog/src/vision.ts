import type { InferenceTrace, TemplateId } from "@arena/shared";
import { z } from "zod";
import { chatJson } from "./json.ts";
import { modelFor } from "./models.ts";
import { TEMPLATE_IDS, visionSystemPrompt } from "./prompts.ts";
import { ModelOutputError } from "./errors.ts";
import type { ZeroGRouter } from "./router.ts";

export const TRENDS = ["bullish", "bearish", "range"] as const;

export interface AnalyzeChartInput {
  /** `data:image/…;base64,…` or an https URL. */
  image: string;
  asset?: string;
}

export interface ChartAnalysis {
  trend: (typeof TRENDS)[number];
  keyLevels: number[];
  suggestedTemplate: TemplateId;
  suggestedSliders: Record<string, number>;
  summary: string;
  trace: InferenceTrace;
  traces: InferenceTrace[];
}

const VisionSchema = z.object({
  trend: z.enum(TRENDS),
  keyLevels: z.array(z.number()).max(10),
  suggestedTemplate: z.enum(TEMPLATE_IDS),
  suggestedSliders: z.record(z.string(), z.number()),
  summary: z.string().max(600),
});

/**
 * Reads a chart screenshot with the vision model.
 * Throws `ModelOutputError` if the model output is unusable after one retry.
 */
export async function analyzeChart(router: ZeroGRouter, input: AnalyzeChartInput): Promise<ChartAnalysis> {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(input.image) && !/^https:\/\//i.test(input.image)) {
    throw new TypeError("analyzeChart: image must be a data:image/…;base64 URL or an https URL");
  }

  const question = input.asset
    ? `Analyze this price chart for ${input.asset}.`
    : "Analyze this price chart.";

  const result = await chatJson(
    router,
    {
      model: modelFor("vision"),
      messages: [
        { role: "system", content: visionSystemPrompt() },
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: input.image } },
          ],
        },
      ],
      temperature: 0.1,
      maxTokens: 4096,
      thinking: false,
    },
    VisionSchema,
  );

  if (!result.ok) {
    throw new ModelOutputError(`analyzeChart: ${result.error}`);
  }
  return {
    trend: result.data.trend,
    keyLevels: result.data.keyLevels,
    suggestedTemplate: result.data.suggestedTemplate,
    suggestedSliders: result.data.suggestedSliders,
    summary: result.data.summary,
    trace: result.trace,
    traces: result.traces,
  };
}
