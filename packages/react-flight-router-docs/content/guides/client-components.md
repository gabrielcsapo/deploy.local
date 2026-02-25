---
title: "Client Components"
description: "Add interactivity with client components using the 'use client' directive. Use React hooks, handle events, and compose client and server components together."
---

# Client Components

By default, all components in Flight Router are React Server Components -- they run on the server, have no bundle cost, and can use `async`/`await` for data fetching. When you need interactivity (state, effects, event handlers, browser APIs), mark a file with the `"use client"` directive to make it a client component.

## The "use client" directive

Add `"use client"` as the very first line of a file to mark all exports in that file as client components:

```tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
```

The directive applies to the entire file. Every component exported from a `"use client"` file is a client component.

## Naming convention

While not strictly required, using the `.client.tsx` suffix for client component files makes it easy to identify them at a glance:

```
app/routes/
  counter.client.tsx      # client component
  home.tsx                # server component
  posts/
    detail.tsx            # server component
    post-interactions.client.tsx  # client component
```

This convention is recommended but optional -- the `"use client"` directive is what actually determines the component type.

## Importing client components from server components

Server components can import and render client components. Props passed from server to client components are serialized across the server-client boundary:

```tsx
// app/routes/about.tsx (server component)
import { Counter } from "./counter.client.js";

export default function AboutPage() {
  return (
    <main>
      <h1>About</h1>
      <p>Server rendered at {new Date().toISOString()}</p>

      {/* Client component rendered inside a server component */}
      <Counter />
    </main>
  );
}
```

The static parts of the page (heading, paragraph, timestamp) are rendered on the server. The `Counter` component is sent to the client as a reference, and the client loads and renders it with full interactivity.

## Using React hooks

Client components have access to all React hooks:

```tsx
"use client";

import { useState, useEffect } from "react";

export function Clock() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return <p>Current time: {time.toLocaleTimeString()}</p>;
}
```

## Forms with controlled inputs

Client components are the right place for interactive forms with controlled inputs and client-side validation:

```tsx
"use client";

import { useState } from "react";

export function SearchForm({ onSearch }: { onSearch?: (query: string) => void }) {
  const [query, setQuery] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch?.(query);
      }}
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
      />
      <button type="submit">Search</button>
    </form>
  );
}
```

## Passing props across the boundary

Props from server to client components must be serializable. You can pass:

- Strings, numbers, booleans, null, undefined
- Plain objects and arrays (containing serializable values)
- Dates
- Server Action functions (see the Server Actions guide)
- React elements (JSX)

You **cannot** pass:

- Functions (except Server Actions)
- Class instances
- Symbols
- DOM nodes

```tsx
// Server component passes data to client component
import { LikeButton } from "./post-interactions.client.js";

export default async function PostPage({ params }: { params: Record<string, string> }) {
  const res = await fetch(`https://api.example.com/posts/${params.id}`);
  const post = await res.json();

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      {/* postId is serialized across the boundary */}
      <LikeButton postId={post.id} />
    </article>
  );
}
```

## SSR behavior

Client components are rendered during server-side rendering (SSR) in addition to running on the client. This means:

- The initial HTML includes the rendered output of client components.
- The page is visible before JavaScript loads.
- Once JavaScript loads, React hydrates the client components to make them interactive.

Be mindful of code that accesses browser-only APIs (like `window` or `localStorage`). Guard those calls inside `useEffect` or check for the browser environment:

```tsx
"use client";

import { useState, useEffect } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    // Safe to access localStorage here -- only runs in the browser
    const saved = localStorage.getItem("theme");
    if (saved) setTheme(saved);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("theme", next);
  };

  return <button onClick={toggle}>Theme: {theme}</button>;
}
```

## When to use client vs server components

| Use case                                    | Component type   |
| ------------------------------------------- | ---------------- |
| Fetching data from APIs/databases           | Server component |
| Reading environment variables               | Server component |
| Static content, markup                      | Server component |
| Interactive UI (clicks, inputs)             | Client component |
| React hooks (`useState`, `useEffect`, etc.) | Client component |
| Browser APIs (`localStorage`, `window`)     | Client component |
| Event handlers (`onClick`, `onChange`)      | Client component |
| Third-party UI libraries with state         | Client component |

**Default to server components.** Only reach for `"use client"` when you need interactivity or browser APIs. This keeps your JavaScript bundle small and your data fetching on the server where it is fastest.
