---
title: "Loading & Suspense"
description: "Control loading UI with route-level loading boundaries, manual Suspense boundaries, and streaming SSR for progressive content delivery."
---

# Loading & Suspense

React Flight Router streams content from the server as each part of the component tree resolves. You can control loading UI in two ways: by using the `loading` property in your route configuration for automatic route-level Suspense boundaries, or by wrapping async server components in manual `<Suspense>` boundaries for more granular control.

## Route-level loading boundaries

Add a `loading` property to any route that has children. When navigating to a child route, the loading component renders inside that route's `<Outlet />` as a Suspense fallback while the new content loads.

The loading component must be a `"use client"` module.

```ts
// app/routes.ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    loading: () => import("./routes/loading.js"),
    children: [
      {
        id: "home",
        index: true,
        component: () => import("./routes/home.js"),
      },
      {
        id: "about",
        path: "about",
        component: () => import("./routes/about.js"),
      },
    ],
  },
];
```

Create the loading component:

```tsx
// app/routes/loading.tsx
"use client";

export default function Loading() {
  return (
    <div>
      <p>Loading...</p>
    </div>
  );
}
```

Now when navigating between `/` and `/about`, the loading component appears in the outlet while the new page loads.

### Nested loading states

Add `loading` to any layout route to show a section-specific loading state. The deepest matching ancestor with a `loading` handler provides the fallback.

```ts
export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    loading: () => import("./routes/loading.js"),
    children: [
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        loading: () => import("./routes/dashboard/loading.js"),
        children: [
          {
            id: "dashboard-index",
            index: true,
            component: () => import("./routes/dashboard/index.js"),
          },
          {
            id: "dashboard-analytics",
            path: "analytics",
            component: () => import("./routes/dashboard/analytics.js"),
          },
        ],
      },
      // ...
    ],
  },
];
```

```tsx
// app/routes/dashboard/loading.tsx
"use client";

export default function DashboardLoading() {
  return (
    <div className="dashboard-skeleton">
      <div className="skeleton-header" />
      <div className="skeleton-content" />
    </div>
  );
}
```

With this configuration:

| Navigation                               | Loading fallback                                   |
| ---------------------------------------- | -------------------------------------------------- |
| To `/about`                              | Root layout + Root Loading                         |
| To `/dashboard/analytics` (from outside) | Root layout + Dashboard layout + Dashboard Loading |
| Between dashboard pages                  | Root layout + Dashboard layout + Dashboard Loading |

The dashboard's loading state renders inside the dashboard layout, preserving the dashboard navigation and sidebar. The root loading state catches navigations to top-level pages.

### How route-level loading works

1. **On initial page load**, the loading component is resolved on the server and sent as a client component reference in the RSC payload.
2. **`<Outlet />`** detects the loading component from the route config and wraps children with `<Suspense fallback={<LoadingComponent />}>`.
3. **During client-side navigation**, segments with a loading boundary above them are replaced with **suspense sentinels** immediately (before the server responds), triggering the loading fallback while the new content loads.

This means the user sees the loading UI the instant they click a link, rather than waiting for the server to begin streaming.

### Manual placement with `<Loading>`

For more control over where the loading fallback appears, use the `<Loading>` component from `react-flight-router/client` directly in your layout. Manual boundaries take precedence over the automatic one because they are closer to the content:

```tsx
"use client";

import { Loading, Outlet } from "react-flight-router/client";

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <Loading fallback={<div className="skeleton">Loading...</div>}>
        <Outlet />
      </Loading>
    </div>
  );
}
```

See the [Client Exports reference](../api-reference/client-exports.md) for the full `<Loading>` API.

## Manual Suspense boundaries

For finer-grained control within a single page, wrap async server components in React's `<Suspense>` to show a fallback while they load:

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

The heading and fallback text are sent to the browser immediately. Once `PostsList` finishes fetching, the server streams the real content and React swaps it in -- no client-side JavaScript fetch required.

### Parallel streaming

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

### Nested Suspense

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

## Streaming SSR

During server-side rendering, React's `renderToReadableStream` streams HTML progressively:

- The shell (layouts, headings, fallback content) is sent in the first chunk
- As async components resolve, their HTML is streamed in subsequent chunks
- The browser renders content as it arrives -- no need to wait for the full response

This means the Time to First Contentful Paint (FCP) is determined by your synchronous content, not your slowest data fetch.

During client-side navigation, the router fetches the new page's RSC payload. If the new page has Suspense boundaries around async server components:

1. The RSC payload's top-level structure resolves immediately (with lazy references for async content)
2. React renders the new page, showing Suspense fallbacks for unresolved content
3. As the server streams data for each async component, React swaps in the real content

This gives users immediate visual feedback that navigation has occurred, even when the destination page has slow data fetches.

## Using with `error` and `notFound`

A route can have `loading`, `error`, and `notFound` together. They handle different concerns:

- `loading`: shows a fallback while child routes are loading during navigation
- `error`: renders when a child route's module fails to import or throws a render error
- `notFound`: renders when no child route matches the URL

```ts
{
  id: "dashboard",
  path: "dashboard",
  component: () => import("./routes/dashboard/layout.js"),
  loading: () => import("./routes/dashboard/loading.js"),
  error: () => import("./routes/dashboard/error.js"),
  notFound: () => import("./routes/dashboard/not-found.js"),
  children: [/* ... */],
}
```

When all three are present, `<Outlet />` wraps children in both a `<Suspense>` boundary (for loading) and an `<ErrorBoundary>` (for errors). The not-found component is handled during route matching.

## Best practices

- **Keep fallbacks lightweight.** A simple skeleton or loading text is ideal. Avoid fetching data in fallback components.
- **Place boundaries strategically.** Wrap individual slow sections rather than the entire page. The more granular your boundaries, the more progressive the loading experience.
- **Avoid Suspense waterfalls.** If you nest async components without Suspense between them, the inner component won't start loading until the outer one resolves. Use separate Suspense boundaries or `Promise.all` to parallelize.
- **Use route-level loading for navigation transitions.** The `loading` route config property is the simplest way to show loading UI during page transitions -- no code changes needed in the layout component.
- **Use manual `<Suspense>` for within-page loading.** When a single page has multiple independent async sections, manual `<Suspense>` boundaries let each section stream independently.
- **You don't need Suspense for everything.** If your data fetches are fast (under ~200ms), the content typically renders before the user notices any delay. Use Suspense strategically for genuinely slow operations.

## Live example

The example app includes a `/suspense` route that demonstrates basic, parallel, and nested Suspense patterns. Run the example to see streaming in action:

```bash
cd packages/react-flight-router-example
pnpm dev
# Open http://localhost:5173/suspense
```

For the full `loading` property API, see [Route Config reference](../api-reference/route-config.md).

## See also

- [Error Handling](./error.md) — error boundaries that complement loading states
- [Layouts & Outlets](./layouts-and-outlets.md) — how `<Outlet />` integrates with loading boundaries
- [Client Exports](../api-reference/client-exports.md) — the `<Loading>` component API
