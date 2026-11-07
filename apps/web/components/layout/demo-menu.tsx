"use client";

import type { RiskLevel } from "@arena/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { describeError, postJson } from "@/lib/api";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";

const ITEMS: { level: RiskLevel; label: string; hint: string }[] = [
  { level: "HALT", label: "Simulate crash (HALT)", hint: "No new buys. Pending entries are cancelled." },
  { level: "CAUTION", label: "Caution", hint: "Half size. No new breakout buys." },
  { level: "NORMAL", label: "Clear (NORMAL)", hint: "Back to normal trading." },
];

/**
 * Demo section of the nav "more" menu. Renders only when the server reports demoControls (DEMO_CONTROLS=true). The
 * server still checks the flag and the session on POST /api/demo/risk. A successful change refreshes the risk chip at once.
 */
export function DemoMenu() {
  const platform = usePlatform();
  const session = useSession({ prompt: false });
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (!platform.data?.demoControls) return null;

  const setLevel = async (level: RiskLevel) => {
    setBusy(true);
    try {
      await postJson("/api/demo/risk", { level });
      await qc.invalidateQueries({ queryKey: ["risk"] });
      toast({
        title: `Risk set to ${level}`,
        description: "The risk chip updates within a few seconds.",
        tone: level === "HALT" ? "error" : "default",
      });
    } catch (err) {
      toast({ title: "Demo risk not set", description: describeError(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    session.signIn().catch((err: unknown) => toast({ title: "Sign-in failed", description: describeError(err), tone: "error" }));

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      <div>
        <div className="text-base font-medium">Demo: simulate market risk</div>
        <p className="mt-0.5 text-xs text-muted">
          Writes a simulated crash-light level so you can show how agents react. Needs a signed-in session.
        </p>
      </div>
      {session.signedAddress === null ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-muted">
          <span>Sign in first.</span>
          <Button size="sm" variant="secondary" onClick={signIn}>
            Sign in
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {ITEMS.map((item) => (
          <button
            key={item.level}
            type="button"
            disabled={busy || session.signedAddress === null}
            onClick={() => setLevel(item.level)}
            className="flex flex-col items-start rounded-lg border border-border px-3 py-2 text-left transition-colors duration-100 hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
          >
            <span className="text-base font-medium">{item.label}</span>
            <span className="text-xs text-muted">{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
