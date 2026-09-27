"use client";

import { ErrorAlert } from "@/components/common/error-alert";
import { toClientError } from "@/lib/errors";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-lg py-12">
      <ErrorAlert
        title="This page hit a problem"
        message={toClientError(error).message}
        onRetry={reset}
        retryLabel="Reload"
      />
    </div>
  );
}
