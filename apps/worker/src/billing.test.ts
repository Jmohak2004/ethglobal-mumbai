import { describe, expect, test } from "bun:test";
import { normalizeTrace } from "./billing.ts";

const trace = (billing: string | null, billingUnit?: "usd_micro" | "neuron" | "0g" | null) => ({
  requestId: "r",
  model: "m",
  provider: null,
  billing,
  billingUnit,
  teeVerified: null,
  latencyMs: 1,
  payer: "agent" as const,
});

describe("normalizeTrace", () => {
  test("micro-USD converts to 0G at the given rate", () => {
    expect(Number(normalizeTrace(trace("8130", "usd_micro"), 6).billing)).toBeCloseTo(0.04878, 8);
  });
  test("neuron converts to 0G", () => {
    expect(Number(normalizeTrace(trace("1935800000000000", "neuron"), 6).billing)).toBeCloseTo(0.0019358, 10);
  });
  test("unknown units pass through and are marked normalized", () => {
    const t = normalizeTrace(trace("0.01", null), 6);
    expect(t.billing).toBe("0.01");
    expect(t.billingUnit).toBe("0g");
  });
});
