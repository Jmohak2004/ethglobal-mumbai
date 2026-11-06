"use client";

import { clsx } from "clsx";
import type { StrategyConfig, TemplateId } from "@arena/shared";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { ConfigForm } from "@/components/create/config-form";
import { SummaryPanel } from "@/components/create/summary-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useToast } from "@/components/ui/toast";
import { postJson } from "@/lib/api";
import { DEMO_OWNER, TEMPLATES, defaultStrategy, validateCreateInput } from "@/lib/templates";

export interface AgentOption {
  id: string;
  name: string;
}

/** Two-step builder: pick a template, then tune sliders and limits. Submits to POST /api/agents. */
export function CreateWizard({ agents, demo }: { agents: AgentOption[]; demo: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { address, isConnected } = useAccount();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<StrategyConfig>(() => defaultStrategy("momentum"));
  const [submitting, setSubmitting] = useState(false);

  const owner: string | null = isConnected && address ? address : demo ? DEMO_OWNER : null;

  const check = useMemo(
    () => validateCreateInput({ name, ownerAddress: owner ?? "", config }),
    [name, owner, config],
  );
  // The owner check is handled by the connect gate below, so drop it from the list.
  const configErrors = check.ok ? [] : check.errors.filter((e) => !e.startsWith("ownerAddress"));

  const pickTemplate = (id: TemplateId) => {
    // Switching template resets the strategy but keeps the name and the chosen assets where valid.
    setConfig((prev) => ({ ...defaultStrategy(id), assets: prev.assets.length ? prev.assets : ["WETH"] }));
  };

  const submit = async () => {
    if (!owner || !check.ok) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ id: string }>("/api/agents", { name: name.trim(), config, ownerAddress: owner });
      toast({ title: "Agent created", description: "Fund it to start trading. It starts paused.", tone: "success" });
      router.push(`/agents/${res.id}`);
    } catch (err) {
      toast({ title: "Could not create agent", description: (err as Error).message, tone: "error" });
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px]">
          <StepDot n={1} active={step === 1} done={step > 1} label="Template" />
          <span className="text-muted">→</span>
          <StepDot n={2} active={step === 2} done={false} label="Configure" />
        </div>
        {step === 2 ? (
          <Button variant="ghost" onClick={() => setStep(1)}>
            Change template
          </Button>
        ) : null}
      </div>

      {step === 1 ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {TEMPLATES.map((t) => {
              const selected = config.template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pickTemplate(t.id)}
                  className={clsx(
                    "flex flex-col gap-2 rounded-md border bg-panel p-3 text-left transition-colors hover:bg-panel-2",
                    selected ? "border-long" : "border-border",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-semibold">{t.name}</span>
                    <span className="num text-[11px] text-muted">{t.sliders.length} sliders</span>
                  </div>
                  <div className="text-[12px]">{t.blurb}</div>
                  <div className="text-[11.5px] text-muted">{t.logic}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {t.orderTypes.map((o) => (
                      <Badge key={o}>{o}</Badge>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-[1fr_380px]">
          <div className="flex min-w-0 flex-col gap-3">
            <ConfigForm config={config} onChange={setConfig} name={name} onName={setName} agents={agents} />
          </div>

          <div className="flex flex-col gap-3 xl:sticky xl:top-16">
            <Panel title="Summary">
              <SummaryPanel
                name={name}
                config={config}
                ownerLabel={owner ? (demo && !isConnected ? "demo owner (?owner=1)" : owner) : null}
                errors={configErrors}
              />
            </Panel>
            <div className="flex flex-col gap-2">
              {!owner ? (
                <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                  Connect a wallet to create an agent. Or add ?owner=1 for the demo owner.
                </div>
              ) : null}
              <Button
                variant="long"
                className="h-9 w-full text-[13px]"
                disabled={!owner || !check.ok || submitting}
                onClick={submit}
              >
                {submitting ? "Creating…" : "Create agent"}
              </Button>
              <p className="text-[11px] text-muted">
                Creating provisions a server wallet and a 0G key, registers the agent onchain, then you fund it with a few USDC.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepDot({ n, active, done, label }: { n: number; active: boolean; done: boolean; label: string }) {
  return (
    <span className={clsx("flex items-center gap-1.5", active ? "text-text" : "text-muted")}>
      <span
        className={clsx(
          "num grid size-5 place-items-center rounded-full border text-[11px]",
          active ? "border-long text-long" : done ? "border-long/60 bg-long/10 text-long" : "border-border",
        )}
      >
        {n}
      </span>
      {label}
    </span>
  );
}
