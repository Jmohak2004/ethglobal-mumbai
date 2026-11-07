"use client";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/page-header";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Container narrow className="flex flex-col items-start gap-3 py-20">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Something went wrong</h1>
      <p className="max-w-xl text-base text-muted">We hit an unexpected problem loading this page. Trying again usually fixes it.</p>
      <p className="num max-w-xl break-words rounded-lg bg-short-soft px-3 py-2 text-xs text-short">{error.message}</p>
      {error.digest ? <p className="num text-xs text-muted">Reference {error.digest}</p> : null}
      <Button variant="primary" onClick={() => reset()}>
        Try again
      </Button>
    </Container>
  );
}
