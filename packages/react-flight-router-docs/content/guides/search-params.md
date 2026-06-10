---
title: "Search Params"
description: "Read and write URL query parameters using the useSearchParams hook for filters, pagination, and search state."
---

# Search Params

The `useSearchParams` hook provides a way to read and write URL query parameters from client components. This is essential for features like filters, pagination, search, and sort state that should be reflected in the URL.

## Basic usage

Import `useSearchParams` from `"react-flight-router/client"`. It returns a `[searchParams, setSearchParams]` tuple, similar to `useState`.

```tsx
"use client";

import { useSearchParams } from "react-flight-router/client";

export function FilterBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const category = searchParams.get("category") ?? "all";

  return (
    <select
      value={category}
      onChange={(e) => {
        const next = new URLSearchParams(searchParams);
        next.set("category", e.target.value);
        setSearchParams(next);
      }}
    >
      <option value="all">All</option>
      <option value="tech">Tech</option>
      <option value="design">Design</option>
    </select>
  );
}
```

## API

```ts
function useSearchParams(): [URLSearchParams, setSearchParams];

type setSearchParams = (
  next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
) => void;
```

| Return            | Type              | Description                                                                                 |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `searchParams`    | `URLSearchParams` | The current URL search parameters, parsed from the router's URL state.                      |
| `setSearchParams` | `Function`        | Updates the search params and triggers a client navigation. Uses `replaceState` by default. |

The `setSearchParams` function accepts either:

- A `URLSearchParams` instance with the new values.
- An updater function that receives the current params and returns new params.

## Updater function

Use the function form when you need to read the current params before updating:

```tsx
"use client";

import { useSearchParams } from "react-flight-router/client";

export function Pagination() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get("page") ?? "1");

  return (
    <div>
      <span>Page {page}</span>
      <button
        onClick={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("page", String(page + 1));
            return next;
          })
        }
      >
        Next
      </button>
    </div>
  );
}
```

## Server components

The `useSearchParams` hook is client-only. Server route components receive search params directly as a `searchParams` prop — a plain object of the URL's query parameters:

```tsx
// app/routes/posts/index.tsx (server component)
export default async function PostsList({
  searchParams,
}: {
  searchParams?: Record<string, string>;
}) {
  const category = searchParams?.category ?? "all";
  const page = Number(searchParams?.page ?? "1");

  const posts = await fetch(`https://api.example.com/posts?category=${category}&page=${page}`).then(
    (r) => r.json(),
  );

  return (
    <div>
      <h1>Posts ({category})</h1>
      {posts.map((post: any) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
        </article>
      ))}
    </div>
  );
}
```

Two things to know about the prop's shape:

- **Slot params are excluded.** Parallel-route params (`?@modal=/photo/2`) drive the slot machinery and never appear in `searchParams` — so opening or closing a modal doesn't change the prop, matching the renderer's decision not to re-render the main tree for slot-only changes.
- **Duplicate keys collapse last-wins.** `?tag=a&tag=b` yields `{ tag: "b" }`.

For multi-value params, or anywhere outside a route component (server actions, shared libs), read the raw URL via `getRequest()` from `react-flight-router/server`:

```tsx
import { getRequest } from "react-flight-router/server";

const request = getRequest();
const url = new URL(request?.url ?? "http://localhost");
const tags = url.searchParams.getAll("tag");
```

See the [Request Context guide](./request-context.md) for more on `getRequest()`.

## URL behavior

When `setSearchParams` is called, the router navigates to the same pathname with the updated query string. By default, this uses `replaceState` instead of `pushState`, so changing filters doesn't create extra browser history entries. This means pressing the back button takes the user to the previous page, not the previous filter state.

## See also

- [Navigation & Links](./navigation-and-links.md) — programmatic navigation and the Link component
- [Request Context](./request-context.md) — accessing search params on the server via getRequest()
