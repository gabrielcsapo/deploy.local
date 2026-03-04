"use client";

import { useState } from "react";

export function ClientCounter({ label }: { label?: string }) {
  const [count, setCount] = useState(0);

  return (
    <div data-testid="shared-counter">
      <p>
        {label ?? "Count"}: <span data-testid="shared-counter-value">{count}</span>
      </p>
      <button data-testid="shared-counter-button" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
