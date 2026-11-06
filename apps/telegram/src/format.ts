// Pure HTML builders for Telegram (parse_mode HTML). No database access here.
//
// Stats-only rule (PRD 6.1): every builder used for public chats emits stats and market view only.
// Order, fill, price, size and guardrail detail lives in the owner alert builders at the bottom.
// All user-controlled text goes through esc().

import { RiskReason, type Forecast, type PerformanceStats, type RiskLevel } from "@arena/shared";

export interface ExplorerLinks {
  /** e.g. https://basescan.org or https://sepolia.basescan.org, no trailing slash. */
  basescanUrl: string;
  /** 0G chain explorer for 0G tx hashes, or null to show a shortened hash instead. */
  zgExplorerUrl: string | null;
}

export const DEFAULT_LINKS: ExplorerLinks = { basescanUrl: "https://basescan.org", zgExplorerUrl: null };

export const RISK_EMOJI: Record<RiskLevel, string> = { NORMAL: "🟢", CAUTION: "🟡", HALT: "🔴" };

const RISK_EFFECT: Record<RiskLevel, string> = {
  NORMAL: "Agents trade normally.",
  CAUTION: "New entries are sized down and breakout entries are paused.",
  HALT: "New entries are blocked.",
};

const ARROW: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

/** HTML-escapes text for Telegram's HTML mode. Apply to every user-controlled string. */
export function esc(value: string | number): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** "2026-11-06 12:00 UTC". */
export function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "2026-11-06". Used as the daily digest key. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtPnl(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Basis points to a percent string ("5810" -> "58.1%"). */
export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  return `${value < 0 ? "-" : ""}$${abs >= 1 ? abs.toFixed(2) : abs.toFixed(4)}`;
}

export function fmtPrice(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toPrecision(4);
}

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash;
}

export function anchor(href: string, label: string): string {
  return `<a href="${esc(href)}">${esc(label)}</a>`;
}

export function baseScanTxLink(links: ExplorerLinks, hash: string, label = "BaseScan"): string {
  return anchor(`${links.basescanUrl}/tx/${hash}`, label);
}

export function zgTxText(links: ExplorerLinks, hash: string): string {
  return links.zgExplorerUrl
    ? anchor(`${links.zgExplorerUrl}/tx/${hash}`, "0G tx")
    : `0G tx <code>${esc(shortHash(hash))}</code>`;
}

export function rankDeltaText(delta: number | null): string {
  if (delta === null) return "new";
  if (delta === 0) return "";
  return delta > 0 ? `▲${delta}` : `▼${-delta}`;
}

function templateLabel(row: { kind: string; template: string | null }): string {
  if (row.kind === "human" || !row.template) return "human trader";
  return row.template.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Public: leaderboard, stats card, risk, digest, commentary
// ---------------------------------------------------------------------------

/** Monospace leaderboard. Stats columns only. ✓ marks CRE-verified rows. */
export function leaderboardTable(rows: PerformanceStats[], startRank = 1): string {
  const header = `${"#".padEnd(3)} ${"Name".padEnd(20)} ${"PnL".padStart(7)} ${"Win".padStart(6)} ${"DD".padStart(6)} ${"Trades".padStart(6)}`;
  const lines = rows.map((r, i) => {
    const line = [
      String(startRank + i).padEnd(3),
      truncate(r.name.replace(/^\[[^\]]*\]\s*/, ""), 20).padEnd(20),
      fmtPnl(r.realizedPnlPct).padStart(7),
      fmtBps(r.winRateBps).padStart(6),
      fmtBps(r.maxDrawdownBps).padStart(6),
      String(r.trades).padStart(6),
    ].join(" ");
    return r.verified ? `${line} ✓` : line;
  });
  return `<pre>${[header, ...lines].map(esc).join("\n")}</pre>`;
}

export interface StatsCardOptions {
  links: ExplorerLinks;
  rank?: number;
  /** Positive = moved up since the last digest batch. null = not on the board before. */
  rankDelta?: number | null;
}

/** Agent (or human) stats card. Public-safe: no orders, fills, sizes, configs or lessons. */
export function statsCard(r: PerformanceStats, o: StatsCardOptions): string {
  const mode = r.mode === "paper" ? "PAPER" : "LIVE";
  const lines: string[] = [];
  lines.push(`🏆 <b>${esc(r.name)}</b> · ${esc(templateLabel(r))} · <i>${mode}</i>`);
  if (o.rank !== undefined) {
    const delta = o.rankDelta === undefined ? "" : rankDeltaText(o.rankDelta);
    lines.push(`Rank #${o.rank}${delta ? ` (${delta})` : ""}`);
  }
  if (r.verified) {
    lines.push(
      `✓ <b>Verified by Chainlink CRE</b> · ${esc(utcStamp(r.verified.asOf))} · ${baseScanTxLink(o.links, r.verified.reportTx, "report tx")}`,
    );
  } else {
    lines.push("○ Not yet CRE-verified");
  }
  if (r.selfFunded) lines.push("⚡ <b>Self-funded</b>: recent inference paid from its own earned credit");
  lines.push(`PnL <b>${fmtPnl(r.realizedPnlPct)}</b> · Win rate ${fmtBps(r.winRateBps)} · Max DD ${fmtBps(r.maxDrawdownBps)}`);
  lines.push(
    `Forecast hit ${fmtBps(r.forecastHitRateBps)} · Trades ${r.trades} · Forks ${r.forkCount} · ${r.daysActive}d active`,
  );
  return lines.join("\n");
}

export function commentaryLine(f: Forecast): string {
  const conf = Math.round(f.confidence * 100);
  return `🧭 <b>Market view</b> (delayed 1h): ${esc(f.asset)} ${ARROW[f.direction] ?? ""} ${esc(f.direction)} over ${f.horizonMin}m · confidence ${conf}%`;
}

export function digestMessage(input: {
  date: string;
  card: string;
  commentary: Forecast | null;
}): string {
  const parts = [`📊 <b>Daily digest</b> · ${esc(input.date)}`, input.card];
  if (input.commentary) parts.push(commentaryLine(input.commentary));
  parts.push("<i>Stats only. Individual trades stay private.</i>");
  return parts.join("\n");
}

export function riskReasonText(code: number): string {
  switch (code) {
    case RiskReason.PriceDrop:
      return "Sharp drop in major assets";
    case RiskReason.Volatility:
      return "Volatility spike";
    case RiskReason.Depeg:
      return "Stablecoin depeg";
    case RiskReason.News:
      return "Negative news flow";
    case RiskReason.ManualSimulation:
      return "Manual simulation (demo)";
    default:
      return "No active trigger";
  }
}

export interface RiskRecord {
  level: RiskLevel;
  reasonCode: number;
  asOf: number;
  txHash: `0x${string}` | null;
}

/** Current platform risk level with reason and effect. */
export function riskStatus(risk: RiskRecord, links: ExplorerLinks): string {
  const tx = risk.txHash ? ` · ${baseScanTxLink(links, risk.txHash, "report tx")}` : "";
  return [
    `${RISK_EMOJI[risk.level]} <b>Platform risk: ${risk.level}</b>`,
    esc(riskReasonText(risk.reasonCode)),
    esc(RISK_EFFECT[risk.level]),
    `As of ${esc(utcStamp(risk.asOf))}${tx}`,
  ].join("\n");
}

export function riskChangeAlert(prev: RiskLevel, risk: RiskRecord, links: ExplorerLinks): string {
  return `🔔 <b>Risk level changed</b>: ${RISK_EMOJI[prev]} ${prev} → ${RISK_EMOJI[risk.level]} ${risk.level}\n${riskStatus(risk, links)}`;
}

// ---------------------------------------------------------------------------
// Owner alerts (full detail, only sent to chats linked to the agent's owner wallet)
// ---------------------------------------------------------------------------

export function orderPlacedAlert(
  agentName: string,
  o: { id: string; side: string; asset: string; orderType: string; notionalUsd: number },
): string {
  return [
    `📝 <b>Order placed</b> · ${esc(agentName)}`,
    `${esc(o.side)} ${esc(o.asset)} · ${esc(o.orderType)} · ${fmtUsd(o.notionalUsd)}`,
    `Flash order <code>${esc(shortHash(o.id))}</code>`,
  ].join("\n");
}

export function fillAlert(
  agentName: string,
  f: { side: string; asset: string; qty: number; price: number; notionalUsd: number; txId: string | null },
  links: ExplorerLinks,
): string {
  const tx = f.txId ? ` · ${baseScanTxLink(links, f.txId)}` : "";
  return [
    `✅ <b>Filled</b> · ${esc(agentName)}`,
    `${esc(f.side)} ${esc(fmtPrice(f.qty))} ${esc(f.asset)} @ ${esc(fmtPrice(f.price))} (${fmtUsd(f.notionalUsd)})${tx}`,
  ].join("\n");
}

export function guardrailAlert(agentName: string, reasons: string[], ts: number): string {
  return [
    `🛡 <b>Blocked by guardrails</b> · ${esc(agentName)}`,
    ...reasons.map((r) => `• ${esc(r)}`),
    esc(utcStamp(ts)),
  ].join("\n");
}

export function budgetTierAlert(agentName: string, from: string, to: string, ts: number): string {
  return `🔋 <b>Budget tier</b> · ${esc(agentName)}: ${esc(from)} → ${esc(to)}\n${esc(utcStamp(ts))}`;
}

export function topupAlert(
  agentName: string,
  t: { usdcAmount: number; status: string; baseTx: string | null; zgTransferTx: string | null; depositTx: string | null; ts: number },
  links: ExplorerLinks,
): string {
  const lines = [`💸 <b>Top-up</b> · ${esc(agentName)} · ${fmtUsd(t.usdcAmount)} USDC · ${esc(t.status)}`];
  if (t.baseTx) lines.push(`Base tx: ${baseScanTxLink(links, t.baseTx)}`);
  if (t.zgTransferTx) lines.push(`Transfer: ${zgTxText(links, t.zgTransferTx)}`);
  if (t.depositTx) lines.push(`Deposit: ${zgTxText(links, t.depositTx)}`);
  lines.push(esc(utcStamp(t.ts)));
  return lines.join("\n");
}

export function attestationAlert(agentName: string, a: { txHash: string | null; asOf: number }, links: ExplorerLinks): string {
  const tx = a.txHash ? ` · ${baseScanTxLink(links, a.txHash, "report tx")}` : "";
  return `✓ <b>New CRE attestation</b> · ${esc(agentName)}\n${esc(utcStamp(a.asOf))}${tx}`;
}
