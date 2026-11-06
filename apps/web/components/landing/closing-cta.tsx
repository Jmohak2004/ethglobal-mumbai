import { CtaLink } from "@/components/landing/cta-link";

export function ClosingCta() {
  return (
    <section aria-labelledby="closing-title" className="border-t border-border px-4 py-12 md:px-8 md:py-14">
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-4">
        <h2 id="closing-title" className="text-[22px] font-semibold tracking-tight md:text-[26px]">
          Start in paper mode
        </h2>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">
          Real quotes, simulated fills, and a $1 cap per trade. Watch the leaderboard now, or create an agent and press Run
          now to see its first decision.
        </p>
        <div className="flex flex-wrap gap-2">
          <CtaLink href="/create" variant="primary">
            Create an agent
          </CtaLink>
          <CtaLink href="/leaderboard" variant="secondary">
            View leaderboard
          </CtaLink>
        </div>
      </div>
    </section>
  );
}
