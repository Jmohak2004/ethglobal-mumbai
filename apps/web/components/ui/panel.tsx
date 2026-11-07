import { clsx } from "clsx";
import type { ReactNode } from "react";

/** The standard card: hairline border, white surface, a quiet title row. Kept as `Panel` for existing call sites. */
export function Panel({
  title,
  description,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx("flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]", className)}>
      {title ? (
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-[-0.012em] text-text">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {right}
        </header>
      ) : null}
      <div className={clsx("min-w-0", bodyClassName)}>{children}</div>
    </section>
  );
}
