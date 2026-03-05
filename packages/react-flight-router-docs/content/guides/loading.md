---
title: "Loading Handling"
description: "Show loading UI during navigation with the loading route config property, supporting nested layouts for per-section loading states."
---

# Loading Handling

React Flight Router provides a `loading` property on route configurations for showing fallback UI during navigation. Loading handlers work at any nesting level, so you can show different loading states for different sections of your app while preserving parent layouts.

## Basic setup

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
    loading: () => import("./routes/loading.client.js"),
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
// app/routes/loading.client.tsx
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

## Nested loading states

Add `loading` to any layout route to show a section-specific loading state. The deepest matching ancestor with a `loading` handler provides the fallback.

```ts
export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    loading: () => import("./routes/loading.client.js"),
    children: [
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        loading: () => import("./routes/dashboard/loading.client.js"),
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
// app/routes/dashboard/loading.client.tsx
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

## How it works

1. **On initial page load**, the loading component is resolved on the server and sent as a client component reference in the RSC payload.
2. **`<Outlet />`** detects the loading component from the route config and wraps children with `<Suspense fallback={<LoadingComponent />}>`.
3. **During client-side navigation**, segments with a loading boundary above them are replaced with **suspense sentinels** immediately (before the server responds), triggering the loading fallback while the new content loads.

This means the user sees the loading UI the instant they click a link, rather than waiting for the server to begin streaming.

## Manual placement with `<Loading>`

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
  loading: () => import("./routes/dashboard/loading.client.js"),
  error: () => import("./routes/dashboard/error.client.js"),
  notFound: () => import("./routes/dashboard/not-found.js"),
  children: [/* ... */],
}
```

When all three are present, `<Outlet />` wraps children in both a `<Suspense>` boundary (for loading) and an `<ErrorBoundary>` (for errors). The not-found component is handled during route matching.

## API

The `loading` property on `RouteConfig`:

```ts
interface RouteConfig {
  // ... existing properties
  loading?: () => Promise<RouteModule>;
}
```

| Property  | Type                         | Description                                                                                                              |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `loading` | `() => Promise<RouteModule>` | A lazy import function returning a `"use client"` component to use as the Suspense fallback. Same format as `component`. |

The loading module follows the same `RouteModule` interface as regular route components:

```ts
interface RouteModule {
  default: ComponentType;
}
```

For broader coverage of Suspense patterns (manual boundaries, parallel streaming, nested Suspense), see the [Suspense & Streaming guide](./suspense.md).
