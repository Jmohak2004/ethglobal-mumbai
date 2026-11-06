"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function WalletButton() {
  return <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />;
}
