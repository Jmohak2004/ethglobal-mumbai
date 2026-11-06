import { ZG_ROUTER_URL, type InferenceTrace } from "@arena/shared";
import { type FetchFn, type HttpContext, type HttpResult, httpJson } from "./http.ts";
import { isRecord } from "./util.ts";

export type Payer = "agent" | "user" | "platform";
export type TrustMode = "standard" | "verified" | "private";

export interface ZeroGRouterOptions {
  /** `sk-…` inference key (per agent, or the user's BYOK key). */
  apiKey: string;
  /** Defaults to the mainnet Router (`ZG_ROUTER_URL.mainnet`). */
  baseUrl?: string;
  payer: Payer;
  /** Sent as `X-0G-Provider-Trust-Mode`. Default "verified". */
  trustMode?: TrustMode;
  /** Sends `verify_tee: true` so the trace carries `tee_verified`. Default true. */
  verifyTee?: boolean;
  fetch?: FetchFn;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  name?: string;
}

export interface FunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** Router built-in tools. Declared in the request `tools` array; stripped before the provider sees them. */
export type BuiltinTool =
  | { type: "0g:web_search"; max_uses?: number }
  | {
      type: "0g:web_fetch";
      max_uses?: number;
      max_content_tokens?: number;
      allowed_domains?: string[];
      blocked_domains?: string[];
    };

export type ChatTool = FunctionTool | BuiltinTool;

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string, as returned by the model. */
  arguments: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Sets `response_format: { type: "json_object" }`. */
  json?: boolean;
  tools?: ChatTool[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  x_0g_trace?: unknown;
  [key: string]: unknown;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  raw: ChatCompletionResponse;
  trace: InferenceTrace;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  /** e.g. "1024x1024". Allowed sizes depend on the model. */
  size: string;
}

export interface ImageResult {
  /** Base64 PNG/JPEG data (`response_format: "b64_json"`), or a URL if the Router returned one. */
  b64OrUrl: string;
  trace: InferenceTrace;
}

const defaultFetch: FetchFn = (input, init) => fetch(input, init);

export class ZeroGRouter {
  readonly payer: Payer;
  readonly trustMode: TrustMode;
  readonly baseUrl: string;
  private readonly verifyTee: boolean;
  private readonly http: HttpContext;

  constructor(opts: ZeroGRouterOptions) {
    if (!opts.apiKey) throw new Error("ZeroGRouter: apiKey is required");
    this.payer = opts.payer;
    this.trustMode = opts.trustMode ?? "verified";
    this.baseUrl = (opts.baseUrl ?? ZG_ROUTER_URL.mainnet).replace(/\/+$/, "");
    this.verifyTee = opts.verifyTee ?? true;
    this.http = {
      baseUrl: this.baseUrl,
      apiKey: opts.apiKey,
      fetch: opts.fetch ?? defaultFetch,
      headers: { "X-0G-Provider-Trust-Mode": this.trustMode },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages };
    if (this.verifyTee) body.verify_tee = true;
    if (req.json) body.response_format = { type: "json_object" };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    const res = await httpJson<unknown>(this.http, "POST", "/chat/completions", { body });
    const data = asCompletion(res.data);
    const message = data.choices?.[0]?.message;
    return {
      content: typeof message?.content === "string" ? message.content : "",
      toolCalls: parseToolCalls(message?.tool_calls),
      raw: data,
      trace: buildTrace(res, { model: req.model, payer: this.payer }),
    };
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const res = await httpJson<unknown>(this.http, "POST", "/images/generations", {
      body: { model: req.model, prompt: req.prompt, size: req.size, n: 1, response_format: "b64_json" },
    });
    const items: unknown[] = isRecord(res.data) && Array.isArray(res.data.data) ? res.data.data : [];
    const first = items[0];
    const item = isRecord(first) ? first : {};
    const b64OrUrl =
      typeof item.b64_json === "string" ? item.b64_json : typeof item.url === "string" ? item.url : null;
    if (!b64OrUrl) throw new Error(`0G Router image response had no image data (model ${req.model})`);
    return { b64OrUrl, trace: buildTrace(res, { model: req.model, payer: this.payer }) };
  }
}

function asCompletion(value: unknown): ChatCompletionResponse {
  return isRecord(value) ? (value as ChatCompletionResponse) : {};
}

function buildTrace(
  res: HttpResult<unknown>,
  meta: { model: string; payer: Payer },
): InferenceTrace {
  const data = isRecord(res.data) ? res.data : {};
  const t = isRecord(data.x_0g_trace) ? data.x_0g_trace : {};
  const billing =
    typeof t.billing === "string"
      ? t.billing
      : isRecord(t.billing) && typeof t.billing.total_cost === "string"
        ? t.billing.total_cost
        : null;
  const requestId =
    typeof t.request_id === "string" ? t.request_id : (res.headers.get("x-request-id") ?? (typeof data.id === "string" ? data.id : ""));
  return {
    requestId,
    model: meta.model,
    provider: typeof t.provider === "string" ? t.provider : null,
    billing,
    teeVerified: typeof t.tee_verified === "boolean" ? t.tee_verified : null,
    latencyMs: res.latencyMs,
    payer: meta.payer,
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isRecord(entry.function)) continue;
    const fn = entry.function;
    if (typeof fn.name !== "string") continue;
    calls.push({
      id: typeof entry.id === "string" ? entry.id : "",
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return calls;
}
