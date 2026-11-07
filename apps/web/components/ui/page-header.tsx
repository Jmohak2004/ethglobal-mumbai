import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Page width and padding. One container for every page so edges line up with the nav. */
export function Container({
  children,
  className,
  wide,
  narrow,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
  narrow?: boolean;
}) {
  return (
    <div className={clsx("mx-auto w-full px-4 sm:px-6", wide ? "max-w-[1200px]" : narrow ? "max-w-[860px]" : "max-w-[1080px]", className)}>
      {children}
    </div>
  );
}

/** Page title, one plain sentence explaining the page, and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={clsx("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">{title}</h1>
        {description ? <p className="max-w-xl text-base text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
