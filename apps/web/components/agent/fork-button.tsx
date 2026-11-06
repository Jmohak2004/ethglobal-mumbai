"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmtUsd } from "@/lib/format";

export function ForkButton({
  forkable,
  priceUsd,
  creatorPct,
  platformPct,
}: {
  forkable: boolean;
  priceUsd: number;
  creatorPct: number;
  platformPct: number;
}) {
  const toast = useToast();
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        variant="long"
        disabled={!forkable}
        onClick={() =>
          toast({
            title: "Fork checkout coming soon",
            description: "Needs wallet signing and a USDC permit on the fork marketplace.",
          })
        }
      >
        {forkable ? `Fork · ${fmtUsd(priceUsd)} USDC` : "Not forkable"}
      </Button>
      {forkable ? (
        <div className="num text-[10.5px] text-muted">
          creator {creatorPct}% / platform {platformPct}%
        </div>
      ) : null}
    </div>
  );
}
