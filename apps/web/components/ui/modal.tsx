"use client";

import { clsx } from "clsx";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconX } from "@/components/ui/icons";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Dialog with a focus trap, Escape to close, scroll lock, and focus restored to the trigger on close. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the first control, or the dialog itself.
    const first = panel.current?.querySelector<HTMLElement>(`[data-autofocus],${FOCUSABLE}`);
    (first ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 animate-fade-in bg-text/30 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          "relative flex max-h-[90dvh] w-full animate-dialog-in flex-col rounded-t-2xl border border-border bg-panel shadow-[var(--shadow-pop)] focus:outline-none sm:rounded-2xl",
          width,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-[-0.012em]">
              {title}
            </h2>
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-text"
          >
            <IconX size={16} />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain p-5 pt-3">{children}</div>
      </div>
    </div>
  );
}
