import { Badge } from "@/components/ui/badge";
import type { TemplateDef } from "@/lib/templates";

/** Public view of the template. Sliders, sources and lessons sit behind the fork paywall (PRD 6.1). */
export function StrategyPanel({ template }: { template: TemplateDef }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <div className="text-[13px] font-medium">{template.name}</div>
        <div className="mt-1 text-[12px] text-muted">{template.logic}</div>
      </div>
      <div className="flex flex-wrap gap-1">
        {template.orderTypes.map((t) => (
          <Badge key={t} tone="neutral">
            {t}
          </Badge>
        ))}
      </div>
      <div className="rounded border border-dashed border-border px-3 py-2 text-[12px] text-muted">
        Config is hidden. Fork this agent to copy its setup, sliders, sources and lessons.
      </div>
    </div>
  );
}
