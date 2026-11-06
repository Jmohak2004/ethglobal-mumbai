// Manual-trading order submission. Wallet signing (Flash EIP-712 orderTypedData + Permit2) is not wired yet.

export interface OrderTicket {
  side: "buy" | "sell";
  asset: string;
  orderType: "market" | "limit" | "twap" | "stop" | "trailing-stop" | "bracket";
  sizeUsd: number;
  limitPrice?: number;
  triggerPrice?: number;
  trailPct?: number;
  twap?: { durationMin: number; buckets: number };
  takeProfitPrice?: number;
  stopLossPrice?: number;
}

/** Stub: always throws until the wagmi signer is connected to Flash. */
export async function placeOrder(_ticket: OrderTicket): Promise<{ orderId: string }> {
  throw new Error("Wallet signing coming soon");
}
