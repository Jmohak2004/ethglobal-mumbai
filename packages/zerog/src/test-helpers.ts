import type { FetchFn } from "./http.ts";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** Fake fetch that records every call and answers with `handler`. No network access. */
export function scriptedFetch(handler: (call: RecordedCall) => Response): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** OpenAI-shaped completion with an x_0g_trace block. */
export function chatCompletion(
  content: string,
  trace: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "glm-5.3",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    x_0g_trace: {
      request_id: "req-default",
      provider: "0xprovider",
      billing: { input_cost: "1", output_cost: "2", total_cost: "3" },
      ...trace,
    },
    ...extra,
  };
}
