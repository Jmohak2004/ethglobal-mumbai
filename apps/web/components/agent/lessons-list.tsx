import type { Lesson } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { fmtPct, shortHash } from "@/lib/format";

/** Reflection-loop lessons. Each carries its 0G Storage root (memory proof). */
export function LessonsList({ lessons }: { lessons: Lesson[] }) {
  if (lessons.length === 0) {
    return <div className="px-4 py-4 text-sm text-muted">No lessons yet. The agent reflects after each closed trade and once a day, then saves what it learned here.</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {lessons.map((l) => (
        <li key={l.id} className="flex flex-col gap-1.5 px-4 py-3">
          <div className="text-base text-text">{l.lesson}</div>
          <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>Confidence {fmtPct(l.confidence * 100, 0)}</span>
            <span>{l.evidenceEpisodeIds.length} supporting decisions</span>
            <span className="flex items-center gap-1">
              {l.appliesTo.map((a) => (
                <Badge key={a}>{a}</Badge>
              ))}
            </span>
            {l.zgStorageRoot ? (
              <span className="inline-flex items-center gap-1">
                0G proof <span className="text-text">{shortHash(l.zgStorageRoot)}</span>
                <CopyButton value={l.zgStorageRoot} label="Copy proof" />
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
