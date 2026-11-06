import type { FlashOrderType, TemplateId } from "@arena/shared";

export interface SliderDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: "%" | "x" | "min" | "sec" | "count" | "usd";
  help: string;
}

export interface TemplateDef {
  id: TemplateId;
  name: string;
  tagline: string;
  description: string;
  sliders: SliderDef[];
  allowedOrderTypes: FlashOrderType[];
  defaultEntryOrderType: FlashOrderType;
  defaultTickIntervalSec: number;
}

/**
 * Platform-wide bounds for protection and sizing sliders, in percent units.
 * Templates use these bounds for their sliders; the engine falls back to them
 * when a template has no matching slider (e.g. take-profit on smart_dca).
 */
export const PROTECTION_BOUNDS = {
  takeProfitPct: { min: 0.5, max: 20 },
  stopLossPct: { min: 0.5, max: 15 },
  trailPct: { min: 0.5, max: 10 },
  sizePct: { min: 5, max: 100 },
} as const;

/** Exits and protection, allowed on every template (PRD 6.2). */
const EXIT_ORDER_TYPES: FlashOrderType[] = ["market", "stop-loss", "take-profit", "bracket"];

const minConfidence: SliderDef = {
  key: "minConfidence",
  label: "Min confidence",
  min: 0,
  max: 100,
  step: 1,
  default: 60,
  unit: "%",
  help: "Minimum forecast confidence required before entering.",
};

const sizePct: SliderDef = {
  key: "sizePct",
  label: "Position size",
  min: PROTECTION_BOUNDS.sizePct.min,
  max: PROTECTION_BOUNDS.sizePct.max,
  step: 1,
  default: 25,
  unit: "%",
  help: "Share of the agent allocation used per entry. Acts as a cap on the LLM's size.",
};

const takeProfitPct: SliderDef = {
  key: "takeProfitPct",
  label: "Take profit",
  min: PROTECTION_BOUNDS.takeProfitPct.min,
  max: PROTECTION_BOUNDS.takeProfitPct.max,
  step: 0.5,
  default: 4,
  unit: "%",
  help: "Take-profit distance from the entry mark. Attached to every buy.",
};

const stopLossPct: SliderDef = {
  key: "stopLossPct",
  label: "Stop loss",
  min: PROTECTION_BOUNDS.stopLossPct.min,
  max: PROTECTION_BOUNDS.stopLossPct.max,
  step: 0.5,
  default: 2,
  unit: "%",
  help: "Stop-loss distance from the entry mark. Attached to every buy.",
};

const trailPct: SliderDef = {
  key: "trailPct",
  label: "Trailing stop",
  min: PROTECTION_BOUNDS.trailPct.min,
  max: PROTECTION_BOUNDS.trailPct.max,
  step: 0.5,
  default: 2,
  unit: "%",
  help: "Trail distance for trailing-stop orders.",
};

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  momentum: {
    id: "momentum",
    name: "Momentum",
    tagline: "Ride the trend",
    description: "EMA and rate-of-change trend signals, confirmed by the LLM forecast. Trailing stops lock in gains.",
    sliders: [
      {
        key: "lookbackBars",
        label: "Lookback",
        min: 5,
        max: 100,
        step: 1,
        default: 20,
        unit: "count",
        help: "Bars used for the trend (ROC) lookback.",
      },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
      trailPct,
    ],
    allowedOrderTypes: ["market", "limit", "trailing-stop", ...EXIT_ORDER_TYPES],
    defaultEntryOrderType: "limit",
    defaultTickIntervalSec: 300,
  },

  mean_reversion: {
    id: "mean_reversion",
    name: "Mean Reversion",
    tagline: "Buy the dip, sell the bounce",
    description: "Enters on RSI extremes and exits when price reverts. The LLM checks whether the regime still supports reversion.",
    sliders: [
      {
        key: "rsiLow",
        label: "RSI oversold",
        min: 5,
        max: 45,
        step: 1,
        default: 30,
        unit: "count",
        help: "Buy when RSI(14) falls to or below this level.",
      },
      {
        key: "rsiHigh",
        label: "RSI overbought",
        min: 55,
        max: 95,
        step: 1,
        default: 70,
        unit: "count",
        help: "Sell or avoid entries when RSI(14) rises to or above this level.",
      },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
      {
        key: "maxHoldMin",
        label: "Max hold",
        min: 15,
        max: 10080,
        step: 15,
        default: 240,
        unit: "min",
        help: "Close the position if it has not reverted after this many minutes.",
      },
    ],
    allowedOrderTypes: ["limit", ...EXIT_ORDER_TYPES],
    defaultEntryOrderType: "limit",
    defaultTickIntervalSec: 600,
  },

  breakout: {
    id: "breakout",
    name: "Breakout",
    tagline: "Trade the range break",
    description: "Stop-buys above the recent range high. The LLM filters false breakouts. No new breakout entries while RiskOracle is at CAUTION.",
    sliders: [
      {
        key: "rangeBars",
        label: "Range window",
        min: 5,
        max: 200,
        step: 1,
        default: 20,
        unit: "count",
        help: "Bars used to compute the range high and low.",
      },
      {
        key: "breakoutPct",
        label: "Breakout distance",
        min: 0.1,
        max: 5,
        step: 0.1,
        default: 0.5,
        unit: "%",
        help: "How far above the range high the stop-buy triggers.",
      },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
    ],
    allowedOrderTypes: ["stop", ...EXIT_ORDER_TYPES],
    defaultEntryOrderType: "stop",
    defaultTickIntervalSec: 300,
  },

  smart_dca: {
    id: "smart_dca",
    name: "Smart DCA",
    tagline: "Accumulate on a schedule",
    description: "Spreads a budget into scheduled TWAP buys. The LLM may raise the multiplier on dips, up to the cap.",
    sliders: [
      {
        key: "budgetUsd",
        label: "Budget",
        min: 1,
        max: 1000,
        step: 1,
        default: 5,
        unit: "usd",
        help: "Total USD to accumulate over the TWAP window.",
      },
      {
        key: "periodMin",
        label: "Period",
        min: 5,
        max: 10080,
        step: 5,
        default: 60,
        unit: "min",
        help: "Minutes between scheduled accumulation buckets.",
      },
      {
        key: "buckets",
        label: "Buckets",
        min: 2,
        max: 2560,
        step: 1,
        default: 10,
        unit: "count",
        help: "Number of TWAP buckets.",
      },
      {
        key: "dipMultiplierMax",
        label: "Dip multiplier max",
        min: 1,
        max: 5,
        step: 0.1,
        default: 2,
        unit: "x",
        help: "Maximum multiplier the LLM may apply to a bucket on a dip.",
      },
      {
        key: "stopLossFloorPct",
        label: "Stop-loss floor",
        min: PROTECTION_BOUNDS.stopLossPct.min,
        max: PROTECTION_BOUNDS.stopLossPct.max,
        step: 0.5,
        default: 10,
        unit: "%",
        help: "Stop-loss distance from the entry mark. Attached to every buy.",
      },
    ],
    allowedOrderTypes: ["twap", "limit", ...EXIT_ORDER_TYPES],
    defaultEntryOrderType: "twap",
    defaultTickIntervalSec: 300,
  },

  social_sentiment: {
    id: "social_sentiment",
    name: "Social Sentiment",
    tagline: "Follow the crowd's read",
    description: "Trades on the insight digest from social and web sources, when enough of them agree. The LLM forecast must also clear the confidence bar.",
    sliders: [
      {
        key: "minSourceAgreement",
        label: "Min source agreement",
        min: 0,
        max: 100,
        step: 1,
        default: 60,
        unit: "%",
        help: "Share of insight sources that must agree on direction before entering.",
      },
      minConfidence,
      sizePct,
      takeProfitPct,
      stopLossPct,
    ],
    allowedOrderTypes: ["limit", ...EXIT_ORDER_TYPES],
    defaultEntryOrderType: "limit",
    defaultTickIntervalSec: 900,
  },
};
