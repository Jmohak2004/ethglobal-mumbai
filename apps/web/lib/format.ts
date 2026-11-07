// Display formatters. Everything time-based is UTC so server and client render identical text (no hydration drift).

const EXPLORER = process.env.NEXT_PUBLIC_BASE_EXPLORER || "https://basescan.org";
const ZG_EXPLORER = "https://chainscan.0g.ai";
const FLASH_ORDER_URL = "https://flash.definitive.fi/v1/orders/";

const usdOpts = (digits: number): Intl.NumberFormatOptions => ({
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});

/** $1,234.56 (negative as -$1.00). */
export function fmtUsd(n: number, digits = 2): string {
  const abs = Math.abs(n).toLocaleString("en-US", usdOpts(digits));
  return `${n < 0 ? "-" : ""}$${abs}`;
}

/** +$0.03 / -$0.10 / $0.00 */
export function fmtUsdSigned(n: number, digits = 2): string {
  const abs = Math.abs(n).toLocaleString("en-US", usdOpts(digits));
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${abs}`;
}

/** Signed dollars for PnL. Sub-cent amounts keep 4 decimals so a small open gain does not read as +$0.00. */
export function fmtPnlUsd(n: number): string {
  return fmtUsdSigned(n, n !== 0 && Math.abs(n) < 0.01 ? 4 : 2);
}

/** "realized +$0.00 · open +$0.12", the breakdown shown under a total PnL figure. */
export function fmtPnlBreakdown(s: { realizedPnlUsd: number; unrealizedPnlUsd: number }): string {
  return `realized ${fmtPnlUsd(s.realizedPnlUsd)} · open ${fmtPnlUsd(s.unrealizedPnlUsd)}`;
}

/** $1.2K / $3.40M for big volumes; small values fall back to fmtUsd. */
export function fmtCompactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmtUsd(n, 2);
}

/** Percent points, e.g. 4.8 -> "4.80%". */
export function fmtPct(n: number, digits = 2, signed = false): string {
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

/** Basis points as percent, e.g. 5800 -> "58.0%". */
export function fmtBps(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

export function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("en-US", usdOpts(digits));
}

/** Token amounts with trimmed trailing zeros but at least `minDigits`. */
export function fmtAmount(n: number, maxDigits = 6): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
}

export function shortAddr(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortHash(hash: string): string {
  return shortAddr(hash, 8, 6);
}

/** 14:03:22 (UTC) */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/** 2026-11-06 14:03 UTC */
export function fmtDateTime(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Jun 3 · used for "created" dates. */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "5m ago" (client-only usage, depends on the current clock). */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Tailwind colour class for a signed PnL value. */
export function pnlClass(n: number): string {
  if (n > 0) return "text-long";
  if (n < 0) return "text-short";
  return "text-muted";
}

export const txUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;
/** Live fills settle on Base mainnet (Flash), whatever NEXT_PUBLIC_BASE_EXPLORER says. */
export const liveTxUrl = (hash: string): string => `https://basescan.org/tx/${hash}`;
/** Paper fills are journaled on Base Sepolia (TradeJournal). */
export const journalTxUrl = (hash: string): string => `https://sepolia.basescan.org/tx/${hash}`;
export const addressUrl = (addr: string): string => `${EXPLORER}/address/${addr}`;
export const zgTxUrl = (hash: string): string => `${ZG_EXPLORER}/tx/${hash}`;
export const flashOrderUrl = (id: string): string => `${FLASH_ORDER_URL}${id}`;
/**
 * Definitive app, where Flash orders are cancelled. ARENA cannot build the signed cancel message yet
 * (the Flash client takes it as an opaque string), so the cancel action links out instead of faking success.
 */
export const DEFINITIVE_APP_URL = "https://flash.definitive.fi";
