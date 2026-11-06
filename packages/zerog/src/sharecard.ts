import type { InferenceTrace, TemplateId } from "@arena/shared";
import { modelFor } from "./models.ts";
import { shareCardPrompt } from "./prompts.ts";
import type { ZeroGRouter } from "./router.ts";

/**
 * Image size requested for share cards. Assumed to be supported by z-image-turbo;
 * confirm against the model's size limits on pc.0g.ai before relying on it.
 */
export const SHARE_CARD_SIZE = "1024x1024";

export interface ShareCardInput {
  name: string;
  pnlPct: number;
  winRateBps: number;
  rank: number;
  template: TemplateId;
  verified: boolean;
}

/** Stats-only card (PRD §6.9): no trade details are included in the prompt. */
export async function generateShareCard(
  router: ZeroGRouter,
  input: ShareCardInput,
): Promise<{ b64OrUrl: string; trace: InferenceTrace }> {
  return router.image({
    model: modelFor("image"),
    prompt: shareCardPrompt(input),
    size: SHARE_CARD_SIZE,
  });
}
