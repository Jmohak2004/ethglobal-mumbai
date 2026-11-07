// Price formatting that works from $75,000.00 down to $0.00000123. Decimals follow significant digits, with at
// least 2 decimals for large prices, so the displayed precision tracks the magnitude of the price.

const SIG_DIGITS = 5;
const MIN_DECIMALS = 2;
const MAX_DECIMALS = 10;

/** Decimals needed to show `SIG_DIGITS` significant digits, clamped to [2, 10]. */
export function priceDecimals(n: number): number {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs) || abs === 0) return MIN_DECIMALS;
  const magnitude = Math.floor(Math.log10(abs));
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, SIG_DIGITS - 1 - magnitude));
}

const formatters = new Map<number, Intl.NumberFormat>();

function formatterFor(decimals: number): Intl.NumberFormat {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: Math.min(MIN_DECIMALS, decimals),
      maximumFractionDigits: decimals,
    });
    formatters.set(decimals, f);
  }
  return f;
}

/** 75123.456 -> "75,123.46", 3456.78 -> "3,456.78", 14.5234 -> "14.5234", 0.0008 -> "0.0008". No currency symbol. */
export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return formatterFor(priceDecimals(n)).format(n);
}

/** "$" + formatPrice, with a leading minus for negatives. */
export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${formatPrice(Math.abs(n))}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** Volumes in base units: 1234567 -> "1.23M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return compact.format(n);
}
