import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function AgentLoading() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true" aria-label="Loading agent">
      <div className="flex flex-col gap-2 border-b border-border pb-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-3 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
      <Skeleton className="h-72" />
      <SkeletonRows rows={6} />
    </div>
  );
}
