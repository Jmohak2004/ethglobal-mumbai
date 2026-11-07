"use client";

import { clsx } from "clsx";
import type { StrategyConfig, TemplateId } from "@arena/shared";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { ConfigAdvanced, ConfigBasics } from "@/components/create/config-form";
import { SummaryPanel } from "@/components/create/summary-panel";
import { WalletButton } from "@/components/layout/wallet-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { IconArrowRight, IconCheck, IconSliders } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { describeError, postJson, ApiClientError } from "@/lib/api";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";
import { DEFAULT_ASSET_ALLOWLIST, DEMO_OWNER, TEMPLATES, defaultStrategy, validateCreateInput } from "@/lib/templates";

export interface AgentOption {
  id: string;
  name: string;
}

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Strategy" },
  { n: 2, label: "Markets and risk" },
  { n: 3, label: "Review" },
];

/** Guided three-step builder: strategy, markets and risk (with defaults), review. Submits to POST /api/agents (session required). */
export function CreateWizard({ agents, demo }: { agents: AgentOption[]; demo: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { address, isConnected } = useAccount();
  const session = useSession({ prompt: false });
  const platform = usePlatform();
  const liveAvailable = platform.data?.executionMode === "live";
  const allowedAssets = platform.data?.allowedTokens ?? DEFAULT_ASSET_ALLOWLIST;

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<StrategyConfig>(() => defaultStrategy("momentum"));
  const [live, setLive] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // The owner is the signed-in wallet. The demo owner is available outside production via ?owner=1.
  const owner: string | null = session.signedIn && address ? session.address : demo && !isConnected ? DEMO_OWNER : null;
  const usingDemo = owner === DEMO_OWNER && !session.signedIn;

  const check = useMemo(
    () => validateCreateInput({ name, ownerAddress: owner ?? "", config }, allowedAssets),
    [name, owner, config, allowedAssets],
  );
  // The owner check is handled by the sign-in gate below, so drop it from the list.
  const precheckErrors = check.ok ? [] : check.errors.filter((e) => !e.startsWith("ownerAddress"));
  const errors = [...precheckErrors, ...serverErrors];

  const pickTemplate = (id: TemplateId) => {
    // Switching template resets the strategy but keeps the chosen assets where valid.
    setConfig((prev) => ({ ...defaultStrategy(id), assets: prev.assets.length ? prev.assets : ["WETH"] }));
    setServerErrors([]);
  };

  const updateConfig = (c: StrategyConfig) => {
    setConfig(c);
    setServerErrors([]);
  };

  const submit = async () => {
    if (!owner || !check.ok) return;
    setSubmitting(true);
    setServerErrors([]);
    try {
      const res = await postJson<{ id: string; mode: "paper" | "live"; liveRequested: boolean }>("/api/agents", {
        name: name.trim(),
        config,
        live,
        demo: usingDemo,
      });
      const description =
        res.liveRequested && res.mode !== "live"
          ? "Created in paper mode: the server is not in live mode. Fund it to start trading."
          : "Created paused. Fund it to start trading.";
      toast({ title: "Agent created", description, tone: "success" });
      router.push(`/agents/${res.id}`);
    } catch (err) {
      const details = err instanceof ApiClientError ? err.details : [];
      setServerErrors(details.length ? details : [describeError(err)]);
      toast({ title: "Could not create agent", description: describeError(err), tone: "error" });
      setSubmitting(false);
    }
  };

  const needsSignIn = !!isConnected && !session.signedIn && !usingDemo;
  const nameOk = name.trim().length >= 3 && name.trim().length <= 32;
  const tpl = TEMPLATES.find((t) => t.id === config.template);

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="Progress">
        <ol className="flex items-center gap-2 sm:gap-3">
          {STEPS.map((s, i) => {
            const done = step > s.n;
            const active = step === s.n;
            return (
              <li key={s.n} className="flex items-center gap-2 sm:gap-3">
                <button
                  type="button"
                  disabled={s.n > step}
                  onClick={() => setStep(s.n)}
                  aria-current={active ? "step" : undefined}
                  className={clsx(
                    "flex items-center gap-2 rounded-lg py-1 pr-1 text-sm font-medium transition-colors duration-150",
                    active ? "text-text" : done ? "text-text-2 hover:text-text" : "text-muted",
                  )}
                >
                  <span
                    className={clsx(
                      "num grid size-6 place-items-center rounded-full text-xs transition-colors duration-150",
                      active ? "bg-text text-bg" : done ? "bg-long-soft text-long" : "bg-panel-2 text-muted ring-1 ring-inset ring-border",
                    )}
                  >
                    {done ? <IconCheck size={12} strokeWidth={2.5} /> : s.n}
                  </span>
                  <span className={clsx(!active && "hidden sm:inline")}>{s.label}</span>
                </button>
                {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-6 bg-border-strong sm:w-10" /> : null}
              </li>
            );
          })}
        </ol>
      </nav>

      {step === 1 ? (
        <section className="flex flex-col gap-5" aria-labelledby="step1">
          <div>
            <h2 id="step1" className="text-xl font-semibold tracking-[-0.015em]">
              Pick a strategy
            </h2>
            <p className="mt-1 text-base text-muted">This is the style your agent trades in. You can fine-tune it on the next step.</p>
          </div>
          <div role="radiogroup" aria-label="Strategy" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {TEMPLATES.map((t) => {
              const selected = config.template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickTemplate(t.id)}
                  className={clsx(
                    "flex flex-col gap-2 rounded-xl border bg-panel p-4 text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow,background-color] duration-150 ease-out",
                    selected
                      ? "border-accent ring-[3px] ring-accent/15"
                      : "border-border hover:border-border-strong hover:shadow-[var(--shadow-lift)]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-lg font-semibold tracking-[-0.012em]">{t.name}</span>
                    <span
                      aria-hidden
                      className={clsx(
                        "grid size-5 place-items-center rounded-full border transition-colors duration-150",
                        selected ? "border-accent bg-accent text-white" : "border-border-strong",
                      )}
                    >
                      {selected ? <IconCheck size={11} strokeWidth={3} /> : null}
                    </span>
                  </div>
                  <div className="text-base font-medium text-text-2">{t.blurb}</div>
                  <p className="flex-1 text-sm text-muted">{t.logic}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {t.orderTypes.map((o) => (
                      <Badge key={o}>{o}</Badge>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="lg" onClick={() => setStep(2)}>
              Continue
              <IconArrowRight size={15} />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="flex flex-col gap-8" aria-labelledby="step2">
          <div>
            <h2 id="step2" className="text-xl font-semibold tracking-[-0.015em]">
              Markets and risk
            </h2>
            <p className="mt-1 text-base text-muted">
              Your <span className="font-medium text-text-2">{tpl?.name}</span> agent starts with safe defaults. Name it, pick markets, and go.
            </p>
          </div>

          <ConfigBasics config={config} onChange={updateConfig} name={name} onName={(n) => { setName(n); setServerErrors([]); }} assets={allowedAssets} />

          <Disclosure
            title="Advanced settings"
            description="Strategy tuning, more limits, timing, AI model, news sources and forking. Optional."
            right={<IconSliders size={16} className="text-muted" />}
          >
            <ConfigAdvanced
              config={config}
              onChange={updateConfig}
              agents={agents}
              live={live}
              onLive={setLive}
              liveAvailable={liveAvailable}
            />
          </Disclosure>

          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" size="lg" onClick={() => setStep(1)}>
              Back
            </Button>
            <div className="flex items-center gap-3">
              {!nameOk ? <span className="hidden text-sm text-muted sm:inline">Give your agent a name to continue</span> : null}
              <Button variant="primary" size="lg" disabled={!nameOk || config.assets.length === 0} onClick={() => setStep(3)}>
                Review
                <IconArrowRight size={15} />
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="flex flex-col gap-6" aria-labelledby="step3">
          <div>
            <h2 id="step3" className="text-xl font-semibold tracking-[-0.015em]">
              Review and create
            </h2>
            <p className="mt-1 text-base text-muted">
              Your agent is created paused and owned by your wallet. Paper mode by default, so no real money moves.
            </p>
          </div>

          <SummaryPanel
            name={name}
            config={config}
            ownerLabel={owner ? (usingDemo ? "demo owner (?owner=1)" : owner) : null}
            mode={live && liveAvailable ? "live" : "paper"}
            errors={errors}
          />

          {!owner && !isConnected ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-panel-2 px-4 py-3 text-base">
              <span className="flex-1 text-text-2">Connect a wallet to create your agent. (Or add ?owner=1 to try the demo owner.)</span>
              <WalletButton />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" size="lg" onClick={() => setStep(2)}>
              Back
            </Button>
            {needsSignIn ? (
              <Button
                variant="accent"
                size="lg"
                onClick={() =>
                  session.signIn().catch((e) => toast({ title: "Sign-in failed", description: describeError(e), tone: "error" }))
                }
              >
                Sign in with your wallet
              </Button>
            ) : (
              <Button variant="primary" size="lg" disabled={!owner || !check.ok || submitting} onClick={submit}>
                {submitting ? "Creating…" : "Create agent"}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            The trading wallet and onchain registration are set up after creation, so funding and forking wait for that step.
          </p>
        </section>
      ) : null}
    </div>
  );
}
