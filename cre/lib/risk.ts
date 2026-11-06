// Crash-sentinel risk logic. Pure: no I/O, no clock, so the DON reaches the same level from the same inputs.

/** RiskOracle levels. */
export const RISK_LEVEL = { NORMAL: 0, CAUTION: 1, HALT: 2 } as const;
export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];

/** RiskOracle reason codes. */
export const RISK_REASON = {
  None: 0,
  PriceDrop: 1,
  Volatility: 2,
  Depeg: 3,
  News: 4,
  ManualSimulation: 5,
} as const;
export type RiskReason = (typeof RISK_REASON)[keyof typeof RISK_REASON];

export const SIMULATE_VALUES = ["crash", "caution", "clear"] as const;
export type SimulateValue = (typeof SIMULATE_VALUES)[number];

export interface RiskThresholds {
  /** Short-window drawdown (bps) from the recent Chainlink rounds. */
  shortWindowCautionBps: number; // 250 = 2.5%
  shortWindowHaltBps: number; // 500 = 5%
  /** 24h decline (bps) from CoinGecko. */
  drop24hCautionBps: number; // 500 = 5%
  drop24hHaltBps: number; // 1000 = 10%
  /** USDC deviation from $1 (bps). Strictly greater than this halts. */
  depegHaltBps: number; // 100 = 1%
  /** LLM risk score (0..1) at or above which the sentinel cautions. */
  llmCautionScore: number; // 0.8
}

export interface RiskSignals {
  /** Largest short-window drop across tracked feeds, bps, >= 0. */
  shortWindowDropBps: number;
  /** Largest 24h decline across tracked assets, bps, >= 0. */
  drop24hBps: number;
  /** |USDC price - 1| in bps, >= 0. */
  usdcDeviationBps: number;
  /** LLM risk score in [0,1], or null when the LLM is disabled or unavailable. */
  llmRiskScore: number | null;
}

export interface Assessment {
  level: RiskLevel;
  reasonCode: RiskReason;
  /** Human-readable trigger list for logs. */
  triggers: string[];
}

/**
 * Drop in bps from the peak of a window of prices (newest first, latest included or not).
 * drop = (max(window) - latest) / max(window). Returns 0 when latest is at or above the window max.
 */
export function dropBpsFromWindow(latest: bigint, window: readonly bigint[]): number {
  if (latest <= 0n) throw new Error("latest price must be positive");
  let max = latest;
  for (const p of window) {
    if (p <= 0n) continue; // ignore unusable rounds
    if (p > max) max = p;
  }
  if (max <= latest) return 0;
  return Number(((max - latest) * 10_000n) / max);
}

/** Converts a percentage change (e.g. -7.3 for -7.3%) into a non-negative decline in bps. */
export function declineBpsFromPercent(changePct: number): number {
  if (!Number.isFinite(changePct)) throw new Error(`non-finite percent change: ${changePct}`);
  if (changePct >= 0) return 0;
  return Math.round(-changePct * 100);
}

/** USDC deviation from $1 in bps, from a price in USD. */
export function depegBps(usdcPriceUsd: number): number {
  if (!Number.isFinite(usdcPriceUsd) || usdcPriceUsd <= 0) throw new Error(`invalid USDC price: ${usdcPriceUsd}`);
  return Math.round(Math.abs(usdcPriceUsd - 1) * 10_000);
}

/**
 * Maps signals to a level. Priority, highest first:
 *   1. Depeg (USDC off peg by more than depegHaltBps)               -> HALT, Depeg
 *   2. Crash (short-window or 24h drop at or above the halt level)  -> HALT, PriceDrop
 *   3. Volatility (drop at or above a caution level)                -> CAUTION, Volatility
 *   4. LLM score at or above llmCautionScore                         -> CAUTION, News
 * `triggers` lists every signal that fired, not only the one that set the level.
 */
export function assessRisk(signals: RiskSignals, t: RiskThresholds): Assessment {
  const triggers: string[] = [];
  if (signals.usdcDeviationBps > t.depegHaltBps) {
    triggers.push(`USDC off peg by ${signals.usdcDeviationBps} bps`);
  }
  const haltDrop = signals.shortWindowDropBps >= t.shortWindowHaltBps || signals.drop24hBps >= t.drop24hHaltBps;
  const cautionDrop =
    signals.shortWindowDropBps >= t.shortWindowCautionBps || signals.drop24hBps >= t.drop24hCautionBps;
  if (haltDrop) {
    triggers.push(`price drop short=${signals.shortWindowDropBps} bps 24h=${signals.drop24hBps} bps`);
  } else if (cautionDrop) {
    triggers.push(`volatility short=${signals.shortWindowDropBps} bps 24h=${signals.drop24hBps} bps`);
  }
  if (signals.llmRiskScore !== null && signals.llmRiskScore >= t.llmCautionScore) {
    triggers.push(`LLM risk score ${signals.llmRiskScore}`);
  }

  if (signals.usdcDeviationBps > t.depegHaltBps) {
    return { level: RISK_LEVEL.HALT, reasonCode: RISK_REASON.Depeg, triggers };
  }
  if (haltDrop) return { level: RISK_LEVEL.HALT, reasonCode: RISK_REASON.PriceDrop, triggers };
  if (cautionDrop) return { level: RISK_LEVEL.CAUTION, reasonCode: RISK_REASON.Volatility, triggers };
  if (signals.llmRiskScore !== null && signals.llmRiskScore >= t.llmCautionScore) {
    return { level: RISK_LEVEL.CAUTION, reasonCode: RISK_REASON.News, triggers };
  }
  return { level: RISK_LEVEL.NORMAL, reasonCode: RISK_REASON.None, triggers };
}

/**
 * Manual override from the HTTP trigger payload `{ "simulate": "crash" | "caution" | "clear" }`.
 * The override replaces the level and sets reasonCode to ManualSimulation. The live triggers are kept
 * in the log so the run still shows what the real market looked like.
 * `undefined` means no override.
 */
export function applySimulation(a: Assessment, simulate: SimulateValue | undefined): Assessment {
  if (simulate === undefined) return a;
  const level: RiskLevel =
    simulate === "crash" ? RISK_LEVEL.HALT : simulate === "caution" ? RISK_LEVEL.CAUTION : RISK_LEVEL.NORMAL;
  return {
    level,
    reasonCode: RISK_REASON.ManualSimulation,
    triggers: [...a.triggers, `simulated=${simulate}`],
  };
}

/**
 * Reads the optional `simulate` field of an HTTP trigger body.
 * Missing or empty body -> undefined. Any other value that is not one of the allowed strings throws.
 */
export function parseSimulate(body: unknown): SimulateValue | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) throw new Error("HTTP payload must be a JSON object");
  const value = (body as Record<string, unknown>).simulate;
  if (value === undefined) return undefined;
  if (typeof value === "string" && (SIMULATE_VALUES as readonly string[]).includes(value)) {
    return value as SimulateValue;
  }
  throw new Error(`invalid simulate value: ${JSON.stringify(value)} (allowed: ${SIMULATE_VALUES.join(", ")})`);
}

/**
 * Extracts a risk score in [0,1] from an LLM reply. Accepts a JSON object with "riskScore",
 * or a bare `riskScore: 0.7` style line. Returns null when nothing valid is found.
 */
export function parseRiskScore(text: string): number | null {
  const candidates: string[] = [];
  const jsonMatch = text.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if (typeof parsed.riskScore === "number") candidates.push(String(parsed.riskScore));
      if (typeof parsed.riskScore === "string") candidates.push(parsed.riskScore);
    } catch {
      // fall through to the regex
    }
  }
  const lineMatch = text.match(/riskScore"?\s*[:=]\s*"?(\d*\.?\d+)"?/i);
  if (lineMatch?.[1]) candidates.push(lineMatch[1]);

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return null;
}
