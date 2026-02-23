'use client';

import { useState, useActionState } from 'react';
import { addMessage } from './actions.js';

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}

export function MessageBoard() {
  const [messages, formAction, isPending] = useActionState(addMessage, []);

  return (
    <div className="card">
      <h2>Server Action Demo</h2>
      <form action={formAction}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input name="text" placeholder="Enter a message" />
          <button type="submit" disabled={isPending}>
            {isPending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>

      {messages.length > 0 && (
        <>
          <h2>Messages</h2>
          <ul>
            {messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
