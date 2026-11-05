---
title: "Error Handling"
description: "Handle route errors with the error route config property, supporting nested layouts for per-section error pages and client-side error boundaries."
---

# Error Handling

React Flight Router provides an `error` property on route configurations for handling errors at two levels: **server-side** (when a route's module fails to import) and **client-side** (as a React error boundary that catches render errors). Error handlers work at any nesting level, so you can show different error pages for different sections of your app while preserving parent layouts.

## Basic setup

Add an `error` property to any route that has children. The error component serves two purposes:

1. **Server-side**: When a child route's module fails to import, the error component renders inside that route's `<Outlet />`.
2. **Client-side**: `<Outlet />` automatically wraps children in an `<ErrorBoundary>`, catching render errors thrown by child components.

```ts
// app/routes.ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    error: () => import("./routes/error.js"),
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

Create the error component. Use the `"use client"` directive so that it works both as a server-side fallback and as a client-side error boundary:

```tsx
// app/routes/error.tsx
"use client";

import { Link } from "react-flight-router/client";

export default function ErrorPage({ error }: { error: Error }) {
  return (
    <div>
      <h1>Something Went Wrong</h1>
      <p>{error.message}</p>
      <Link to="/">Go home</Link>
    </div>
  );
}
```

If the `about` route's module fails to import, the root layout renders normally and the `ErrorPage` component appears in its outlet.

## Nested error handlers

Add `error` to any layout route to handle errors within that section. The deepest matching ancestor with an `error` handler catches the error.

```ts
export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    error: () => import("./routes/error.js"),
    children: [
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        error: () => import("./routes/dashboard/error.js"),
        children: [
          {
            id: "dashboard-index",
            index: true,
            component: () => import("./routes/dashboard/index.js"),
          },
          {
            id: "dashboard-settings",
            path: "settings",
            component: () => import("./routes/dashboard/settings.js"),
          },
        ],
      },
      // ...
    ],
  },
];
```

With this configuration:

| Scenario                         | Rendered                                         |
| -------------------------------- | ------------------------------------------------ |
| Dashboard settings module errors | Root layout + Dashboard layout + Dashboard Error |
| Dashboard layout module errors   | Root layout + Root Error                         |

The dashboard's error page renders inside the dashboard layout, preserving the dashboard navigation and sidebar. If the dashboard layout itself errors, the root error handler catches it.

## How it works

When `buildSegmentMap` loads each matched route's module:

1. If the module import fails and an ancestor route has an `error` handler, the framework renders the error component in place of the failed subtree.
2. The error component renders inside the ancestor layout's `<Outlet />`, just like any other child route.
3. The server sets an HTTP 500 status code on the response.

If no route in the ancestor chain has an `error` handler, the error propagates as a standard server error.

## HTTP status code

When an error route is rendered, the server automatically returns HTTP status 500 for SSR responses. Client-side navigations to errored routes still render the error component but don't produce an HTTP status (since they're RSC stream responses with the status embedded in the payload).

## Client-side error boundary

When a route has an `error` property, `<Outlet />` automatically wraps its children in a React `<ErrorBoundary>`. This catches errors thrown during client-side rendering — for example, a client component that throws in its render function or an effect.

The error component receives the caught `Error` as a prop, just like the server-side case:

```tsx
// app/routes/dashboard/error.tsx
"use client";

import { Link } from "react-flight-router/client";

export default function DashboardError({ error }: { error: Error }) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
      <Link to="/dashboard">Try again</Link>
    </div>
  );
}
```

You can also place an `<ErrorBoundary>` manually in your layout for more control over positioning. Manual boundaries take precedence over the automatic one because they are closer to the content:

```tsx
"use client";

import { ErrorBoundary, Outlet } from "react-flight-router/client";
import DashboardError from "./error.js";

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <ErrorBoundary fallback={DashboardError}>
        <Outlet />
      </ErrorBoundary>
    </div>
  );
}
```

## Scope

The `error` handler catches errors at two levels:

- **Module import errors** (server-side) — errors thrown when loading the route's module (syntax errors, missing modules, top-level `await` failures).
- **Render errors** (client-side) — errors thrown during React rendering of child components, caught by the `<ErrorBoundary>` that `<Outlet />` creates automatically.

Errors thrown during async server component rendering (e.g., a failed `fetch` inside a component body) are not caught by error routes and are handled by React's standard error reporting.

## Using with `notFound`

A route can have both `notFound` and `error`. They handle different concerns:

- `notFound`: triggers during route matching when no child URL matches
- `error`: triggers during rendering when a child module fails to import

They cannot conflict.

## API

The error component receives the thrown `Error` as a prop:

```tsx
export default function ErrorPage({ error }: { error: Error }) {
  return <p>{error.message}</p>;
}
```

For the full `error` property specification on `RouteConfig`, see [Route Config reference](../api-reference/route-config.md). For the `<ErrorBoundary>` component API, see [Client Exports reference](../api-reference/client-exports.md).

## See also

- [Loading & Suspense](./loading-and-suspense.md) — loading boundaries that complement error handling
- [Not Found Handling](./not-found.md) — handling unmatched URLs (a related boundary type)
- [Layouts & Outlets](./layouts-and-outlets.md) — how `<Outlet />` integrates with error boundaries
