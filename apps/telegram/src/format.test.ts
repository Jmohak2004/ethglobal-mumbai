import { describe, expect, test } from "bun:test";
import type { PerformanceStats } from "@arena/shared";
import {
  attestationAlert,
  budgetTierAlert,
  digestMessage,
  esc,
  fillAlert,
  guardrailAlert,
  leaderboardTable,
  orderPlacedAlert,
  rankDeltaText,
  riskChangeAlert,
  riskStatus,
  statsCard,
  topupAlert,
} from "./format.ts";
import { HUMAN, hash, forbiddenHits, LINKS, T0 } from "./test-fixtures.ts";

const mom: PerformanceStats = {
  entityId: "agent-mom",
  kind: "agent",
  name: "[demo] Momentum Alpha",
  template: "momentum",
  realizedPnlUsd: 4.82,
  realizedPnlPct: 3.1,
  unrealizedPnlUsd: 1.5,
  totalPnlUsd: 6.32,
  totalPnlPct: 4.2,
  volumeUsd: 210,
  trades: 620,
  winRateBps: 5810,
  maxDrawdownBps: 420,
  forecastHitRateBps: 6150,
  forkCount: 1,
  daysActive: 8,
  mode: "paper",
  verified: { reportTx: hash(9), asOf: T0 - 3_600_000 },
  selfFunded: true,
};

const brk: PerformanceStats = {
  ...mom,
  entityId: "agent-brk",
  name: "Breakout <Charlie> & \"Co\"",
  template: "breakout",
  realizedPnlUsd: 0,
  realizedPnlPct: 0,
  unrealizedPnlUsd: -0.91,
  totalPnlUsd: -0.91,
  totalPnlPct: -0.6,
  winRateBps: 4170,
  maxDrawdownBps: 880,
  trades: 1040,
  forkCount: 0,
  verified: null,
  selfFunded: false,
};

describe("esc", () => {
  test("escapes HTML-significant characters", () => {
    expect(esc(`<script>alert("x")</script> & more`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more");
  });

  test("leaves plain text alone", () => {
    expect(esc("[demo] Momentum Alpha")).toBe("[demo] Momentum Alpha");
  });
});

describe("leaderboardTable", () => {
  test("renders a monospace table with escaped names and verified marks", () => {
    const html = leaderboardTable([mom, brk]);
    expect(html.startsWith("<pre>")).toBe(true);
    expect(html.endsWith("</pre>")).toBe(true);
    expect(html).toContain("Momentum Alpha");
    expect(html).toContain("Breakout &lt;Charlie");
    expect(html).not.toContain("<Charlie>");
    expect(html.split("\n").find((l) => l.includes("Momentum"))).toContain("✓");
    expect(html.split("\n").find((l) => l.includes("Breakout"))).not.toContain("✓");
  });

  test("shows total PnL % (realized + open), not realized only", () => {
    const html = leaderboardTable([mom]);
    expect(html).toContain("+4.2%");
    expect(html).not.toContain("+3.1%");
  });

  test("starts ranks at the given offset", () => {
    const html = leaderboardTable([mom], 4);
    expect(html).toContain("4   ");
  });
});

describe("statsCard", () => {
  test("shows the PAPER label, verified line with BaseScan report link, and self-funded badge", () => {
    const card = statsCard(mom, { links: LINKS, rank: 1 });
    expect(card).toContain("<i>PAPER</i>");
    expect(card).toContain("✓ <b>Verified by Chainlink CRE</b>");
    expect(card).toContain(`href="${LINKS.basescanUrl}/tx/${hash(9)}"`);
    expect(card).toContain("⚡");
    expect(card).toContain("PnL <b>+4.2%</b> (+$6.32) · realized +$4.82 · open +$1.50");
    expect(card).toContain("Win rate 58.1%");
    expect(card).toContain("Max DD 4.2%");
    expect(card).toContain("Forecast hit 61.5%");
    expect(card).toContain("Trades 620");
    expect(card).toContain("Forks 1");
    expect(card).toContain("Rank #1");
  });

  test("marks unverified, non-self-funded agents without a BaseScan link", () => {
    const card = statsCard(brk, { links: LINKS });
    expect(card).toContain("Not yet CRE-verified");
    expect(card).not.toContain("BaseScan");
    expect(card).not.toContain("⚡");
    expect(card).toContain("PnL <b>-0.6%</b> (-$0.9100) · realized $0.0000 · open -$0.9100");
  });

  test("escapes the agent name", () => {
    expect(statsCard(brk, { links: LINKS })).toContain("<b>Breakout &lt;Charlie&gt; &amp; &quot;Co&quot;</b>");
  });

  test("humans show as human traders without a template", () => {
    const card = statsCard({ ...mom, kind: "human", template: null, name: "[demo] Ada K.", entityId: HUMAN }, { links: LINKS });
    expect(card).toContain("human trader");
  });

  test("public stats card contains no order, fill or sizing terms", () => {
    expect(forbiddenHits(statsCard(mom, { links: LINKS, rank: 1, rankDelta: 2 }))).toEqual([]);
    expect(forbiddenHits(statsCard(brk, { links: LINKS }))).toEqual([]);
  });
});

describe("rankDeltaText", () => {
  test("formats up, down, unchanged and new", () => {
    expect(rankDeltaText(2)).toBe("▲2");
    expect(rankDeltaText(-3)).toBe("▼3");
    expect(rankDeltaText(0)).toBe("");
    expect(rankDeltaText(null)).toBe("new");
  });
});

describe("risk messages", () => {
  test("uses the level emoji and includes reason and effect", () => {
    const risk = { level: "CAUTION" as const, reasonCode: 2, asOf: T0, txHash: null };
    const text = riskStatus(risk, LINKS);
    expect(text).toContain("🟡 <b>Platform risk: CAUTION</b>");
    expect(text).toContain("Volatility spike");
    expect(text).toContain("New entries");
  });

  test("halt and normal use their emoji", () => {
    expect(riskStatus({ level: "HALT", reasonCode: 1, asOf: T0, txHash: hash(3) }, LINKS)).toContain("🔴");
    expect(riskStatus({ level: "NORMAL", reasonCode: 0, asOf: T0, txHash: null }, LINKS)).toContain("🟢");
  });

  test("change alert names both levels", () => {
    const text = riskChangeAlert("NORMAL", { level: "HALT", reasonCode: 1, asOf: T0, txHash: null }, LINKS);
    expect(text).toContain("🟢 NORMAL → 🔴 HALT");
  });
});

describe("digest", () => {
  test("is stats only: card plus delayed market view", () => {
    const text = digestMessage({
      date: "2026-11-06",
      card: statsCard(mom, { links: LINKS, rank: 1, rankDelta: 1 }),
      commentary: { asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 0.8, confidence: 0.64 },
    });
    expect(text).toContain("Daily digest");
    expect(text).toContain("Market view</b> (delayed 1h): WETH ↑ up over 60m · confidence 64%");
    expect(forbiddenHits(text)).toEqual([]);
  });
});

describe("owner alerts carry trade detail", () => {
  test("order placed shows side, asset, type and notional", () => {
    const text = orderPlacedAlert("[demo] Momentum Alpha", {
      id: "flash-order-123456789",
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
    });
    expect(text).toContain("Order placed");
    expect(text).toContain("buy WETH · limit · $0.80");
  });

  test("fill links the tx on BaseScan", () => {
    const text = fillAlert(
      "[demo] Momentum Alpha",
      { side: "buy", asset: "WETH", qty: 0.00025, price: 3148.5, notionalUsd: 0.79, txId: hash(7) },
      LINKS,
    );
    expect(text).toContain("Filled");
    expect(text).toContain(`href="${LINKS.basescanUrl}/tx/${hash(7)}"`);
    expect(text).toContain("@ 3148.50");
  });

  test("guardrail block lists each reason escaped", () => {
    const text = guardrailAlert("Agent", ["size 90% > cap <max>", "daily loss"], T0);
    expect(text).toContain("Blocked by guardrails");
    expect(text).toContain("• size 90% &gt; cap &lt;max&gt;");
  });

  test("budget tier and attestation alerts", () => {
    expect(budgetTierAlert("Agent", "healthy", "low", T0)).toContain("healthy → low");
    expect(attestationAlert("Agent", { txHash: hash(5), asOf: T0 }, LINKS)).toContain("report tx");
  });

  test("top-up lists Base and 0G transactions", () => {
    const text = topupAlert(
      "Agent",
      { usdcAmount: 1.5, status: "credited", baseTx: hash(1), zgTransferTx: hash(2), depositTx: null, ts: T0 },
      LINKS,
    );
    expect(text).toContain("$1.50 USDC · credited");
    expect(text).toContain("Base tx");
    expect(text).toContain("0G tx");
  });
});
