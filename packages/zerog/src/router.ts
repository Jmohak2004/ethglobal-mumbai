import { ZG_ROUTER_URL, type InferenceTrace } from "@arena/shared";
import { type FetchFn, type HttpContext, type HttpResult, httpJson } from "./http.ts";
import { isRecord } from "./util.ts";
import { ZeroGApiError } from "./errors.ts";

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
  /**
   * false sends `enable_thinking: false`, which turns off hidden reasoning on models that support it (qwen, glm).
   * Models that ignore it (e.g. 0gm-1.0) still reason, so callers also leave generous maxTokens.
   */
  thinking?: boolean;
  /**
   * Router plugins, e.g. [{ id: "web" }]: the Router runs one web search per request and gives the results to
   * the model. Works with any chat model, unlike the 0g:web_search tool, which needs tool-calling support.
   */
  plugins?: { id: string }[];
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
  /** Same context with trust mode "standard", used when no provider serves the requested trust mode. */
  private readonly httpStandard: HttpContext;

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
    this.httpStandard = { ...this.http, headers: { "X-0G-Provider-Trust-Mode": "standard" } };
  }

  /**
   * POSTs with the configured trust mode. If the Router has no provider for that trust mode for this model
   * (503 no_provider_for_trust_mode), retries once in "standard" mode without verify_tee. The trace then
   * reports teeVerified=false, so a decision is never shown as TEE-verified when it wasn't.
   */
  private async post(path: string, body: Record<string, unknown>): Promise<{ res: HttpResult<unknown>; fellBack: boolean }> {
    // Plugins inject into the prompt, which the Router cannot do for end-to-end-encrypted (verified/private)
    // requests, so plugin requests go straight to standard mode.
    if (body.plugins !== undefined && this.trustMode !== "standard") {
      const { verify_tee: _drop, ...rest } = body;
      return { res: await httpJson<unknown>(this.httpStandard, "POST", path, { body: rest }), fellBack: true };
    }
    try {
      return { res: await httpJson<unknown>(this.http, "POST", path, { body }), fellBack: false };
    } catch (err) {
      if (!(err instanceof ZeroGApiError) || err.code !== "no_provider_for_trust_mode" || this.trustMode === "standard") {
        throw err;
      }
      const { verify_tee: _drop, ...rest } = body;
      return { res: await httpJson<unknown>(this.httpStandard, "POST", path, { body: rest }), fellBack: true };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages };
    if (this.verifyTee) body.verify_tee = true;
    if (req.json) body.response_format = { type: "json_object" };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.thinking === false) body.enable_thinking = false;
    if (req.plugins && req.plugins.length > 0) body.plugins = req.plugins;

    const { res, fellBack } = await this.post("/chat/completions", body);
    const data = asCompletion(res.data);
    const message = data.choices?.[0]?.message;
    return {
      content: typeof message?.content === "string" ? message.content : "",
      toolCalls: parseToolCalls(message?.tool_calls),
      raw: data,
      trace: withFallback(buildTrace(res, { model: req.model, payer: this.payer }), fellBack),
    };
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const { res, fellBack } = await this.post("/images/generations", {
      model: req.model,
      prompt: req.prompt,
      size: req.size,
      n: 1,
      response_format: "b64_json",
    });
    const items: unknown[] = isRecord(res.data) && Array.isArray(res.data.data) ? res.data.data : [];
    const first = items[0];
    const item = isRecord(first) ? first : {};
    const b64OrUrl =
      typeof item.b64_json === "string" ? item.b64_json : typeof item.url === "string" ? item.url : null;
    if (!b64OrUrl) throw new Error(`0G Router image response had no image data (model ${req.model})`);
    return { b64OrUrl, trace: withFallback(buildTrace(res, { model: req.model, payer: this.payer }), fellBack) };
  }
}

function withFallback(trace: InferenceTrace, fellBack: boolean): InferenceTrace {
  return fellBack ? { ...trace, teeVerified: false } : trace;
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
  let billing: string | null = null;
  let billingUnit: InferenceTrace["billingUnit"] = null;
  if (typeof t.billing === "string") {
    // Plain-string billing carries no unit; leave it as reported.
    billing = t.billing;
  } else if (isRecord(t.billing)) {
    const b = t.billing;
    if (b.currency === "usd") {
      const micro = typeof b.total_cost_usd_micro === "string" ? b.total_cost_usd_micro : b.total_cost;
      billing = typeof micro === "string" ? micro : null;
      billingUnit = "usd_micro";
    } else if (typeof b.total_cost === "string") {
      billing = b.total_cost;
      billingUnit = "neuron";
    }
  }
  const requestId =
    typeof t.request_id === "string" ? t.request_id : (res.headers.get("x-request-id") ?? (typeof data.id === "string" ? data.id : ""));
  return {
    requestId,
    model: meta.model,
    provider: typeof t.provider === "string" ? t.provider : null,
    billing,
    billingUnit,
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
