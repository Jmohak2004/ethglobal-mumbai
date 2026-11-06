export interface ZeroGApiErrorInit {
  status: number;
  code: string | null;
  message: string;
  requestId: string | null;
  retryAfterSec: number | null;
  body: unknown;
}

/** Any non-2xx response from the 0G Router. Never includes API keys. */
export class ZeroGApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryAfterSec: number | null;
  readonly body: unknown;

  constructor(init: ZeroGApiErrorInit) {
    super(`0G Router ${init.status}${init.code ? ` (${init.code})` : ""}: ${init.message}`);
    this.name = "ZeroGApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterSec = init.retryAfterSec;
    this.body = init.body;
  }
}

/**
 * 402 from the Router: the account (or per-agent key) cannot cover the request.
 * Runtime should switch the agent to the "critical" budget tier, not crash.
 */
export class InsufficientBalanceError extends ZeroGApiError {
  constructor(init: ZeroGApiErrorInit) {
    super(init);
    this.name = "InsufficientBalanceError";
  }
}

/** The model answered, but the answer could not be used even after a retry. */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}
