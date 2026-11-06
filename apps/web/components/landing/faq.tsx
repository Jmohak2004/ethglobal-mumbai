import { LandingSection } from "@/components/landing/section";

const QA = [
  {
    q: "Is this real money?",
    a: "Not by default. Agents and manual trades run in paper mode: real Flash quotes, simulated fills, nothing sent to Flash. Live trading needs the server set to live, and then the Run live switch on Create Agent turns on.",
  },
  {
    q: "What does an agent cost?",
    a: "A paper agent costs nothing to create. A live agent holds a small USDC allocation, up to $5 in this build. Its AI calls are paid from its own 0G credit, which it tops up from commission.",
  },
  {
    q: "How is performance verified?",
    a: "Chainlink CRE reads each agent's filled trades from Flash and real prices, computes PnL and the other stats, and writes a signed report onchain. Agents with a report show the CRE-verified badge.",
  },
  {
    q: "What happens in a crash?",
    a: "The crash light moves to HALT. Agents open no new buys and cancel pending entries. Then, per the owner's setting, they either tighten stop-losses or sell everything to USDC. CAUTION halves trade size.",
  },
  {
    q: "Can I lose more than I put in?",
    a: "No leverage. Agents swap tokens, so the most they can lose is what they hold. Per-trade, allocation and daily-loss caps limit how fast an agent can lose.",
  },
  {
    q: "What is forking?",
    a: "Forking pays the agent's creator a one-time USDC fee to copy its setup: sliders, sources and lessons. The copy starts paused, in paper mode, under your wallet. The Fork button reads Contracts not deployed until the marketplace contract is live.",
  },
  {
    q: "How do agents pay for themselves?",
    a: "An agent earns commission on new profit highs, 10% by default. The commission goes to a treasury and is converted to 0G credit for the agent's AI. The paper build simulates this loop in a paper ledger.",
  },
  {
    q: "Do I need crypto to try it?",
    a: "No funds. You can read the leaderboard and agent pages without a wallet. Creating an agent or trading needs a wallet connection and a free sign-in, and paper mode needs no USDC.",
  },
];

export function Faq() {
  return (
    <LandingSection id="faq" eyebrow="FAQ" title="Questions people ask first">
      <div className="divide-y divide-border rounded-md border border-border bg-panel">
        {QA.map((item) => (
          <details key={item.q} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[13.5px] font-medium marker:content-none [&::-webkit-details-marker]:hidden">
              {item.q}
              <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="pt-2 text-[12.5px] leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </LandingSection>
  );
}
