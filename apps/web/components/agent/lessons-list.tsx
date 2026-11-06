import type { Lesson } from "@arena/shared";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { fmtPct, shortHash } from "@/lib/format";

/** Reflection-loop lessons. Each carries its 0G Storage root (memory proof). */
export function LessonsList({ lessons }: { lessons: Lesson[] }) {
  if (lessons.length === 0) {
    return <div className="px-3 py-3 text-[12px] text-muted">No lessons yet. Reflection runs after each close and daily.</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {lessons.map((l) => (
        <li key={l.id} className="flex flex-col gap-1.5 px-3 py-2.5">
          <div className="text-[12.5px] text-text">{l.lesson}</div>
          <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            <span>confidence {fmtPct(l.confidence * 100, 0)}</span>
            <span>{l.evidenceEpisodeIds.length} evidence episodes</span>
            <span className="flex items-center gap-1">
              {l.appliesTo.map((a) => (
                <Badge key={a}>{a}</Badge>
              ))}
            </span>
            {l.zgStorageRoot ? (
              <span className="inline-flex items-center gap-1">
                0G root <span className="text-text">{shortHash(l.zgStorageRoot)}</span>
                <CopyButton value={l.zgStorageRoot} label="Copy root" />
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
