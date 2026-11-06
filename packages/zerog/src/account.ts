import { ZG_ROUTER_URL } from "@arena/shared";
import { type FetchFn, httpJson } from "./http.ts";
import { isRecord } from "./util.ts";

export type ResetPeriod = "never" | "daily" | "weekly" | "monthly";
export type KeyStatus = "active" | "revoked" | "expired" | "all";

export interface ZeroGAccountOptions {
  /** `mk-…` management key (scopes: account:read, keys:read, keys:create, keys:manage as needed). */
  mgmtKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

export interface CreateCappedKeyInput {
  name: string;
  /** Credit cap in 0G units. Sent as a string (`credit_limit`). */
  creditLimit: number | string;
  resetPeriod: ResetPeriod;
  allowedModels?: string[];
  /** Defaults to `"no_expiration"`. */
  expiresAt?: Date | string;
}

export interface CreatedKey {
  /** The `sk-…` secret. Returned once by the Router; store it encrypted. */
  key: string;
  keyId: string;
  expiresAt: string | null;
  raw: unknown;
}

export interface AccountBalance {
  /** "usd" for USD-mode accounts (balances in micro-USD); otherwise balances are in neuron (1e-18 0G). */
  currency: string | null;
  totalBalance: string | null;
  depositBalance: string | null;
  creditBalance: string | null;
  pendingCharge: string | null;
  unsettledCharge: string | null;
  raw: unknown;
}

export interface UsageQuery {
  limit?: number;
  offset?: number;
  modelId?: string;
  apiKeyId?: string;
  startDate?: string;
  endDate?: string;
}

/** Management API: creates capped per-agent `sk-` keys and reads balances and usage. */
export class ZeroGAccount {
  private readonly http: { baseUrl: string; apiKey: string; fetch: FetchFn };

  constructor(opts: ZeroGAccountOptions) {
    if (!opts.mgmtKey) throw new Error("ZeroGAccount: mgmtKey is required");
    this.http = {
      baseUrl: (opts.baseUrl ?? ZG_ROUTER_URL.mainnet).replace(/\/+$/, ""),
      apiKey: opts.mgmtKey,
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    };
  }

  async createCappedKey(input: CreateCappedKeyInput): Promise<CreatedKey> {
    if (Number(input.creditLimit) <= 0) throw new RangeError("createCappedKey: creditLimit must be > 0");
    const expiration =
      input.expiresAt === undefined
        ? "no_expiration"
        : input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : input.expiresAt;

    const body: Record<string, unknown> = {
      name: input.name,
      credit_limit: String(input.creditLimit),
      reset_period: input.resetPeriod,
      expiration,
    };
    if (input.allowedModels) body.allowed_models = input.allowedModels;

    const res = await httpJson<unknown>(this.http, "POST", "/api-keys", { body });
    const data = isRecord(res.data) ? res.data : {};
    if (typeof data.key !== "string") throw new Error("createCappedKey: response did not include a key");
    return {
      key: data.key,
      keyId: typeof data.key_id === "string" ? data.key_id : "",
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
      raw: res.data,
    };
  }

  async getBalance(): Promise<AccountBalance> {
    const res = await httpJson<unknown>(this.http, "GET", "/account/balance");
    const data = isRecord(res.data) ? res.data : {};
    const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
    return {
      currency: typeof data.currency === "string" ? data.currency : null,
      totalBalance: str(data.total_balance),
      depositBalance: str(data.deposit_balance),
      creditBalance: str(data.credit_balance),
      pendingCharge: str(data.pending_charge),
      unsettledCharge: str(data.unsettled_charge),
      raw: res.data,
    };
  }

  async usageHistory(query: UsageQuery = {}): Promise<unknown> {
    const res = await httpJson<unknown>(this.http, "GET", "/account/usage/history", {
      query: {
        limit: query.limit,
        offset: query.offset,
        model_id: query.modelId,
        api_key_id: query.apiKeyId,
        start_date: query.startDate,
        end_date: query.endDate,
      },
    });
    return res.data;
  }

  async listKeys(status: KeyStatus = "all"): Promise<unknown> {
    const res = await httpJson<unknown>(this.http, "GET", "/api-keys", { query: { status } });
    return res.data;
  }

  async revokeKey(keyId: string): Promise<unknown> {
    const res = await httpJson<unknown>(this.http, "DELETE", `/api-keys/${encodeURIComponent(keyId)}`);
    return res.data;
  }
}
