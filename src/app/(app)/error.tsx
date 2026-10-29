"use client";

import { Alert, Button } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-16">
      <Alert
        tone="danger"
        title="This page couldn't load"
        action={
          <Button size="sm" variant="outline" onClick={reset}>
            Try again
          </Button>
        }
      >
        Something went wrong while loading your data. If it keeps happening, check that the database is reachable.
        {error.digest && <span className="mt-1 block font-mono text-xs">Reference: {error.digest}</span>}
      </Alert>
    </div>
  );
}
