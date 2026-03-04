import { ClientCounter } from "shared-ui/client-counter";

export default function SharedUIPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4" data-testid="shared-ui-heading">
        Shared UI
      </h1>
      <p className="text-gray-600 mb-6">
        This page renders a &quot;use client&quot; component from a sibling workspace package.
      </p>
      <ClientCounter label="Shared counter" />
    </div>
  );
}
