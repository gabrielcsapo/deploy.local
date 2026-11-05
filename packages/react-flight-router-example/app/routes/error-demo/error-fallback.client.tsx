"use client";

import { Link } from "react-flight-router/client";

export default function ErrorFallback({ error }: { error?: Error }) {
  return (
    <div data-testid="error-fallback" className="rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="text-xl font-semibold text-red-800 mb-2">Something went wrong</h2>
      <p className="text-red-600 mb-4">{error?.message ?? "An unexpected error occurred."}</p>
      <Link to="/error-with-component" className="text-blue-600 hover:underline">
        ← Back to error demo
      </Link>
    </div>
  );
}
