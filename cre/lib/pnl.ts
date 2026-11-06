// Deterministic per-agent performance from filled trades. Pure: no I/O, no clock, no randomness,
// so every CRE node computes the same result from the same fills (required for consensus).
//
// Conventions
// - Money is USD with 6 decimals (bigint). Quantities are base units of the traded asset (bigint).
// - Accounting is FIFO per asset. Each buy opens a lot with cost = notional + fee.
//   Each sell closes lots oldest-first with proceeds = notional - fee.
// - A sell larger than the open lots (position opened before the window) realizes zero PnL on the
//   unmatched part and is reported in `unmatchedSellQtyUnits`. This is conservative: it never invents profit.
// - Realized PnL is cumulative across assets. High-water mark (HWM) = max(0, peak of cumulative realized PnL).
//   It starts at 0 and never decreases.

export interface Fill {
  /** Root order id. Used to count distinct trades. */
  orderId: string;
  /** ISO-8601 fill time. Only used for ordering (string compare on identical formats). */
  filledAt: string;
  side: "buy" | "sell";
  /** Traded asset ticker, e.g. "WETH". */
  asset: string;
  /** Quantity in base units of `asset`. Must be > 0. */
  qtyUnits: bigint;
  /** USD value of the fill, 6 decimals. */
  notionalUsd6: bigint;
  /** Total fees of the fill in USD, 6 decimals. */
  feeUsd6: bigint;
}

export interface Mark {
  /** Price of one whole unit of the asset, USD with 6 decimals. */
  priceUsd6: bigint;
  decimals: number;
}

export interface MetricsOptions {
  /** Mark prices by asset ticker. Assets without a mark are left out of unrealized PnL. */
  marks?: Readonly<Record<string, Mark>>;
  /** Forecast hit rate in bps, provided by the caller. 0 when not provided. */
  forecastHitRateBps?: number;
}

export interface PnlMetrics {
  realizedPnlUsd6: bigint;
  unrealizedPnlUsd6: bigint;
  volumeUsd6: bigint;
  /** Distinct filled orders. */
  trades: number;
  /** Sell fills that closed at least one lot. */
  closedTrades: number;
  winningTrades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  maxDrawdownUsd6: bigint;
  hwmUsd6: bigint;
  forecastHitRateBps: number;
  openQtyUnits: Record<string, bigint>;
  unmatchedSellQtyUnits: Record<string, bigint>;
}

const BPS = 10_000n;

/** Deterministic chronological order. Ties break on orderId, then side. */
export function compareFills(a: Fill, b: Fill): number {
  if (a.filledAt !== b.filledAt) return a.filledAt < b.filledAt ? -1 : 1;
  if (a.orderId !== b.orderId) return a.orderId < b.orderId ? -1 : 1;
  if (a.side !== b.side) return a.side < b.side ? -1 : 1;
  return 0;
}

interface Lot {
  qtyUnits: bigint;
  costUsd6: bigint;
}

function assertValid(f: Fill): void {
  if (f.qtyUnits <= 0n) throw new Error(`fill ${f.orderId} has non-positive qty`);
  if (f.notionalUsd6 < 0n || f.feeUsd6 < 0n) throw new Error(`fill ${f.orderId} has negative notional or fee`);
  if (f.side !== "buy" && f.side !== "sell") throw new Error(`fill ${f.orderId} has unknown side`);
}

/** Basis points of part/whole, capped at 10_000. A drawdown with no profit peak to measure against counts as 100%. */
function ratioBps(part: bigint, whole: bigint): bigint {
  if (part <= 0n) return 0n;
  if (whole <= 0n) return BPS;
  const r = (part * BPS) / whole;
  return r > BPS ? BPS : r;
}

export function computeAgentMetrics(fills: readonly Fill[], opts: MetricsOptions = {}): PnlMetrics {
  const sorted = [...fills].sort(compareFills);
  for (const f of sorted) assertValid(f);

  const lots = new Map<string, Lot[]>();
  const openQty = new Map<string, bigint>();
  const unmatched = new Map<string, bigint>();

  let realized = 0n;
  let volume = 0n;
  let closedTrades = 0;
  let winningTrades = 0;
  let hwm = 0n; // max(0, peak cumulative realized)
  let maxDdUsd6 = 0n;
  let maxDdBps = 0n;
  const orderIds = new Set<string>();

  for (const f of sorted) {
    orderIds.add(f.orderId);
    volume += f.notionalUsd6;
    const assetLots = lots.get(f.asset) ?? [];
    lots.set(f.asset, assetLots);

    if (f.side === "buy") {
      // A buy opens a lot. It cannot change realized PnL, so the HWM and drawdown are unchanged.
      assetLots.push({ qtyUnits: f.qtyUnits, costUsd6: f.notionalUsd6 + f.feeUsd6 });
      openQty.set(f.asset, (openQty.get(f.asset) ?? 0n) + f.qtyUnits);
      continue;
    }

    let remaining = f.qtyUnits;
    let matchedQty = 0n;
    let matchedCost = 0n;
    while (remaining > 0n && assetLots.length > 0) {
      const lot = assetLots[0]!;
      const take = lot.qtyUnits < remaining ? lot.qtyUnits : remaining;
      const costPart = take === lot.qtyUnits ? lot.costUsd6 : (lot.costUsd6 * take) / lot.qtyUnits;
      matchedCost += costPart;
      matchedQty += take;
      lot.qtyUnits -= take;
      lot.costUsd6 -= costPart;
      remaining -= take;
      if (lot.qtyUnits === 0n) assetLots.shift();
    }
    if (remaining > 0n) unmatched.set(f.asset, (unmatched.get(f.asset) ?? 0n) + remaining);
    openQty.set(f.asset, (openQty.get(f.asset) ?? 0n) - matchedQty);

    if (matchedQty > 0n) {
      const proceeds = f.notionalUsd6 - f.feeUsd6;
      const proceedsMatched = (proceeds * matchedQty) / f.qtyUnits;
      const pnl = proceedsMatched - matchedCost;
      realized += pnl;
      closedTrades += 1;
      if (pnl > 0n) winningTrades += 1;
    }

    // Drawdown is tracked on the cumulative realized curve. The peak includes the initial 0.
    if (realized > hwm) hwm = realized;
    const dd = hwm - realized;
    if (dd > maxDdUsd6) maxDdUsd6 = dd;
    const ddBps = ratioBps(dd, hwm);
    if (ddBps > maxDdBps) maxDdBps = ddBps;
  }

  let unrealized = 0n;
  for (const [asset, assetLots] of lots) {
    const mark = opts.marks?.[asset];
    if (!mark) continue;
    for (const lot of assetLots) {
      unrealized += (lot.qtyUnits * mark.priceUsd6) / 10n ** BigInt(mark.decimals) - lot.costUsd6;
    }
  }

  const winRateBps = closedTrades === 0 ? 0 : Number((BigInt(winningTrades) * BPS) / BigInt(closedTrades));

  return {
    realizedPnlUsd6: realized,
    unrealizedPnlUsd6: unrealized,
    volumeUsd6: volume,
    trades: orderIds.size,
    closedTrades,
    winningTrades,
    winRateBps,
    maxDrawdownBps: Number(maxDdBps),
    maxDrawdownUsd6: maxDdUsd6,
    hwmUsd6: hwm,
    forecastHitRateBps: opts.forecastHitRateBps ?? 0,
    openQtyUnits: Object.fromEntries([...openQty.entries()].filter(([, q]) => q !== 0n)),
    unmatchedSellQtyUnits: Object.fromEntries(unmatched),
  };
}
