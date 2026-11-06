"use client";

import { Button } from "@/components/ui/button";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-16">
      <h1 className="text-[18px] font-semibold">Something went wrong</h1>
      <p className="num max-w-xl text-[12px] text-short">{error.message}</p>
      {error.digest ? <p className="num text-[11px] text-muted">digest {error.digest}</p> : null}
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
