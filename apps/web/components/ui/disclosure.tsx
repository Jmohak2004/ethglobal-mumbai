"use client";

import { clsx } from "clsx";
import { useId, useState, type ReactNode } from "react";

import { IconChevronDown } from "@/components/ui/icons";

/**
 * Collapsible card section for progressive disclosure. Title, a one-line "what is this?" description that is always
 * visible, and a body that mounts only when opened.
 */
export function Disclosure({
  title,
  description,
  right,
  defaultOpen = false,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={clsx("min-w-0 rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]", className)}>
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors duration-100 hover:bg-panel-2/60"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base font-semibold tracking-[-0.012em] text-text">{title}</span>
            {description ? <span className="text-sm font-normal text-muted">{description}</span> : null}
          </span>
          {right}
          <IconChevronDown
            size={16}
            className={clsx("shrink-0 text-muted transition-transform duration-200 ease-out", open && "rotate-180")}
          />
        </button>
      </h3>
      {open ? (
        <div id={id} className="min-w-0 animate-fade-in border-t border-border">
          {children}
        </div>
      ) : null}
    </section>
  );
}
