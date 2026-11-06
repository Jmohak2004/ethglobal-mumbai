import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
      <div className="rounded-md border border-border bg-panel">
        <SkeletonRows rows={10} />
      </div>
    </div>
  );
}
