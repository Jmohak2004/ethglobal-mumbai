import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Bordered section with a small uppercase title bar. */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx("flex min-w-0 flex-col rounded-md border border-border bg-panel", className)}>
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted">{title}</h2>
        {right}
      </header>
      <div className={clsx("min-w-0", bodyClassName)}>{children}</div>
    </section>
  );
}
