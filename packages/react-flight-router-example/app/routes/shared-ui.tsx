import { ClientCounter } from "shared-ui/client-counter";

export default function SharedUIPage() {
  return (
    <div>
      <h1>Shared UI</h1>
      <p>This page renders a &quot;use client&quot; component from a sibling workspace package.</p>
      <ClientCounter label="Shared counter" />
    </div>
  );
}
