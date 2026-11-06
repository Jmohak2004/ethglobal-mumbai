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
 * Nav "Demo" menu. Renders only when the server reports demoControls (DEMO_CONTROLS=true). The server still checks the
 * flag and the session on POST /api/demo/risk. A successful change refreshes the nav risk pill at once.
 */
export function DemoMenu() {
  const platform = usePlatform();
  const session = useSession({ prompt: false });
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!platform.data?.demoControls) return null;

  const setLevel = async (level: RiskLevel) => {
    setBusy(true);
    try {
      await postJson("/api/demo/risk", { level });
      await qc.invalidateQueries({ queryKey: ["risk"] });
      toast({
        title: `Risk set to ${level}`,
        description: "The nav pill updates within a few seconds.",
        tone: level === "HALT" ? "error" : "default",
      });
      setOpen(false);
    } catch (err) {
      toast({ title: "Demo risk not set", description: describeError(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    session.signIn().catch((err: unknown) => toast({ title: "Sign-in failed", description: describeError(err), tone: "error" }));

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Demo controls"
        onClick={() => setOpen((o) => !o)}
        className="h-6 rounded-md border border-warn/40 px-2 text-[11px] text-warn transition-colors hover:bg-warn/10"
      >
        Demo
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-50 w-72 rounded-md border border-border bg-panel p-3 text-[12px] shadow-lg">
          <div className="font-medium">Demo risk controls</div>
          <p className="mt-1 text-[11.5px] text-muted">
            Writes a simulated RiskOracle level to the database. Needs a signed-in session.
          </p>
          {session.signedAddress === null ? (
            <div className="mt-2 flex items-center justify-between gap-2 rounded border border-dashed border-border px-2 py-2 text-[11.5px] text-muted">
              <span>Sign in first.</span>
              <Button size="sm" variant="secondary" onClick={signIn}>
                Sign in
              </Button>
            </div>
          ) : null}
          <div className="mt-2 flex flex-col gap-1.5">
            {ITEMS.map((item) => (
              <button
                key={item.level}
                type="button"
                disabled={busy || session.signedAddress === null}
                onClick={() => setLevel(item.level)}
                className="flex flex-col items-start rounded-md border border-border bg-panel-2 px-2.5 py-2 text-left transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="font-medium">{item.label}</span>
                <span className="text-[11px] text-muted">{item.hint}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
