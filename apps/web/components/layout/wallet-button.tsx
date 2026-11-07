"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { clsx } from "clsx";

import { Button } from "@/components/ui/button";
import { IconWallet } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/api";
import { shortAddr } from "@/lib/format";
import { useSession } from "@/lib/hooks/use-session";

/**
 * The one account button. Not connected: "Connect wallet". Connected but not signed in: "Sign in" (a free signature,
 * not a transaction) with the address beside it. Signed in: the address, which opens the wallet's account panel.
 */
export function WalletButton({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const session = useSession({ prompt: false });
  const toast = useToast();

  return (
    <ConnectButton.Custom>
      {({ account, openAccountModal, openConnectModal, mounted }) => {
        const ready = mounted;
        if (!ready) return <div aria-hidden className={clsx("h-9 w-32", className)} />;
        if (!account) {
          return (
            <Button variant="primary" size={size} className={className} onClick={openConnectModal}>
              <IconWallet size={15} />
              Connect wallet
            </Button>
          );
        }
        const addr = shortAddr(account.address, 6, 4);
        const needsSignIn = session.ready && !session.signedIn;
        return (
          <div className={clsx("flex items-center gap-1.5", className)}>
            {needsSignIn ? (
              <Button
                variant="accent"
                size={size}
                title="A free signature that proves the wallet is yours. It is not a transaction."
                onClick={() =>
                  session.signIn().catch((err: unknown) =>
                    toast({ title: "Sign-in failed", description: describeError(err), tone: "error" }),
                  )
                }
              >
                Sign in
              </Button>
            ) : null}
            <Button variant="secondary" size={size} onClick={openAccountModal} aria-label={`Wallet ${addr}. Open account`}>
              <span aria-hidden className={clsx("size-1.5 rounded-full", session.signedIn ? "bg-long" : "bg-subtle")} />
              <span className="num">{addr}</span>
            </Button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
