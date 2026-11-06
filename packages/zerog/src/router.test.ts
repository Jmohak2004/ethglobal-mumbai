import { describe, expect, test } from "bun:test";
import { InsufficientBalanceError, ZeroGApiError } from "./errors.ts";
import { ZeroGRouter } from "./router.ts";
import { chatCompletion, jsonResponse, scriptedFetch } from "./test-helpers.ts";

const BASE = "https://router.test/v1";
const KEY = "sk-test-secret-123";

describe("ZeroGRouter.chat", () => {
  test("posts to /chat/completions with auth, trust mode, verify_tee and JSON mode", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse(chatCompletion('{"ok":true}')));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    await router.chat({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      json: true,
      temperature: 0.1,
      maxTokens: 50,
    });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/chat/completions`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers["x-0g-provider-trust-mode"]).toBe("verified");
    expect(call?.body?.verify_tee).toBe(true);
    expect(call?.body?.response_format).toEqual({ type: "json_object" });
    expect(call?.body?.max_tokens).toBe(50);
    expect(call?.body?.temperature).toBe(0.1);
    expect(call?.body).not.toHaveProperty("tools");
  });

  test("extracts content and a full trace from x_0g_trace", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse(
        chatCompletion(
          '{"ok":true}',
          {
            request_id: "req-42",
            provider: "0xabc",
            billing: { input_cost: "19", output_cost: "30", total_cost: "49" },
            tee_verified: true,
          },
          {},
        ),
      ),
    );
    const router = new ZeroGRouter({ apiKey: KEY, payer: "user", baseUrl: BASE, fetch });

    const res = await router.chat({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] });

    expect(res.content).toBe('{"ok":true}');
    expect(res.trace).toMatchObject({
      requestId: "req-42",
      model: "glm-5.3",
      provider: "0xabc",
      billing: "49",
      teeVerified: true,
      payer: "user",
    });
    expect(res.trace.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("trace uses null for missing tee_verified and accepts a string billing value", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse(chatCompletion("x", { request_id: "req-7", billing: "1234", tee_verified: undefined })),
    );
    const router = new ZeroGRouter({ apiKey: KEY, payer: "platform", baseUrl: BASE, fetch });

    const res = await router.chat({ model: "m", messages: [] });

    expect(res.trace.billing).toBe("1234");
    expect(res.trace.teeVerified).toBeNull();
    expect(res.trace.payer).toBe("platform");
  });

  test("falls back to the x-request-id header when the trace has no request_id", async () => {
    const body = chatCompletion("x");
    delete (body as { x_0g_trace?: unknown }).x_0g_trace;
    const { fetch } = scriptedFetch(() => jsonResponse(body, 200, { "x-request-id": "hdr-9" }));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    const res = await router.chat({ model: "m", messages: [] });

    expect(res.trace.requestId).toBe("hdr-9");
    expect(res.trace.billing).toBeNull();
    expect(res.trace.provider).toBeNull();
  });

  test("honours trustMode and verifyTee overrides", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse(chatCompletion("x")));
    const router = new ZeroGRouter({
      apiKey: KEY,
      payer: "agent",
      baseUrl: BASE,
      trustMode: "private",
      verifyTee: false,
      fetch,
    });

    await router.chat({ model: "m", messages: [] });

    expect(calls[0]?.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(calls[0]?.body).not.toHaveProperty("verify_tee");
  });

  test("passes Router built-in tools through unchanged", async () => {
    const { fetch, calls } = scriptedFetch(() => jsonResponse(chatCompletion("x")));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });
    const tools = [{ type: "0g:web_search" as const, max_uses: 2 }];

    await router.chat({ model: "glm-5.3-flash", messages: [], tools });

    expect(calls[0]?.body?.tools).toEqual(tools);
  });

  test("parses tool calls", async () => {
    const body = chatCompletion("");
    (body.choices as Array<{ message: Record<string, unknown> }>)[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_price", arguments: '{"asset":"WETH"}' } }],
    };
    const { fetch } = scriptedFetch(() => jsonResponse(body));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    const res = await router.chat({ model: "m", messages: [] });

    expect(res.content).toBe("");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "get_price", arguments: '{"asset":"WETH"}' }]);
  });

  test("maps HTTP 402 to InsufficientBalanceError without leaking the key", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ error: { message: "Insufficient balance", code: "insufficient_balance" } }, 402),
    );
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    const err = await router.chat({ model: "m", messages: [] }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err).toBeInstanceOf(ZeroGApiError);
    const apiErr = err as ZeroGApiError;
    expect(apiErr.status).toBe(402);
    expect(apiErr.code).toBe("insufficient_balance");
    expect(apiErr.message).toContain("Insufficient balance");
    expect(apiErr.message).not.toContain(KEY);
  });

  test("maps other HTTP errors to ZeroGApiError and keeps retry-after", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ error: { message: "try later", code: "pay_gate_unavailable" } }, 503, { "retry-after": "7" }),
    );
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    const err = (await router.chat({ model: "m", messages: [] }).catch((e: unknown) => e)) as ZeroGApiError;

    expect(err).toBeInstanceOf(ZeroGApiError);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("pay_gate_unavailable");
    expect(err.retryAfterSec).toBe(7);
  });

  test("handles non-JSON error bodies", async () => {
    const { fetch } = scriptedFetch(() => new Response("upstream exploded", { status: 500 }));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    const err = (await router.chat({ model: "m", messages: [] }).catch((e: unknown) => e)) as ZeroGApiError;

    expect(err).toBeInstanceOf(ZeroGApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("upstream exploded");
  });

  test("requires an apiKey", () => {
    expect(() => new ZeroGRouter({ apiKey: "", payer: "agent" })).toThrow("apiKey is required");
  });
});

describe("ZeroGRouter.image", () => {
  test("posts a b64 image request and returns the image with its trace", async () => {
    const { fetch, calls } = scriptedFetch(() =>
      jsonResponse({
        data: [{ b64_json: "aGVsbG8=" }],
        x_0g_trace: { request_id: "img-1", billing: { total_cost: "5" } },
      }),
    );
    const router = new ZeroGRouter({ apiKey: KEY, payer: "user", baseUrl: BASE, fetch });

    const res = await router.image({ model: "z-image-turbo", prompt: "card", size: "1024x1024" });

    expect(calls[0]?.url).toBe(`${BASE}/images/generations`);
    expect(calls[0]?.body).toEqual({
      model: "z-image-turbo",
      prompt: "card",
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    });
    expect(res.b64OrUrl).toBe("aGVsbG8=");
    expect(res.trace.requestId).toBe("img-1");
    expect(res.trace.billing).toBe("5");
    expect(res.trace.payer).toBe("user");
  });

  test("throws when the response has no image", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ data: [] }));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "agent", baseUrl: BASE, fetch });

    await expect(router.image({ model: "z-image-turbo", prompt: "p", size: "1024x1024" })).rejects.toThrow(
      "no image data",
    );
  });

  test("maps 402 on image calls to InsufficientBalanceError", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ error: { message: "no funds" } }, 402));
    const router = new ZeroGRouter({ apiKey: KEY, payer: "user", baseUrl: BASE, fetch });

    await expect(router.image({ model: "z-image-turbo", prompt: "p", size: "1024x1024" })).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });
});

describe("trust mode fallback", () => {
  test("retries in standard mode when no provider serves the requested trust mode", async () => {
    const calls: { mode: string | null; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ mode: headers.get("X-0G-Provider-Trust-Mode"), body });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { code: "no_provider_for_trust_mode", message: "no provider" } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], x_0g_trace: { request_id: "req-1", tee_verified: true } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const router = new ZeroGRouter({ apiKey: "sk-test", payer: "agent", fetch: fetchFn });
    const out = await router.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(calls.map((c) => c.mode)).toEqual(["verified", "standard"]);
    expect(calls[1]?.body.verify_tee).toBeUndefined();
    expect(out.trace.requestId).toBe("req-1");
    expect(out.trace.teeVerified).toBe(false);
  });
});

describe("billing units", () => {
  const run = async (billing: unknown) => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], x_0g_trace: { request_id: "r", billing } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const router = new ZeroGRouter({ apiKey: "sk-test", payer: "agent", fetch: fetchFn });
    return (await router.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).trace;
  };
  test("USD-mode accounts report micro-USD", async () => {
    const t = await run({ currency: "usd", total_cost: "8130", total_cost_usd_micro: "8130" });
    expect(t.billing).toBe("8130");
    expect(t.billingUnit).toBe("usd_micro");
  });
  test("0G-mode accounts report neuron", async () => {
    const t = await run({ total_cost: "1935800000000000" });
    expect(t.billing).toBe("1935800000000000");
    expect(t.billingUnit).toBe("neuron");
  });
});
