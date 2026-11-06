// Exact decimal arithmetic helpers. No floating point touches money or quantities.

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Converts a plain decimal string ("0.125") into integer base units with `decimals` places.
 * Extra fractional digits are truncated (floor). Throws on anything that is not a plain decimal
 * (signs, exponents, empty strings) so bad upstream data fails the run instead of being guessed.
 */
export function decimalToUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`not a plain decimal: "${value}"`);
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart + frac);
}

/** Converts a Chainlink answer (int256 with `feedDecimals` places) to USD with 6 decimals, floored. */
export function feedAnswerToUsd6(answer: bigint, feedDecimals: number): bigint {
  if (answer <= 0n) throw new Error(`non-positive feed answer: ${answer}`);
  if (feedDecimals >= 6) return answer / 10n ** BigInt(feedDecimals - 6);
  return answer * 10n ** BigInt(6 - feedDecimals);
}

/** Value in USD6 of `qtyUnits` base units of an asset with `decimals`, priced at `priceUsd6` per whole unit. */
export function valueUsd6(qtyUnits: bigint, decimals: number, priceUsd6: bigint): bigint {
  return (qtyUnits * priceUsd6) / 10n ** BigInt(decimals);
}
