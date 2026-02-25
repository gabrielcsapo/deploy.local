---
title: "Not Found Handling"
description: "Handle 404 pages with the notFound route config property, supporting nested layouts for per-section not-found pages."
---

# Not Found Handling

React Flight Router provides a `notFound` property on route configurations for rendering custom 404 pages. Not-found handlers work at any nesting level, so you can show different not-found pages for different sections of your app while preserving parent layouts.

## Basic setup

Add a `notFound` property to any route that has children. When no child route matches the URL, the not-found component renders inside that route's `<Outlet />`.

```ts
// app/routes.ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    notFound: () => import("./routes/not-found.js"),
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

Create the not-found component:

```tsx
// app/routes/not-found.tsx
import { Link } from "react-flight-router/client";

export default function NotFound() {
  return (
    <div>
      <h1>404 - Page Not Found</h1>
      <p>The page you're looking for doesn't exist.</p>
      <Link to="/">Go home</Link>
    </div>
  );
}
```

Now navigating to `/nonexistent` renders the root layout (with its nav bar) and the `NotFound` component in the outlet.

## Nested not-found pages

Add `notFound` to any layout route to handle not-found within that section. The deepest matching layout with a `notFound` handler catches the unmatched URL.

```ts
export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    notFound: () => import("./routes/not-found.js"),
    children: [
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        notFound: () => import("./routes/dashboard/not-found.js"),
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

| URL                      | Rendered                                            |
| ------------------------ | --------------------------------------------------- |
| `/nonexistent`           | Root layout + Root NotFound                         |
| `/dashboard/nonexistent` | Root layout + Dashboard layout + Dashboard NotFound |
| `/dashboard`             | Root layout + Dashboard layout + Dashboard Index    |

The dashboard's not-found page renders inside the dashboard layout, preserving the dashboard navigation and sidebar. The root not-found page catches everything else.

## How it works

When the route matcher encounters a layout route whose children don't match the remaining URL path:

1. If the route has a `notFound` handler, the matcher keeps the layout match and adds a synthetic not-found match.
2. The not-found component renders inside the layout's `<Outlet />`, just like any other child route.
3. The server sets an HTTP 404 status code on the response.

If no route in the tree has a `notFound` handler and the URL doesn't match, the outlet renders empty (the same behavior as before adding `notFound`).

## HTTP status code

When a not-found route is matched, the server automatically returns HTTP status 404 for SSR responses. This ensures search engines and crawlers correctly identify missing pages. Client-side navigations to not-found URLs still render the not-found component but don't produce an HTTP status (since they're RSC stream responses).

## API

The `notFound` property on `RouteConfig`:

```ts
interface RouteConfig {
  // ... existing properties
  notFound?: () => Promise<RouteModule>;
}
```

| Property   | Type                         | Description                                                                                                      |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `notFound` | `() => Promise<RouteModule>` | A lazy import function returning the component to render when no child routes match. Same format as `component`. |

The not-found module follows the same `RouteModule` interface as regular route components:

```ts
interface RouteModule {
  default: ComponentType<{ params?: Record<string, string> }>;
}
```
