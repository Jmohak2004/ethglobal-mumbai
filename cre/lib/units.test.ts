import { describe, expect, test } from "bun:test";
import { decimalToUnits, feedAnswerToUsd6, valueUsd6 } from "./units.ts";

describe("decimalToUnits", () => {
  test("exact conversion at 18 and 6 decimals", () => {
    expect(decimalToUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(decimalToUnits("2", 6)).toBe(2_000_000n);
    expect(decimalToUnits("0.000001", 6)).toBe(1n);
  });
  test("extra fractional digits are truncated, not rounded", () => {
    expect(decimalToUnits("0.123456789", 6)).toBe(123_456n);
  });
  test("rejects signs, exponents, empty and non-numeric input", () => {
    expect(() => decimalToUnits("-1", 6)).toThrow();
    expect(() => decimalToUnits("1e3", 6)).toThrow();
    expect(() => decimalToUnits("", 6)).toThrow();
    expect(() => decimalToUnits("abc", 6)).toThrow();
  });
});

describe("feed and value helpers", () => {
  test("8-decimal feed answer to USD6", () => {
    // 3000.00 USD with 8 decimals
    expect(feedAnswerToUsd6(300_000_000_000n, 8)).toBe(3_000_000_000n);
  });
  test("rejects non-positive answers", () => {
    expect(() => feedAnswerToUsd6(0n, 8)).toThrow();
  });
  test("value of one whole WETH at 3000 USD", () => {
    expect(valueUsd6(10n ** 18n, 18, 3_000_000_000n)).toBe(3_000_000_000n);
  });
});
