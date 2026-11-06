import { describe, expect, test } from "bun:test";
import {
  RISK_LEVEL,
  RISK_REASON,
  applySimulation,
  assessRisk,
  declineBpsFromPercent,
  depegBps,
  dropBpsFromWindow,
  parseRiskScore,
  parseSimulate,
  type RiskSignals,
  type RiskThresholds,
} from "./risk.ts";

const T: RiskThresholds = {
  shortWindowCautionBps: 250,
  shortWindowHaltBps: 500,
  drop24hCautionBps: 500,
  drop24hHaltBps: 1000,
  depegHaltBps: 100,
  llmCautionScore: 0.8,
};

const calm: RiskSignals = { shortWindowDropBps: 0, drop24hBps: 0, usdcDeviationBps: 0, llmRiskScore: null };
const sig = (p: Partial<RiskSignals>): RiskSignals => ({ ...calm, ...p });

describe("dropBpsFromWindow", () => {
  test("5% drop from the window peak", () => {
    expect(dropBpsFromWindow(95n, [100n, 99n])).toBe(500);
  });
  test("no drop when latest is the peak", () => {
    expect(dropBpsFromWindow(100n, [99n, 98n])).toBe(0);
  });
  test("ignores unusable rounds and rejects non-positive latest", () => {
    expect(dropBpsFromWindow(90n, [0n, 100n])).toBe(1000);
    expect(() => dropBpsFromWindow(0n, [])).toThrow();
  });
});

describe("percent and depeg conversions", () => {
  test("24h decline in bps; gains are zero", () => {
    expect(declineBpsFromPercent(-7.3)).toBe(730);
    expect(declineBpsFromPercent(2.1)).toBe(0);
  });
  test("USDC deviation in bps", () => {
    expect(depegBps(0.98)).toBe(200);
    expect(depegBps(1.0)).toBe(0);
    expect(() => depegBps(0)).toThrow();
  });
});

describe("assessRisk thresholds", () => {
  test("calm market is NORMAL with reason None", () => {
    expect(assessRisk(calm, T)).toMatchObject({ level: RISK_LEVEL.NORMAL, reasonCode: RISK_REASON.None });
  });

  test("short-window: 249 bps NORMAL, 250 CAUTION, 499 CAUTION, 500 HALT", () => {
    expect(assessRisk(sig({ shortWindowDropBps: 249 }), T).level).toBe(RISK_LEVEL.NORMAL);
    expect(assessRisk(sig({ shortWindowDropBps: 250 }), T)).toMatchObject({
      level: RISK_LEVEL.CAUTION,
      reasonCode: RISK_REASON.Volatility,
    });
    expect(assessRisk(sig({ shortWindowDropBps: 499 }), T).level).toBe(RISK_LEVEL.CAUTION);
    expect(assessRisk(sig({ shortWindowDropBps: 500 }), T)).toMatchObject({
      level: RISK_LEVEL.HALT,
      reasonCode: RISK_REASON.PriceDrop,
    });
  });

  test("24h: 499 bps NORMAL, 500 CAUTION, 999 CAUTION, 1000 HALT", () => {
    expect(assessRisk(sig({ drop24hBps: 499 }), T).level).toBe(RISK_LEVEL.NORMAL);
    expect(assessRisk(sig({ drop24hBps: 500 }), T).level).toBe(RISK_LEVEL.CAUTION);
    expect(assessRisk(sig({ drop24hBps: 999 }), T).level).toBe(RISK_LEVEL.CAUTION);
    expect(assessRisk(sig({ drop24hBps: 1000 }), T)).toMatchObject({
      level: RISK_LEVEL.HALT,
      reasonCode: RISK_REASON.PriceDrop,
    });
  });

  test("depeg: exactly 1% is not HALT, above 1% is HALT with reason Depeg", () => {
    expect(assessRisk(sig({ usdcDeviationBps: 100 }), T).level).toBe(RISK_LEVEL.NORMAL);
    expect(assessRisk(sig({ usdcDeviationBps: 101 }), T)).toMatchObject({
      level: RISK_LEVEL.HALT,
      reasonCode: RISK_REASON.Depeg,
    });
  });

  test("LLM: 0.79 NORMAL, 0.8 CAUTION with reason News", () => {
    expect(assessRisk(sig({ llmRiskScore: 0.79 }), T).level).toBe(RISK_LEVEL.NORMAL);
    expect(assessRisk(sig({ llmRiskScore: 0.8 }), T)).toMatchObject({
      level: RISK_LEVEL.CAUTION,
      reasonCode: RISK_REASON.News,
    });
  });

  test("priority: depeg beats a price crash, which beats volatility and news", () => {
    expect(assessRisk(sig({ usdcDeviationBps: 500, shortWindowDropBps: 900 }), T).reasonCode).toBe(RISK_REASON.Depeg);
    expect(assessRisk(sig({ shortWindowDropBps: 900, llmRiskScore: 0.9 }), T).reasonCode).toBe(RISK_REASON.PriceDrop);
    expect(assessRisk(sig({ shortWindowDropBps: 300, llmRiskScore: 0.9 }), T).reasonCode).toBe(RISK_REASON.Volatility);
  });

  test("triggers list keeps every signal that fired", () => {
    const a = assessRisk(sig({ shortWindowDropBps: 900, llmRiskScore: 0.95 }), T);
    expect(a.triggers.length).toBe(2);
  });
});

describe("simulate override", () => {
  const live = assessRisk(calm, T);

  test("crash forces HALT with ManualSimulation", () => {
    expect(applySimulation(live, "crash")).toMatchObject({ level: RISK_LEVEL.HALT, reasonCode: RISK_REASON.ManualSimulation });
  });
  test("caution forces CAUTION with ManualSimulation", () => {
    expect(applySimulation(live, "caution")).toMatchObject({
      level: RISK_LEVEL.CAUTION,
      reasonCode: RISK_REASON.ManualSimulation,
    });
  });
  test("clear forces NORMAL even when the live market is in HALT", () => {
    const halted = assessRisk(sig({ shortWindowDropBps: 900 }), T);
    expect(applySimulation(halted, "clear")).toMatchObject({
      level: RISK_LEVEL.NORMAL,
      reasonCode: RISK_REASON.ManualSimulation,
    });
  });
  test("no simulate value leaves the live assessment untouched", () => {
    expect(applySimulation(live, undefined)).toBe(live);
  });
  test("the live triggers are kept in the log entry", () => {
    const halted = assessRisk(sig({ shortWindowDropBps: 900 }), T);
    expect(applySimulation(halted, "clear").triggers.some((t) => t.startsWith("price drop"))).toBe(true);
  });
});

describe("parseSimulate", () => {
  test("missing body or field means no override", () => {
    expect(parseSimulate(undefined)).toBeUndefined();
    expect(parseSimulate(null)).toBeUndefined();
    expect(parseSimulate({})).toBeUndefined();
  });
  test("accepts the three allowed values", () => {
    expect(parseSimulate({ simulate: "crash" })).toBe("crash");
    expect(parseSimulate({ simulate: "caution" })).toBe("caution");
    expect(parseSimulate({ simulate: "clear" })).toBe("clear");
  });
  test("rejects unknown values, arrays and strings", () => {
    expect(() => parseSimulate({ simulate: "boom" })).toThrow();
    expect(() => parseSimulate({ simulate: 1 })).toThrow();
    expect(() => parseSimulate([])).toThrow();
    expect(() => parseSimulate("crash")).toThrow();
  });
});

describe("parseRiskScore", () => {
  test("JSON reply", () => {
    expect(parseRiskScore('{"riskScore": 0.85}')).toBe(0.85);
  });
  test("JSON wrapped in prose or a code fence", () => {
    expect(parseRiskScore('```json\n{"riskScore": 0.9}\n```')).toBe(0.9);
  });
  test("bare key-value reply", () => {
    expect(parseRiskScore("riskScore: 0.3")).toBe(0.3);
  });
  test("out-of-range or missing scores return null", () => {
    expect(parseRiskScore('{"riskScore": 1.5}')).toBeNull();
    expect(parseRiskScore("no score here")).toBeNull();
  });
});
