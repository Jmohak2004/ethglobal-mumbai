"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";

import { Button } from "@/components/ui/button";
import { IconFork } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { describeError, postJson } from "@/lib/api";
import { CONTRACTS } from "@/lib/contracts";
import { forkOnchain, NotDeployedError } from "@/lib/onchain";
import { useSession } from "@/lib/hooks/use-session";
import { fmtUsd } from "@/lib/format";
import type { ForkResult } from "@/lib/types";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * Fork: sign in, approve USDC if needed, StrategyMarketplace.fork on Base, then the server verifies the Forked
 * event and creates your copy (paused, owned by you).
 */
export function ForkButton({
  agentId,
  forkable,
  priceUsd,
  creatorPct,
  platformPct,
}: {
  agentId: string;
  forkable: boolean;
  priceUsd: number;
  creatorPct: number;
  platformPct: number;
}) {
  const toast = useToast();
  const router = useRouter();
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const session = useSession({ prompt: false });
  const [busy, setBusy] = useState<string | null>(null);
  const deployed = CONTRACTS.marketplace !== null;

  const onClick = async () => {
    if (!address) {
      openConnectModal?.();
      return;
    }
    try {
      if (!session.signedIn) {
        setBusy("Signing in");
        await session.signIn();
      }
      setBusy("Confirm in wallet");
      const txHash = await forkOnchain(wagmiConfig, address, agentId, priceUsd);
      setBusy("Creating your copy");
      const res = await postJson<ForkResult & { newAgentId: string }>("/api/forks", { agentId, txHash });
      toast({ title: "Forked", description: "Your copy is paused. Fund it to start trading.", tone: "success" });
      router.push(`/agents/${res.newAgentId}`);
    } catch (err) {
      toast({
        title: "Fork failed",
        description: err instanceof NotDeployedError ? "Contracts not deployed" : describeError(err),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const label = !forkable
    ? "Not forkable"
    : !deployed
      ? "Contracts not deployed"
      : (busy ?? `Fork · ${fmtUsd(priceUsd)} USDC`);

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button variant="primary" disabled={!forkable || !deployed || busy !== null} onClick={onClick}>
        <IconFork size={14} />
        {label}
      </Button>
      {forkable ? (
        <div className="text-xs text-muted" title="Forking copies this agent's setup into a paper agent of your own.">
          Creator {creatorPct}% / platform {platformPct}%
        </div>
      ) : null}
    </div>
  );
}
