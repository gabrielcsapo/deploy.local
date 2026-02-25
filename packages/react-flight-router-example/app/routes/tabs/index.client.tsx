"use client";

import { useState } from "react";

export function TabsOverviewClient() {
  const [count, setCount] = useState(0);

  return (
    <div className="mt-4 p-4 bg-blue-50 rounded" data-testid="tabs-overview-interactive">
      <p className="text-sm font-medium text-blue-800 mb-2">Interactive Section</p>
      <p className="text-sm text-blue-700" data-testid="tabs-overview-count">
        Count: {count}
      </p>
      <button
        onClick={() => setCount((c) => c + 1)}
        className="mt-2 px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        data-testid="tabs-overview-increment"
      >
        Increment
      </button>
    </div>
  );
}
