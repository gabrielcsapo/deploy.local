---
title: "Suspense & Streaming"
description: "Use React Suspense boundaries to progressively stream server-rendered content to the browser. Show fallback UI while async data loads, with independent streaming for each boundary."
---

# Suspense & Streaming

React Flight Router streams content from the server as each part of the component tree resolves. By wrapping async server components in `<Suspense>` boundaries, you control what the user sees while data is loading and how content appears progressively.

## Basic Suspense

Wrap an async server component in `<Suspense>` to show a fallback while it loads:

```tsx
import { Suspense } from "react";

export default function PostsPage() {
  return (
    <div>
      <h1>Posts</h1>
      <Suspense fallback={<p>Loading posts...</p>}>
        <PostsList />
      </Suspense>
    </div>
  );
}

async function PostsList() {
  const res = await fetch("https://api.example.com/posts");
  const posts = await res.json();

  return (
    <ul>
      {posts.map((post: { id: number; title: string }) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

The heading and fallback text are sent to the browser immediately. Once `PostsList` finishes fetching, the server streams the real content and React swaps it in — no client-side JavaScript fetch required.

## Parallel streaming

Each `<Suspense>` boundary streams independently. When you have multiple async components, they resolve in parallel and appear as soon as their data is ready:

```tsx
import { Suspense } from "react";

export default function DashboardPage() {
  return (
    <div className="grid grid-cols-2 gap-6">
      <Suspense fallback={<Skeleton />}>
        <RecentOrders /> {/* resolves in ~1s */}
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <AnalyticsChart /> {/* resolves in ~3s */}
      </Suspense>
    </div>
  );
}
```

`RecentOrders` appears after ~1s while `AnalyticsChart` is still loading. The user sees useful content immediately instead of waiting for the slowest component.

## Nested Suspense

Suspense boundaries can be nested. The outer boundary resolves first, revealing content that may contain an inner boundary with its own fallback:

```tsx
import { Suspense } from "react";

async function PostWithComments({ id }: { id: string }) {
  const post = await fetchPost(id); // ~1s

  return (
    <article>
      <h2>{post.title}</h2>
      <p>{post.body}</p>

      <Suspense fallback={<p>Loading comments...</p>}>
        <Comments postId={id} /> {/* ~3s */}
      </Suspense>
    </article>
  );
}

export default function PostPage({ params }: { params: Record<string, string> }) {
  return (
    <Suspense fallback={<p>Loading post...</p>}>
      <PostWithComments id={params.id} />
    </Suspense>
  );
}
```

The user sees "Loading post..." first, then the post content with "Loading comments...", then finally the comments. Each layer of data appears as it becomes available.

## How streaming works

When the server renders a page with Suspense boundaries:

1. **Synchronous content and fallbacks** are sent immediately — the browser can start painting.
2. **Async components** execute in parallel on the server. As each one resolves, its rendered output is streamed to the browser.
3. **React replaces fallbacks** with the real content as chunks arrive, without a full page refresh.
4. **SSR streaming** works the same way — the initial HTML includes fallbacks, and resolved content is streamed in as `<template>` tags that React processes during hydration.

This applies to both initial page loads (SSR) and client-side navigations (RSC). During client-side navigation, the router fetches the RSC payload and React shows Suspense fallbacks while lazy references resolve.

## SSR behavior

During server-side rendering, React's `renderToReadableStream` streams HTML progressively:

- The shell (layouts, headings, fallback content) is sent in the first chunk
- As async components resolve, their HTML is streamed in subsequent chunks
- The browser renders content as it arrives — no need to wait for the full response

This means the Time to First Contentful Paint (FCP) is determined by your synchronous content, not your slowest data fetch.

## Client-side navigation

When navigating between pages, the router fetches the new page's RSC payload. If the new page has Suspense boundaries around async server components:

1. The RSC payload's top-level structure resolves immediately (with lazy references for async content)
2. React renders the new page, showing Suspense fallbacks for unresolved content
3. As the server streams data for each async component, React swaps in the real content

This gives users immediate visual feedback that navigation has occurred, even when the destination page has slow data fetches.

## When to use Suspense

Use Suspense boundaries when:

- **Data fetches are slow** (external APIs, complex database queries) — show a fallback instead of blocking the entire page
- **Multiple independent data sources** — let faster content appear first
- **Progressive disclosure** — show a skeleton or summary immediately, then fill in details

You do not need Suspense for every async component. If your data fetches are fast (under ~200ms), the content typically renders before the user notices any delay. Use Suspense strategically for genuinely slow operations.

## Tips

- **Keep fallbacks lightweight.** A simple skeleton or loading text is ideal. Avoid fetching data in fallback components.
- **Place boundaries strategically.** Wrap individual slow sections rather than the entire page. The more granular your boundaries, the more progressive the loading experience.
- **Avoid Suspense waterfalls.** If you nest async components without Suspense between them, the inner component won't start loading until the outer one resolves. Use separate Suspense boundaries or `Promise.all` to parallelize.

## Live example

The example app includes a `/suspense` route that demonstrates all three patterns (basic, parallel, and nested Suspense). Run the example to see streaming in action:

```bash
cd packages/react-flight-router-example
pnpm dev
# Open http://localhost:5173/suspense
```
