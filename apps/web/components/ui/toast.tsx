"use client";

import { clsx } from "clsx";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Tone = "default" | "success" | "error";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastInput {
  title: string;
  description?: string;
  tone?: Tone;
}

type ToastFn = (t: ToastInput) => void;

const ToastCtx = createContext<ToastFn | null>(null);
let nextId = 1;

/** Minimal toast system: call useToast()(...) anywhere under <ToastProvider>. Auto-dismisses after 4s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastFn>((t) => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, title: t.title, description: t.description, tone: t.tone ?? "default" }]);
    window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 4000);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={clsx(
              "pointer-events-auto rounded-md border bg-panel-2 px-3 py-2 text-[12px]",
              item.tone === "error" && "border-short/60",
              item.tone === "success" && "border-long/60",
              item.tone === "default" && "border-border",
            )}
          >
            <div
              className={clsx(
                "font-medium",
                item.tone === "error" && "text-short",
                item.tone === "success" && "text-long",
              )}
            >
              {item.title}
            </div>
            {item.description ? <div className="mt-0.5 text-muted">{item.description}</div> : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastFn {
  const fn = useContext(ToastCtx);
  if (!fn) throw new Error("useToast must be used inside <ToastProvider>");
  return fn;
}
