"use client";

import { useToast } from "@/components/ui/toast";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={`${label} ${value}`}
      title={`${label}: ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast({ title: "Copied", description: value.length > 40 ? `${value.slice(0, 20)}…` : value, tone: "success" });
        } catch {
          toast({ title: "Copy failed", tone: "error" });
        }
      }}
      className="inline-flex h-5 items-center rounded px-1.5 text-[11px] text-muted hover:bg-panel-2 hover:text-text"
    >
      {label}
    </button>
  );
}
