import type { Episode } from "@arena/shared";

/** Every policy reject is a guardrail block the owner can see (PRD 6.3 step 5). */
export function GuardrailList({ episodes }: { episodes: Episode[] }) {
  const blocks = episodes.filter((e) => e.verdict.kind === "reject");
  if (blocks.length === 0) {
    return (
      <div className="px-4 py-4 text-sm text-muted">
        Nothing was blocked in the last {episodes.length} decisions. When a safety rule stops a trade, it shows up here with the reason.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {blocks.map((e) => {
        const reasons = e.verdict.kind === "approve" ? [] : e.verdict.reasons;
        return (
          <li key={e.id} className="flex items-start gap-3 px-4 py-3">
            <span className="num w-24 shrink-0 text-xs text-muted">
              {new Date(e.ts).toISOString().slice(5, 16).replace("T", " ")}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-base text-text">
                {e.decision?.proposal.action ?? "proposal"}
                {e.decision?.proposal.asset ? ` ${e.decision.proposal.asset}` : ""}
              </div>
              <div className="text-sm text-short">{reasons.join("; ")}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
