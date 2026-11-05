"use client";

import { useActionState } from "react";
import { slowAction } from "./slow-action.js";

interface ActionResult {
  completedAt: number;
  delayMs: number;
  threadType: string;
  userAgent: string;
}

export default function ActionForm() {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    slowAction as any,
    null,
  );

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex gap-3 items-end">
        <div>
          <label htmlFor="delay" className="block text-sm font-medium text-gray-700 mb-1">
            Delay (ms)
          </label>
          <input
            id="delay"
            name="delay"
            type="number"
            defaultValue={1000}
            min={0}
            max={10000}
            className="border border-gray-300 rounded px-3 py-2 w-32"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? "Running..." : "Submit Action"}
        </button>
      </form>

      {state && (
        <div className="bg-gray-100 rounded p-4 space-y-1" data-testid="action-result">
          <p>
            <strong>Completed at:</strong>{" "}
            <span data-testid="completed-at">{new Date(state.completedAt).toISOString()}</span>
          </p>
          <p>
            <strong>Delay:</strong> <span data-testid="delay-ms">{state.delayMs}ms</span>
          </p>
          <p>
            <strong>Thread:</strong> <span data-testid="thread-type">{state.threadType}</span>
          </p>
          <p>
            <strong>User-Agent:</strong> <span data-testid="user-agent">{state.userAgent}</span>
          </p>
        </div>
      )}
    </div>
  );
}
