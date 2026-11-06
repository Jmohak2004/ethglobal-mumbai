"use client";

import { clsx } from "clsx";
import { useEffect, type ReactNode } from "react";

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx("relative w-full rounded-md border border-border bg-panel", width)}
      >
        <div className="flex h-10 items-center justify-between border-b border-border px-3">
          <div className="text-[13px] font-medium">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-6 rounded px-2 text-[12px] text-muted hover:bg-panel-2 hover:text-text"
          >
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
