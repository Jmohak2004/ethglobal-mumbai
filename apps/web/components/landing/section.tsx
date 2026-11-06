import { clsx } from "clsx";
import type { ReactNode } from "react";

/**
 * Landing section: an anchor target (scroll-mt-16 clears the sticky top nav), with an eyebrow, a heading and a lede.
 */
export function LandingSection({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-16 border-t border-border px-4 py-10 md:px-8 md:py-12">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          {eyebrow ? <p className="text-[10.5px] font-medium uppercase tracking-wider text-accent">{eyebrow}</p> : null}
          <h2 id={titleId} className="text-[22px] font-semibold tracking-tight md:text-[26px]">
            {title}
          </h2>
          {lede ? <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">{lede}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
