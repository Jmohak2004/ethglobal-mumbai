import type { InferenceTrace } from "@arena/shared";
import type { ZodType } from "zod";
import type { ChatMessage, ChatTool, ZeroGRouter } from "./router.ts";
import { parseModelJson } from "./util.ts";

export interface ChatJsonRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  maxTokens?: number;
  /** Forwarded to ChatRequest.thinking. */
  thinking?: boolean;
  /** Forwarded to ChatRequest.plugins. */
  plugins?: { id: string }[];
}

export type ChatJsonResult<T> =
  | { ok: true; data: T; trace: InferenceTrace; traces: InferenceTrace[] }
  | { ok: false; error: string; trace: InferenceTrace; traces: InferenceTrace[] };

/**
 * JSON-mode call validated against a zod schema.
 * On an invalid reply, the assistant reply and the validation error are appended and the call is repeated
 * (up to `maxAttempts`). API errors (including 402) are NOT caught here; they propagate to the caller.
 */
export async function chatJson<T>(
  router: ZeroGRouter,
  req: ChatJsonRequest,
  schema: ZodType<T>,
  maxAttempts = 2,
): Promise<ChatJsonResult<T>> {
  const messages: ChatMessage[] = [...req.messages];
  const traces: InferenceTrace[] = [];
  let lastTrace: InferenceTrace | undefined;
  let error = "no attempts made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await router.chat({ ...req, messages, json: true });
    traces.push(res.trace);
    lastTrace = res.trace;

    const parsed = parseModelJson(res.content);
    if (parsed.ok) {
      const checked = schema.safeParse(parsed.value);
      if (checked.success) return { ok: true, data: checked.data, trace: res.trace, traces };
      error = checked.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    } else {
      error = parsed.error;
    }

    if (attempt < maxAttempts) {
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: `Your previous reply was invalid: ${error}. Reply again with only the corrected JSON object, no prose and no markdown.`,
      });
    }
  }

  // maxAttempts >= 1 guarantees at least one trace.
  return { ok: false, error, trace: lastTrace as InferenceTrace, traces };
}
