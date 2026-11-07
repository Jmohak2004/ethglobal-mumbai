import { clsx } from "clsx";
import type { ReactNode } from "react";

import { Container } from "@/components/ui/page-header";

/**
 * Landing section: an anchor target with a small eyebrow, a heading and a one-sentence lede. Generous vertical space,
 * no divider lines between sections (whitespace does that job).
 */
export function LandingSection({
  id,
  eyebrow,
  title,
  lede,
  children,
  className,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  lede?: string;
  children: ReactNode;
  className?: string;
}) {
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className={clsx("py-12 md:py-16", className)}>
      <Container>
        <header className="mb-8 flex max-w-2xl flex-col gap-2 md:mb-10">
          {eyebrow ? <p className="text-sm font-medium text-accent-fg">{eyebrow}</p> : null}
          <h2 id={titleId} className="text-2xl font-semibold tracking-[-0.022em] md:text-3xl">
            {title}
          </h2>
          {lede ? <p className="text-lg text-muted">{lede}</p> : null}
        </header>
        <div className="flex flex-col gap-6">{children}</div>
      </Container>
    </section>
  );
}
