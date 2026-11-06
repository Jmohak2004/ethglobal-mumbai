// Typed JSON errors for route handlers: { error: { code, message, details? } }.
import { NextResponse } from "next/server";

import type { ApiErrorBody, ApiErrorCode } from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: string[];

  constructor(status: number, code: ApiErrorCode, message: string, details?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(status: number, code: ApiErrorCode, message: string, details?: string[]): NextResponse {
  const body: ApiErrorBody = { error: { code, message, ...(details?.length ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

/** Maps any thrown value to a typed response. Unknown errors never leak their message. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message, err.details);
  console.error("[arena] unhandled route error:", err);
  return errorResponse(500, "INTERNAL", "Unexpected server error");
}

/** Wraps a route handler so thrown errors become typed JSON responses. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/** Parses a JSON body, or throws a typed 400. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Request body must be JSON");
  }
}
