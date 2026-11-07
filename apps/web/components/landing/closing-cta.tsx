import { CtaLink } from "@/components/landing/cta-link";
import { Container } from "@/components/ui/page-header";

export function ClosingCta() {
  return (
    <section aria-labelledby="closing-title" className="py-14 md:py-20">
      <Container>
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-panel px-6 py-14 text-center shadow-[var(--shadow-card)]">
          <h2 id="closing-title" className="max-w-xl text-3xl font-semibold tracking-[-0.022em] md:text-4xl">
            Start in paper mode
          </h2>
          <p className="max-w-lg text-lg text-muted">
            Real prices, simulated trades and a tiny cap per trade. Create an agent and press Run now to see its first
            decision in seconds.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <CtaLink href="/create" variant="primary">
              Create an agent
            </CtaLink>
            <CtaLink href="/leaderboard" variant="secondary">
              Explore leaderboard
            </CtaLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
