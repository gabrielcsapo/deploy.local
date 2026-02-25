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

Server components receive the full `URL` object and can access search params directly:

```tsx
// app/routes/posts/index.tsx (server component)

interface Props {
  params?: Record<string, string>;
}

export default async function PostsList({ params }: Props) {
  // Access search params from the request URL on the server
  // The URL is available in the rendering context
  const posts = await fetch("https://api.example.com/posts").then((r) => r.json());

  return (
    <div>
      <h1>Posts</h1>
      {posts.map((post: any) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
        </article>
      ))}
    </div>
  );
}
```

## URL behavior

When `setSearchParams` is called, the router navigates to the same pathname with the updated query string. By default, this uses `replaceState` instead of `pushState`, so changing filters doesn't create extra browser history entries. This means pressing the back button takes the user to the previous page, not the previous filter state.
