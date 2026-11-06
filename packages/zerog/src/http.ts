import { InsufficientBalanceError, ZeroGApiError } from "./errors.ts";
import { isRecord } from "./util.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpContext {
  baseUrl: string;
  apiKey: string;
  fetch: FetchFn;
  headers?: Record<string, string>;
}

export interface HttpResult<T> {
  data: T;
  headers: Headers;
  status: number;
  latencyMs: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** JSON request helper shared by the inference router and the account API. */
export async function httpJson<T>(
  ctx: HttpContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { body?: unknown; query?: Query } = {},
): Promise<HttpResult<T>> {
  const url = new URL(ctx.baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.apiKey}`,
    ...ctx.headers,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const start = performance.now();
  const res = await ctx.fetch(url.toString(), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const latencyMs = Math.max(0, Math.round(performance.now() - start));

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) throw toApiError(res.status, parsed, text, res.headers);
  return { data: parsed as T, headers: res.headers, status: res.status, latencyMs };
}

function toApiError(status: number, body: unknown, rawText: string, headers: Headers): ZeroGApiError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const message =
    typeof err.message === "string" ? err.message : rawText.slice(0, 300) || `HTTP ${status}`;
  const code = typeof err.code === "string" ? err.code : typeof err.type === "string" ? err.type : null;
  const requestId =
    headers.get("x-request-id") ??
    (isRecord(body) && isRecord(body.x_0g_trace) && typeof body.x_0g_trace.request_id === "string"
      ? body.x_0g_trace.request_id
      : null);
  const retryAfter = Number(headers.get("retry-after"));
  const init = {
    status,
    code,
    message,
    requestId,
    retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    body,
  };
  return status === 402 ? new InsufficientBalanceError(init) : new ZeroGApiError(init);
}
