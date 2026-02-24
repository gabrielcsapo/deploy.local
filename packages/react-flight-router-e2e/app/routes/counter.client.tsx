'use client';

import { useState, useActionState } from 'react';
import { addMessage } from './actions.js';

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p className="mb-2">Count: {count}</p>
      <button
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
        onClick={() => setCount((c) => c + 1)}
      >
        Increment
      </button>
    </div>
  );
}

export function MessageBoard() {
  const [messages, formAction, isPending] = useActionState(addMessage, []);

  return (
    <div className="border border-gray-200 rounded-lg p-6 bg-white">
      <h2 className="text-xl font-semibold mb-3">Server Action Demo</h2>
      <form action={formAction}>
        <div className="flex gap-2 items-center">
          <input
            name="text"
            placeholder="Enter a message"
            className="px-3 py-2 border border-gray-300 rounded text-base"
          />
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            {isPending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>

      {messages.length > 0 && (
        <>
          <h2 className="text-xl font-semibold mt-4 mb-2">Messages</h2>
          <ul className="list-disc pl-5 space-y-1">
            {messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
