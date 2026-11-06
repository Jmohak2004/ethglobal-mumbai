import { describe, expect, test } from "bun:test";
import { ZeroGAccount } from "./account.ts";
import { InsufficientBalanceError, ZeroGApiError } from "./errors.ts";
import { jsonResponse, scriptedFetch } from "./test-helpers.ts";

const BASE = "https://router.test/v1";
const MGMT = "mk-test-management";

describe("ZeroGAccount.createCappedKey", () => {
  test("posts the capped key body with the management key", async () => {
    const { fetch, calls } = scriptedFetch(() =>
      jsonResponse({
        key: "sk-live-secret",
        key_id: "key_123",
        name: "agent-ada",
        credit_limit: "1",
        reset_period: "daily",
        expires_at: "2027-01-01T00:00:00.000Z",
      }),
    );
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    const created = await account.createCappedKey({
      name: "agent-ada",
      creditLimit: 1,
      resetPeriod: "daily",
      allowedModels: ["glm-5.3-flash", "0gm-1.0-35b-a3b"],
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/api-keys`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Bearer ${MGMT}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({
      name: "agent-ada",
      credit_limit: "1",
      reset_period: "daily",
      allowed_models: ["glm-5.3-flash", "0gm-1.0-35b-a3b"],
      expiration: "2027-01-01T00:00:00.000Z",
    });
    expect(created).toMatchObject({ key: "sk-live-secret", keyId: "key_123", expiresAt: "2027-01-01T00:00:00.000Z" });
  });

  test("defaults expiration to no_expiration and omits allowed_models when not given", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ key: "sk-x", key_id: "k" }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await account.createCappedKey({ name: "a", creditLimit: "0.5", resetPeriod: "daily" });

    expect(calls[0]?.body).toEqual({
      name: "a",
      credit_limit: "0.5",
      reset_period: "daily",
      expiration: "no_expiration",
    });
  });

  test("passes an RFC3339 string expiry through unchanged", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ key: "sk-x", key_id: "k" }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await account.createCappedKey({
      name: "a",
      creditLimit: 2,
      resetPeriod: "daily",
      expiresAt: "2027-06-01T00:00:00Z",
    });

    expect(calls[0]?.body?.expiration).toBe("2027-06-01T00:00:00Z");
  });

  test("rejects non-positive credit limits before calling the API", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({}));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await expect(account.createCappedKey({ name: "a", creditLimit: 0, resetPeriod: "daily" })).rejects.toThrow(
      "creditLimit must be > 0",
    );
    expect(calls).toHaveLength(0);
  });

  test("errors when the response has no key", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ key_id: "k" }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await expect(account.createCappedKey({ name: "a", creditLimit: 1, resetPeriod: "daily" })).rejects.toThrow(
      "did not include a key",
    );
  });

  test("surfaces API errors as ZeroGApiError", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ error: { message: "Duplicate name", code: "duplicate_name" } }, 409),
    );
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    const err = (await account
      .createCappedKey({ name: "a", creditLimit: 1, resetPeriod: "daily" })
      .catch((e: unknown) => e)) as ZeroGApiError;

    expect(err).toBeInstanceOf(ZeroGApiError);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("duplicate_name");
  });
});

describe("ZeroGAccount reads and revocation", () => {
  test("getBalance maps the balance fields", async () => {
    const { fetch, calls } = scriptedFetch(() =>
      jsonResponse({
        address: "0xabc",
        total_balance: "2000",
        deposit_balance: "1500",
        credit_balance: "500",
        pending_charge: "10",
      }),
    );
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    const balance = await account.getBalance();

    expect(calls[0]?.url).toBe(`${BASE}/account/balance`);
    expect(calls[0]?.method).toBe("GET");
    expect(balance).toMatchObject({
      totalBalance: "2000",
      depositBalance: "1500",
      creditBalance: "500",
      pendingCharge: "10",
      unsettledCharge: null,
    });
  });

  test("usageHistory sends snake_case query parameters", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ data: [] }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await account.usageHistory({ limit: 50, apiKeyId: "key_123", startDate: "2026-11-01", endDate: "2026-11-06" });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/account/usage/history");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("api_key_id")).toBe("key_123");
    expect(url.searchParams.get("start_date")).toBe("2026-11-01");
    expect(url.searchParams.get("end_date")).toBe("2026-11-06");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  test("listKeys filters by status", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ object: "list", data: [] }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await account.listKeys("active");

    expect(new URL(calls[0]?.url ?? "").searchParams.get("status")).toBe("active");
  });

  test("revokeKey issues DELETE on the encoded key path", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse({ key_id: "key/1", message: "API key revoked" }));
    const account = new ZeroGAccount({ mgmtKey: MGMT, baseUrl: BASE, fetch });

    await account.revokeKey("key/1");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api-keys/key%2F1`);
  });
});
