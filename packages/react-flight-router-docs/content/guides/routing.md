---
title: "Routing"
description: "Define your application's route tree using the RouteConfig interface, with support for dynamic segments, catch-all routes, index routes, and nested layouts."
---

# Routing

React Flight Router uses a centralized route configuration to define your application's URL structure. Routes are defined as a tree of `RouteConfig` objects in a single `routes.ts` file, giving you full control over path matching, nesting, and code splitting.

## The RouteConfig interface

Import the `RouteConfig` type from `react-flight-router/router` and export a `routes` array:

```ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  // ...
];
```

Each `RouteConfig` object defines a route's `id`, `path`, `component`, and optional properties like `children`, `loading`, `error`, and `notFound`. For the full property reference, see [Route Config](../api-reference/route-config.md).

## Basic routes

A minimal route tree with a root layout, an index (home) page, and an about page:

```ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
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

- The root route has `path: ""`, which makes it a **layout route** -- it matches every URL and wraps all child routes.
- The home route has `index: true`, so it renders when the URL matches the parent path exactly (`/`).
- The about route matches `/about`.

## Dynamic segments

Prefix a path segment with `:` to capture a dynamic value. The captured value is available in the route component via the `params` prop.

```ts
{
  id: "post-detail",
  path: ":id",
  component: () => import("./routes/posts/detail.js"),
}
```

When the URL is `/posts/42`, the component receives `params.id` with the value `"42"`.

You can include multiple segments in a single path:

```ts
{
  id: "user-detail",
  path: "users/:id",
  component: () => import("./routes/users/detail.js"),
}
```

This matches `/users/5` and provides `params.id` as `"5"`.

## Catch-all segments

Append `*` to a dynamic segment to match the rest of the URL path:

```ts
{
  id: "catch-all",
  path: ":rest*",
  component: () => import("./routes/catch-all.js"),
}
```

For the URL `/docs/guides/routing`, the component receives `params.rest` with the value `"docs/guides/routing"`.

## Nested routes

Any route with a `children` array becomes a layout. The parent component renders an `<Outlet />` to display whichever child route matches the current URL.

```ts
{
  id: "dashboard",
  path: "dashboard",
  component: () => import("./routes/dashboard/layout.js"),
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
}
```

This produces the following URL structure:

| URL                   | Rendered components                     |
| --------------------- | --------------------------------------- |
| `/dashboard`          | `DashboardLayout` > `DashboardIndex`    |
| `/dashboard/settings` | `DashboardLayout` > `DashboardSettings` |

The layout component persists across navigations between its children, so shared UI like navigation tabs is not re-rendered.

## Full example

Here is a complete route tree demonstrating all of these patterns together:

```ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
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
      {
        id: "posts",
        path: "posts",
        component: () => import("./routes/posts/layout.js"),
        children: [
          {
            id: "posts-index",
            index: true,
            component: () => import("./routes/posts/index.js"),
          },
          {
            id: "post-detail",
            path: ":id",
            component: () => import("./routes/posts/detail.js"),
          },
        ],
      },
      {
        id: "user-detail",
        path: "users/:id",
        component: () => import("./routes/users/detail.js"),
      },
    ],
  },
];
```

This defines the following URL mappings:

| URL         | Matched routes                            |
| ----------- | ----------------------------------------- |
| `/`         | `root` > `home`                           |
| `/about`    | `root` > `about`                          |
| `/posts`    | `root` > `posts` (layout) > `posts-index` |
| `/posts/42` | `root` > `posts` (layout) > `post-detail` |
| `/users/5`  | `root` > `user-detail`                    |

## Not found handling

Add a `notFound` property to any layout route to render a custom 404 page when no child routes match. The not-found component renders inside the layout's `<Outlet />`, preserving navigation and other shared UI.

```ts
{
  id: "root",
  path: "",
  component: () => import("./root.js"),
  notFound: () => import("./routes/not-found.js"),
  children: [/* ... */],
}
```

Not-found handlers work at any nesting level. See the [Not Found Handling guide](./not-found.md) for details on nested not-found pages and HTTP status codes.

## Loading and error boundaries

Add `loading` and `error` properties to layout routes to provide automatic Suspense and error boundary wrapping for child routes. The `<Outlet />` component handles the wrapping automatically.

```ts
{
  id: "dashboard",
  path: "dashboard",
  component: () => import("./routes/dashboard/layout.js"),
  loading: () => import("./routes/dashboard/loading.js"),
  error: () => import("./routes/dashboard/error.js"),
  children: [
    {
      id: "dashboard-index",
      index: true,
      component: () => import("./routes/dashboard/index.js"),
    },
  ],
}
```

Both the `loading` and `error` components should be `"use client"` modules. The `loading` component runs on the client as a Suspense fallback during navigation. The `error` component catches both server-side import failures and client-side render errors (via `<ErrorBoundary>`).

See the [Loading & Suspense guide](./loading-and-suspense.md) and [Error Handling guide](./error.md) for details.

## Code splitting

Each route's `component` property is a function that returns a dynamic `import()`. This means route modules are only loaded when they are needed, and Vite automatically code-splits them into separate chunks for production builds.

```ts
// The posts detail module is only fetched when the user navigates to /posts/:id
component: () => import("./routes/posts/detail.js"),
```

You do not need any additional configuration for code splitting -- it works automatically.

## See also

- [Navigation & Links](./navigation-and-links.md) — the `<Link>` component and programmatic navigation
- [Layouts & Outlets](./layouts-and-outlets.md) — shared UI that persists across navigations
- [Route Config](../api-reference/route-config.md) — full API reference for `RouteConfig`
