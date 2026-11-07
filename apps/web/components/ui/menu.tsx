"use client";

import { clsx } from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Small dropdown. The trigger is a button; the panel grows from the trigger (160ms, ease-out), closes on outside click
 * and Escape (focus returns to the trigger), and `children` can be a function to get a `close` callback.
 */
export function Menu({
  trigger,
  label,
  children,
  align = "end",
  width = "w-72",
  triggerClassName,
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  width?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div ref={root} className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "inline-flex h-9 select-none items-center justify-center rounded-lg text-muted transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] hover:bg-panel-2 hover:text-text aria-expanded:bg-panel-2 aria-expanded:text-text",
          triggerClassName ?? "w-9",
        )}
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className={clsx(
            "absolute top-full z-50 mt-2 animate-pop-in overscroll-contain rounded-xl border border-border bg-panel p-1.5 shadow-[var(--shadow-pop)]",
            align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            width,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

/** A row inside <Menu>: title, optional one-line description. */
export function MenuItem({
  title,
  description,
  onClick,
  disabled,
  icon,
}: {
  title: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-panel-2 disabled:opacity-45 disabled:hover:bg-transparent"
    >
      {icon ? <span className="mt-0.5 text-muted">{icon}</span> : null}
      <span className="flex min-w-0 flex-col">
        <span className="text-base font-medium text-text">{title}</span>
        {description ? <span className="text-xs text-muted">{description}</span> : null}
      </span>
    </button>
  );
}
