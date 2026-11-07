import { Badge } from "@/components/ui/badge";
import { IconLock } from "@/components/ui/icons";
import type { TemplateDef } from "@/lib/templates";

/** Public view of the template: name, logic and order types only. Sliders, sources and lessons sit behind the fork paywall (PRD 6.1). */
export function StrategyPanel({ template }: { template: Pick<TemplateDef, "name" | "logic" | "orderTypes"> }) {
  return (
    <div className="flex flex-col gap-4 p-4 pt-3">
      <div>
        <div className="text-base font-medium">{template.name}</div>
        <p className="mt-1 text-sm text-muted">{template.logic}</p>
      </div>
      <div>
        <div className="mb-1.5 text-sm text-muted">Order types it can use</div>
        <div className="flex flex-wrap gap-1.5">
          {template.orderTypes.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-panel-2 px-3 py-2.5 text-sm text-muted">
        <IconLock size={14} className="mt-0.5 shrink-0" />
        <span>The exact settings are private. Copy this agent to get its setup, sliders and lessons.</span>
      </div>
    </div>
  );
}
