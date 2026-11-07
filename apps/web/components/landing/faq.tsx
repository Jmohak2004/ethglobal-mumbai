import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import { IconChevronDown } from "@/components/ui/icons";

const QA = [
  {
    q: "Is this real money?",
    a: "Not by default. Agents and manual trades run in paper mode: real prices, simulated fills, nothing sent. Live trading needs the server set to live, and then the Run live switch appears when you create an agent.",
  },
  {
    q: "What does an agent cost?",
    a: "A paper agent is free. A live agent holds a small USDC allocation, up to $5 in this build. Its AI calls are paid from its own 0G credit, which it tops up from commission.",
  },
  {
    q: "How is performance verified?",
    a: "Chainlink CRE reads each agent's filled trades and real prices, works out profit and the other stats, and signs a report onchain. Agents with a report show a Verified badge.",
  },
  {
    q: "What happens in a crash?",
    a: "The market safety light turns to Trading paused. Agents stop opening new buys and cancel pending entries, then, as their owner chose, tighten stop-losses or sell everything to USDC. When it is Market shaky, trade size is halved.",
  },
  {
    q: "Can I lose more than I put in?",
    a: "No. There is no leverage. Agents swap tokens, so the most they can lose is what they hold, and caps on trade size and daily loss limit how fast that can happen.",
  },
  {
    q: "What is forking?",
    a: "Forking pays an agent's creator a one-time USDC fee to copy its setup. Your copy starts paused, in paper mode, under your wallet. The Fork button shows Contracts not deployed until the marketplace contract is live.",
  },
  {
    q: "How do agents pay for themselves?",
    a: "An agent earns commission on new profit highs, 10% by default. That goes to a treasury and is converted to 0G credit for its AI. The paper build simulates this loop in a practice ledger.",
  },
  {
    q: "Do I need crypto to try it?",
    a: "No funds are needed. You can read the leaderboard and agent pages without a wallet. Creating an agent or trading needs a wallet connection and a free sign-in, and paper mode needs no USDC.",
  },
];

export function Faq() {
  return (
    <LandingSection id="faq" eyebrow="FAQ" title="Questions people ask first">
      <Card className="mx-auto w-full max-w-3xl divide-y divide-border">
        {QA.map((item) => (
          <details key={item.q} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-5 py-4 text-base font-medium marker:content-none hover:bg-panel-2/50 [&::-webkit-details-marker]:hidden">
              {item.q}
              <IconChevronDown size={16} className="shrink-0 text-muted transition-transform duration-200 ease-out group-open:rotate-180" />
            </summary>
            <p className="px-5 pb-5 text-base text-muted">{item.a}</p>
          </details>
        ))}
      </Card>
    </LandingSection>
  );
}
