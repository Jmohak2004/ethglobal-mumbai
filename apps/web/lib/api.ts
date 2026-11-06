// Client-side fetch helpers for the /api/* route handlers. Client-safe.
// Errors are typed: the thrown ApiClientError carries the server's code, status and details.
import type { ApiErrorBody, ApiErrorCode } from "@/lib/types";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | "NETWORK";
  readonly details: string[];

  constructor(status: number, code: ApiErrorCode | "NETWORK", message: string, details: string[] = []) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "INTERNAL",
      err?.message ?? `Request failed (${res.status})`,
      err?.details ?? [],
    );
  }
  return data as T;
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiClientError(0, "NETWORK", "Network error. Check your connection and retry.");
  }
  return parse<T>(res);
}

export function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return send<T>(url, { headers: { accept: "application/json", ...headers } });
}

export function postJson<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  return send<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Error text for toasts. */
export function describeError(err: unknown): string {
  if (err instanceof ApiClientError) return err.details.length ? `${err.message}: ${err.details.join("; ")}` : err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
