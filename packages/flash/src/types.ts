// Zod schemas and TS types for the Definitive Flash REST API (v1) and orders WebSocket.
// Field names are taken verbatim from the Flash docs (https://flash.definitive.fi/v1/openapi.json and
// /docs/api-reference/flash/*). Objects are "loose" so unknown fields from the API never break parsing.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ChainSchema = z.enum([
  "arbitrum",
  "avalanche",
  "base",
  "bsc",
  "ethereum",
  "optimism",
  "polygon",
  "solana",
  "hyperevm",
  "plasma",
  "monad",
  "robinhood",
  "ink",
  "arc",
  "elysium",
]);
export type Chain = z.infer<typeof ChainSchema>;

export const OrderTypeSchema = z.enum([
  "market",
  "limit",
  "twap",
  "stop",
  "stop-loss",
  "take-profit",
  "bracket",
  "trailing-stop",
  "trailing-stop-limit",
]);
export type FlashApiOrderType = z.infer<typeof OrderTypeSchema>;

export const OrderSideSchema = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const TriggerTypeSchema = z.enum(["upper", "lower"]);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

export const FlashOrderStatusSchema = z.enum([
  "ORDER_STATUS_UNSPECIFIED",
  "ORDER_STATUS_PENDING",
  "ORDER_STATUS_ACCEPTED",
  "ORDER_STATUS_PARTIALLY_FILLED",
  "ORDER_STATUS_FILLED",
  "ORDER_STATUS_CANCELLED",
  "ORDER_STATUS_REJECTED",
  "ORDER_STATUS_TERMINATED",
]);
export type FlashOrderStatus = z.infer<typeof FlashOrderStatusSchema>;

export const FlashChainStatusSchema = z.enum([
  "CHAIN_STATUS_UNSPECIFIED",
  "CHAIN_STATUS_PROCESSED",
  "CHAIN_STATUS_REORGED",
  "CHAIN_STATUS_FINALIZED",
]);

export const BatchCancelErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "ALREADY_FILLED",
  "REJECTED",
  "PENDING_CANCEL",
  "SETTLING",
  "INTERNAL_ERROR",
]);

/** Statuses that mean the order is still live (WS/REST). Anything else is terminal. */
export const OPEN_ORDER_STATUSES: readonly FlashOrderStatus[] = [
  "ORDER_STATUS_PENDING",
  "ORDER_STATUS_ACCEPTED",
  "ORDER_STATUS_PARTIALLY_FILLED",
];

// ---------------------------------------------------------------------------
// Shared request building blocks
// ---------------------------------------------------------------------------

export const PriceTriggerSchema = z.looseObject({
  notionalPrice: z.string().optional(),
  crossPrice: z.string().optional(),
  /** Bracket legs only per the quote docs. */
  limitPrice: z.string().optional(),
  triggerType: TriggerTypeSchema,
});
export type PriceTrigger = z.input<typeof PriceTriggerSchema>;

export const TrailingStopTriggerSchema = z.looseObject({
  /** Decimal fraction, 0.005 to 0.5 inclusive (0.05 = 5%). */
  trailPercent: z.string(),
  activationPrice: z.string().optional(),
});
export type TrailingStopTrigger = z.input<typeof TrailingStopTriggerSchema>;

export const AttachedBracketLegSchema = z.looseObject({
  notionalPrice: z.string().optional(),
  crossPrice: z.string().optional(),
  limitPrice: z.string().optional(),
});
export type AttachedBracketLeg = z.input<typeof AttachedBracketLegSchema>;

export const AttachedBracketQuoteSchema = z.looseObject({
  takeProfit: AttachedBracketLegSchema,
  stopLoss: AttachedBracketLegSchema,
  expireTime: z.string().optional(),
});

/** Order-submit attachedBracket: legs plus the signatures/payload echoed from the quote. */
export const AttachedBracketSubmitSchema = z.looseObject({
  takeProfit: AttachedBracketLegSchema,
  stopLoss: AttachedBracketLegSchema,
  userSignature: z.string().min(1),
  salt: z.string().optional(),
  svmNonce: z.string().optional(),
  deadline: z.string(),
  signedMaxFromAmount: z.string(),
  evmPermitSignature: z.string().optional(),
  evmPermitTypedData: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

const baseOrderShape = {
  targetChain: ChainSchema,
  contraChain: ChainSchema,
  targetAsset: z.string().min(1),
  contraAsset: z.string().min(1),
  side: OrderSideSchema,
  /** buy: contraAsset units; sell: targetAsset units. Decimal string. */
  qty: z.string(),
  orderType: OrderTypeSchema,
  quickTrade: z.boolean().optional(),
  maxSlippage: z.string().optional(),
  maxPriceImpact: z.string().optional(),
  limitNotionalPrice: z.string().optional(),
  limitCrossPrice: z.string().optional(),
  funderAddress: z.string().optional(),
  recipientAddress: z.string().optional(),
  flashIntegratorFeeBps: z.string().optional(),
  twapBucketCount: z.number().int().min(2).max(2560).optional(),
  startTime: z.string().optional(),
  triggers: z.array(PriceTriggerSchema).max(2).optional(),
  trailingStop: TrailingStopTriggerSchema.optional(),
};

export const QuoteRequestSchema = z.looseObject({
  ...baseOrderShape,
  expireTime: z.string().optional(),
  /** TWAP only, quote-time only. Minimum 300. */
  durationSeconds: z.number().int().min(300).optional(),
  attachedBracket: AttachedBracketQuoteSchema.optional(),
  evmUsePermit2: z.boolean().optional(),
  forceMinimalAllowance: z.boolean().optional(),
  svmUseNativeSOL: z.boolean().optional(),
});
export type QuoteRequest = z.input<typeof QuoteRequestSchema>;

export const QuoteLegSchema = z.looseObject({
  asset: z.enum(["target", "contra"]),
  amount: z.string(),
  notional: z.string(),
});
export type QuoteLeg = z.output<typeof QuoteLegSchema>;

export const SvmAccountMetaSchema = z.looseObject({
  pubkey: z.string(),
  isSigner: z.boolean(),
  isWritable: z.boolean(),
});

export const SvmInstructionSchema = z.looseObject({
  programId: z.string(),
  accounts: z.array(SvmAccountMetaSchema),
  /** base58 */
  data: z.string(),
});

export const TxRequestSchema = z.looseObject({ to: z.string(), data: z.string() });

export const QuoteWrapActionSchema = z.looseObject({
  nativeAsset: z.string(),
  wrappedAsset: z.string(),
  evmTx: z.looseObject({ to: z.string(), data: z.string(), value: z.string() }).nullish(),
  svmInstructions: z.array(SvmInstructionSchema).nullish(),
});

export const QuoteEvmActionsSchema = z.looseObject({
  /** ERC-20 approve(spender, amount). Must be submitted onchain by the funder before the order executes. */
  approveTx: TxRequestSchema.nullish(),
  /** Permit2 typed data (EIP-712). Present only when a new permit signature is needed. */
  permitTypedData: z.string().nullish(),
  /** Order typed data (EIP-712), JSON string: { domain, types, primaryType, message }. */
  orderTypedData: z.string().nullish(),
});

export const QuoteSvmActionsSchema = z.looseObject({
  ataSetupIxs: z.array(SvmInstructionSchema).nullish(),
  delegateIx: SvmInstructionSchema.nullish(),
  sponsoredDelegateTx: z.string().nullish(),
  orderMessage: z.string().nullish(),
  nonce: z.string().nullish(),
  deadline: z.string().nullish(),
});

export const QuoteAttachedBracketSigningSchema = z.looseObject({
  evm: z
    .looseObject({
      approveTx: TxRequestSchema.nullish(),
      permitTypedData: z.string().nullish(),
      orderTypedData: z.string(),
    })
    .nullish(),
  svm: z
    .looseObject({
      orderMessage: z.string().nullish(),
      nonce: z.string(),
      delegateIx: SvmInstructionSchema.nullish(),
    })
    .nullish(),
  salt: z.string().nullish(),
  deadline: z.string(),
  signedMaxFromAmount: z.string(),
});

export const QuoteResponseSchema = z.looseObject({
  quoteId: z.string(),
  bridgeQuoteId: z.string().nullish(),
  orderType: OrderTypeSchema,
  side: OrderSideSchema,
  targetAsset: z.string(),
  contraAsset: z.string(),
  from: QuoteLegSchema,
  to: QuoteLegSchema,
  fees: z.looseObject({ estimatedFeeNotional: z.string() }),
  estimatedPriceImpact: z.string().nullish(),
  recommendedSlippage: z.string().nullish(),
  wrap: QuoteWrapActionSchema.nullish(),
  evm: QuoteEvmActionsSchema.nullish(),
  svm: QuoteSvmActionsSchema.nullish(),
  attachedBracket: QuoteAttachedBracketSigningSchema.nullish(),
  setupTxs: z.array(z.string()).nullish(),
});
export type QuoteResponse = z.output<typeof QuoteResponseSchema>;

// ---------------------------------------------------------------------------
// Typed data (EIP-712), as returned in quote.evm.orderTypedData / permitTypedData
// ---------------------------------------------------------------------------

export const TypedDataFieldSchema = z.looseObject({ name: z.string(), type: z.string() });

export const FlashTypedDataSchema = z.looseObject({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(TypedDataFieldSchema)),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type FlashTypedData = z.output<typeof FlashTypedDataSchema>;

// ---------------------------------------------------------------------------
// Submit order
// ---------------------------------------------------------------------------

export const SubmitOrderRequestSchema = z.looseObject({
  ...baseOrderShape,
  funderAddress: z.string().min(1),
  userSignature: z.string().min(1),
  quoteId: z.string().min(1),
  bridgeQuoteId: z.string().min(1).optional(),
  /** Matches ^[a-zA-Z0-9_.-]{1,32}$. EVM settlement only. */
  erc8021AttributionCode: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,32}$/)
    .optional(),
  evmOrderTypedData: z.string().optional(),
  evmPermitTypedData: z.string().optional(),
  evmPermitSignature: z.string().optional(),
  svmNonce: z.string().optional(),
  svmDeadline: z.string().optional(),
  svmSponsoredDelegateTx: z.string().optional(),
  attachedBracket: AttachedBracketSubmitSchema.optional(),
});
export type SubmitOrderRequest = z.input<typeof SubmitOrderRequestSchema>;

export const SubmitOrderResponseSchema = z.looseObject({
  orderId: z.string(),
  attachedBracket: z.looseObject({ status: z.string() }).nullish(),
});
export type SubmitOrderResponse = z.output<typeof SubmitOrderResponseSchema>;

// ---------------------------------------------------------------------------
// Orders (REST reads and WS frames)
// ---------------------------------------------------------------------------

export const FlashAssetChainRefSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  namespace: z.string(),
});

export const FlashAssetRefSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  ticker: z.string(),
  chain: FlashAssetChainRefSchema,
});
export type FlashAssetRef = z.output<typeof FlashAssetRefSchema>;

export const FlashOrderFilledSchema = z.looseObject({
  targetAmount: z.string().nullish(),
  contraAmount: z.string().nullish(),
  averagePrice: z.string().nullish(),
  averageNotionalPrice: z.string().nullish(),
});

export const TrailingStopReadSchema = z.looseObject({
  trailPercent: z.string(),
  activationPrice: z.string().nullish(),
  activated: z.boolean(),
  watermarkPrice: z.string().nullish(),
  effectiveTriggerPrice: z.string().nullish(),
  watermarkUpdatedAt: z.string().nullish(),
});

export const AttachedBracketReadLegSchema = z.looseObject({
  notionalPrice: z.string().nullish(),
  crossPrice: z.string().nullish(),
  limitPrice: z.string().nullish(),
});

export const AttachedBracketReadSchema = z.looseObject({
  status: z.enum(["pending_activation", "never_activated", "active"]),
  bracketOrderId: z.string().nullish(),
  takeProfit: AttachedBracketReadLegSchema.nullish(),
  stopLoss: AttachedBracketReadLegSchema.nullish(),
  signedMaxFromAmount: z.string().nullish(),
  expiresAt: z.string().nullish(),
});

export const FlashOrderSchema = z.looseObject({
  orderId: z.string(),
  orderType: OrderTypeSchema,
  side: OrderSideSchema,
  status: FlashOrderStatusSchema,
  closeReason: z.string().nullish(),
  funderAddress: z.string(),
  recipientAddress: z.string().nullish(),
  integratorFeeBps: z.string().nullish(),
  tradeFeeBps: z.string().nullish(),
  targetAsset: FlashAssetRefSchema,
  contraAsset: FlashAssetRefSchema,
  qty: z.string(),
  filled: FlashOrderFilledSchema.nullish(),
  limitNotionalPrice: z.string().nullish(),
  limitCrossPrice: z.string().nullish(),
  trigger: PriceTriggerSchema.nullish(),
  brackets: z.array(PriceTriggerSchema).nullish(),
  trailingStop: TrailingStopReadSchema.nullish(),
  attachedBracket: AttachedBracketReadSchema.nullish(),
  sourceEntryOrderId: z.string().nullish(),
  maxPriceImpact: z.string().nullish(),
  twapBucketCount: z.number().int().nullish(),
  placedAt: z.string(),
  acceptedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  expiresAt: z.string().nullish(),
});
export type FlashOrder = z.output<typeof FlashOrderSchema>;

export const FlashFillSchema = z.looseObject({
  status: FlashChainStatusSchema,
  /** USD notional of the fill. */
  notional: z.string(),
  venues: z.array(z.string()),
  filledAt: z.string(),
  rootOrderId: z.string(),
  orderId: z.string(),
  parentOrderId: z.string(),
  transactionId: z.string(),
  fillPrice: z.string(),
  feeAmount: z.string(),
  feeTicker: z.string(),
  tradeFeeAmount: z.string().optional(),
  networkFeeAmount: z.string().optional(),
  integratorFeeAmount: z.string(),
  feeNotional: z.string(),
  tradeFeeNotional: z.string().optional(),
  networkFeeNotional: z.string().optional(),
  integratorFeeNotional: z.string(),
  contraAmount: z.string(),
  targetAmount: z.string(),
});
export type FlashFill = z.output<typeof FlashFillSchema>;

export const FlashGetOrderResponseSchema = z.looseObject({
  order: FlashOrderSchema,
  fills: z.array(FlashFillSchema),
});
export type FlashGetOrderResponse = z.output<typeof FlashGetOrderResponseSchema>;

export const FlashListOrdersResponseSchema = z.looseObject({
  orders: z.array(FlashOrderSchema),
  nextPageToken: z.string().nullish(),
});
export type FlashListOrdersResponse = z.output<typeof FlashListOrdersResponseSchema>;

// ---------------------------------------------------------------------------
// Update / cancel
// ---------------------------------------------------------------------------

export const UpdateOrderTriggerSchema = z.looseObject({
  notionalPrice: z.string().optional(),
  crossPrice: z.string().optional(),
  triggerType: TriggerTypeSchema,
});

/** Bracket leg: a new trigger in the basis the leg was placed with. limitPrice is optional (omitted = sells at market). */
export const UpdateBracketLegSchema = UpdateOrderTriggerSchema.extend({ limitPrice: z.string().optional() });

export const UpdateOrderRequestSchema = z.looseObject({
  updateMessage: z.string().min(1),
  userSignature: z.string().min(1),
  limitNotionalPrice: z.string().optional(),
  limitCrossPrice: z.string().optional(),
  trigger: UpdateOrderTriggerSchema.optional(),
  triggers: z.tuple([UpdateBracketLegSchema, UpdateBracketLegSchema]).optional(),
});
export type UpdateOrderRequest = z.input<typeof UpdateOrderRequestSchema>;

export const UpdateOrderResponseSchema = z.looseObject({ ok: z.literal(true) });

export const CancelOrderRequestSchema = z.looseObject({
  cancelMessage: z.string().min(1),
  userSignature: z.string().min(1),
});
export type CancelOrderRequest = z.input<typeof CancelOrderRequestSchema>;

export const CancelOrderResponseSchema = z.looseObject({ ok: z.literal(true) });

/** Lowercase hyphenated UUID, exactly as the OpenAPI spec pattern states. */
export const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const BatchCancelOrderRequestSchema = z.looseObject({
  orderIds: z
    .array(z.string().regex(ORDER_ID_PATTERN))
    .min(1)
    .max(25)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate order ids are rejected"),
  cancelMessage: z.string().min(1),
  userSignature: z.string().min(1),
});
export type BatchCancelOrderRequest = z.input<typeof BatchCancelOrderRequestSchema>;

export const BatchCancelOrderResultSchema = z.looseObject({
  orderId: z.string(),
  ok: z.boolean(),
  errorCode: z.string().nullish(),
});

export const BatchCancelOrderResponseSchema = z.looseObject({
  results: z.array(BatchCancelOrderResultSchema),
});
export type BatchCancelOrderResponse = z.output<typeof BatchCancelOrderResponseSchema>;

// ---------------------------------------------------------------------------
// Setup transaction (approval/wrap txs returned by quote.setupTxs)
// ---------------------------------------------------------------------------

export const SubmitSetupTransactionRequestSchema = z.looseObject({ signedSetupTx: z.string().min(1) });
export const SubmitSetupTransactionResponseSchema = z.looseObject({
  status: z.enum(["confirmed", "pending"]),
});

// ---------------------------------------------------------------------------
// Search and balances
// ---------------------------------------------------------------------------

export const FlashAssetSchema = z.looseObject({
  chain: ChainSchema,
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  price: z.string(),
  marketCap: z.string(),
  liquidity: z.string(),
  volume24h: z.string(),
  priceChange24h: z.string(),
  holders: z.number().int(),
  imageUrl: z.string(),
  riskFlagged: z.boolean(),
});
export type FlashAsset = z.output<typeof FlashAssetSchema>;

export const FlashSearchAssetsResponseSchema = z.looseObject({ assets: z.array(FlashAssetSchema) });
export type FlashSearchAssetsResponse = z.output<typeof FlashSearchAssetsResponseSchema>;

export const FlashTokenBalanceSchema = z.looseObject({
  chain: ChainSchema,
  address: z.string(),
  symbol: z.string(),
  tokenDecimals: z.number().int().min(0),
  balance: z.string(),
  notional: z.string(),
  priceChange24h: z.string().nullish(),
  imageUrl: z.string(),
  isNative: z.boolean(),
});
export type FlashTokenBalance = z.output<typeof FlashTokenBalanceSchema>;

export const FlashBalancesResponseSchema = z.looseObject({
  balances: z.array(FlashTokenBalanceSchema),
});
export type FlashBalancesResponse = z.output<typeof FlashBalancesResponseSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ErrorResponseSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullish(),
  }),
});

// ---------------------------------------------------------------------------
// WebSocket (orders channel). Endpoint: wss://flash.definitive.fi/v1/ws
// ---------------------------------------------------------------------------

/** Order frames use the same shape as REST orders, plus two WS-only fields. */
export const FlashOrderUpdateSchema = FlashOrderSchema.extend({
  pendingUpdate: z.boolean().nullish(),
  completedFillCount: z.number().int().nullish(),
});
export type FlashOrderUpdate = z.output<typeof FlashOrderUpdateSchema>;

export const WsAckFrameSchema = z.looseObject({
  channel: z.literal("subscriptions"),
  type: z.literal("ack"),
  subscriptions: z.array(z.string()),
});

export const WsSnapshotFrameSchema = z.looseObject({
  channel: z.literal("orders"),
  type: z.literal("snapshot"),
  orders: z.array(FlashOrderUpdateSchema),
});

export const WsUpdateFrameSchema = z.looseObject({
  channel: z.literal("orders"),
  type: z.literal("update"),
  orders: z.array(FlashOrderUpdateSchema),
});

export const WsErrorFrameSchema = z.looseObject({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/** Any other frame (e.g. heartbeats) is accepted as-is so an unknown frame never throws. */
export const WsOtherFrameSchema = z.looseObject({
  channel: z.string().optional(),
  type: z.string().optional(),
});

export type WsServerFrame =
  | ({ kind: "ack" } & z.output<typeof WsAckFrameSchema>)
  | ({ kind: "snapshot" } & z.output<typeof WsSnapshotFrameSchema>)
  | ({ kind: "update" } & z.output<typeof WsUpdateFrameSchema>)
  | ({ kind: "error" } & z.output<typeof WsErrorFrameSchema>)
  | ({ kind: "other" } & z.output<typeof WsOtherFrameSchema>);

// ---------------------------------------------------------------------------
// Normalized domain types (produced by fills.ts)
// ---------------------------------------------------------------------------

export interface Trade {
  orderId: string;
  side: OrderSide;
  /** Target asset ticker, e.g. "WETH". */
  asset: string;
  /** Target units. */
  qty: number;
  /** USD per target unit. */
  price: number;
  notionalUsd: number;
  feeUsd: number;
  integratorFeeUsd: number;
  txId: string;
  /** Unix ms. */
  ts: number;
}
