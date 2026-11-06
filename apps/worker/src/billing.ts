// Normalizes 0G Router costs to 0G before they are stored, so budget tiers can sum them.
import { billingTo0G, type InferenceTrace } from "@arena/shared";
import { DEFAULT_ZG_PER_USDC } from "./paper.ts";

/** 0G per USD used to convert USD-mode billing. Same setting as the relayer and paper top-ups. */
export function zgPerUsd(): number {
  const v = Number(process.env.ZG_PER_USDC);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ZG_PER_USDC;
}

export function normalizeTrace(trace: InferenceTrace, rate = zgPerUsd()): InferenceTrace {
  if (trace.billingUnit === "0g") return trace;
  return { ...trace, billing: billingTo0G(trace.billing, trace.billingUnit, rate), billingUnit: "0g" };
}
