---
title: "Route Config"
description: "API reference for the route configuration types exported from react-flight-router/router, including RouteConfig, RouteModule, and RouteMatch."
---

# Route Config

React Flight Router uses a code-based route configuration. Routes are defined as an array of `RouteConfig` objects exported from your routes file (typically `app/routes.ts`). All types are available from the `"react-flight-router/router"` import path.

```ts
import type { RouteConfig, RouteModule, RouteMatch, SlotMatch } from "react-flight-router/router";
```

---

## `RouteConfig`

Defines a single route in the routing tree. Routes can be nested to create layouts with child pages.

```ts
interface RouteConfig {
  id: string;
  path?: string;
  index?: boolean;
  component: () => Promise<RouteModule>;
  children?: RouteConfig[];
  notFound?: () => Promise<RouteModule>;
  error?: () => Promise<RouteModule>;
  loading?: () => Promise<RouteModule>;
  slots?: Record<string, RouteConfig[]>;
}
```

### Properties

| Property    | Type                         | Required | Description                                                                                                                                                                                                                                  |
| ----------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | `string`                     | Yes      | Unique route identifier. Used to build hierarchical segment keys (e.g., `"root"`, `"home"`). Must be unique across all routes.                                                                                                               |
| `path`      | `string`                     | No       | URL path segment to match. Supports static segments (`"about"`), dynamic params (`":id"`), multi-segment patterns (`"posts/:slug"`), and catch-all params (`":path*"`). Omit for layout routes that wrap children without adding to the URL. |
| `index`     | `boolean`                    | No       | When `true`, this route matches only when the parent route's path is matched exactly (no additional path segments). Index routes cannot have children.                                                                                       |
| `component` | `() => Promise<RouteModule>` | Yes      | A function that lazily imports the route module. This enables code splitting -- each route's component is loaded on demand.                                                                                                                  |
| `children`  | `RouteConfig[]`              | No       | Nested child routes. The parent route's component acts as a layout and must render an `<Outlet />` for children to appear.                                                                                                                   |

### Boundary properties

These three optional properties control what renders when child routes are in a loading, error, or not-found state. They all work at any nesting level — the deepest matching ancestor provides the boundary. When present, `<Outlet />` automatically wraps children in the appropriate boundary (`<Suspense>` for loading, `<ErrorBoundary>` for error).

| Property   | Type                         | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading`  | `() => Promise<RouteModule>` | No       | A `"use client"` component shown as a Suspense fallback during navigation to child routes. When present, `<Outlet />` automatically wraps children in a `<Suspense>` boundary using this component as the fallback. During client-side navigation, segments with a loading boundary are replaced with suspense sentinels immediately (before the server responds), triggering the loading fallback. See the [Loading & Suspense guide](../guides/loading-and-suspense.md). |
| `error`    | `() => Promise<RouteModule>` | No       | Component to render when a child route's module fails to import (server-side) or when a child route throws a render error (client-side error boundary). Works at any nesting level — the deepest matching ancestor catches it. Returns HTTP 500 for SSR. When present, `<Outlet />` automatically wraps children in an `<ErrorBoundary>`. The error component receives an `error` prop. See the [Error Handling guide](../guides/error.md).                                |
| `notFound` | `() => Promise<RouteModule>` | No       | Component to render when no child routes match. Works at any nesting level — the deepest matching layout catches it. Returns HTTP 404 for SSR. See the [Not Found guide](../guides/not-found.md).                                                                                                                                                                                                                                                                          |

### Parallel-route slots

The `slots` property declares additional named route subtrees that render alongside the main `<Outlet />`. Each slot is matched against a `?@<slotName>=<path>` search param in the URL and is rendered via `<Outlet name="<slotName>" />` inside the layout. The classic use case is a modal that overlays the current page while keeping a shareable URL.

| Property | Type                            | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slots`  | `Record<string, RouteConfig[]>` | No       | Each entry maps a slot name to its own route subtree. The slot is empty when its `?@<slotName>` search param is absent. When present, the value is matched as a pathname against the subtree, and the resulting segments are keyed under `<parent>@<slotName>/...`. Each slot has independent layouts, params, and boundaries. A direct visit to the slot's "real" path (no slot search param) is matched against the main tree instead, giving you the share-link property of intercepting routes. See the [Parallel Routes guide](../guides/parallel-routes.md) for a full example. |

### Example

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
          {
            id: "dashboard-settings",
            path: "settings",
            component: () => import("./routes/dashboard/settings.js"),
          },
        ],
      },
    ],
  },
];
```

### Path matching rules

- **Static segments**: `"about"` matches `/about` exactly.
- **Dynamic params**: `":id"` matches any single segment and captures it as a parameter. For example, `":id"` on path `/42` produces `{ id: "42" }`.
- **Multi-segment patterns**: `"posts/:slug"` matches `/posts/hello-world` and captures `{ slug: "hello-world" }`.
- **Catch-all params**: `":path*"` matches one or more remaining segments. For example, `":path*"` on `/docs/api/hooks` produces `{ path: "docs/api/hooks" }`.
- **Layout routes**: When `path` is omitted (or set to `""`), the route matches everything and consumes no URL segments. Use these for shared layouts.
- **Index routes**: When `index: true`, the route matches only when the parent URL is matched exactly with no remaining path.

---

## `RouteModule`

The shape of a module imported by a route's `component` function. Each route module must have a default export.

```ts
interface RouteModule {
  default: ComponentType<{ params?: Record<string, string>; children?: ReactNode }>;
}
```

### Properties

| Property  | Type                                    | Required | Description                                                                                                                                                         |
| --------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` | `ComponentType<{ params?, children? }>` | Yes      | The page or layout component. Receives extracted URL `params` as a prop. Layout components also receive `children` (though typically you use `<Outlet />` instead). |

### Example: Page component

```tsx
// app/routes/post-detail.tsx

interface Props {
  params?: Record<string, string>;
}

export default async function PostDetail({ params }: Props) {
  const post = await fetch(`https://api.example.com/posts/${params?.id}`).then((r) => r.json());

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
```

### Example: Layout component with Outlet

```tsx
// app/routes/root.tsx
import { Outlet } from "react-flight-router/client";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  );
}
```

> **Error handling** is configured via the `error` property on `RouteConfig`, not as a module export. See the [Error Handling guide](../guides/error.md).

> **Loading states** are configured via the `loading` property on `RouteConfig`. The loading component must be a `"use client"` module. See the [Loading & Suspense guide](../guides/loading-and-suspense.md).

---

## `RouteMatch`

Represents a matched route during URL resolution. The `matchRoutes` function returns an array of `RouteMatch` objects from outermost (root layout) to innermost (leaf page).

```ts
interface RouteMatch {
  route: RouteConfig;
  params: Record<string, string>;
  pathname: string;
  segmentKey: string;
}
```

### Properties

| Property     | Type                     | Description                                                                                                                                                                    |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `route`      | `RouteConfig`            | The matched route configuration object.                                                                                                                                        |
| `params`     | `Record<string, string>` | All extracted URL parameters, merged from parent matches. For example, if a parent matches `:orgId` and a child matches `:userId`, `params` contains both `{ orgId, userId }`. |
| `pathname`   | `string`                 | The portion of the URL pathname consumed by this route's pattern.                                                                                                              |
| `segmentKey` | `string`                 | Hierarchical key used internally for segment diffing and partial updates. Built by joining route IDs with `/` (e.g., `"root"`, `"root/posts"`, `"root/posts/post-detail"`).    |

### Example

Given this route config:

```ts
const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    children: [
      {
        id: "post-detail",
        path: "posts/:id",
        component: () => import("./routes/post-detail.js"),
      },
    ],
  },
];
```

Matching the URL `/posts/42` produces:

```ts
[
  {
    route: { id: "root" /* ... */ },
    params: {},
    pathname: "",
    segmentKey: "root",
  },
  {
    route: { id: "post-detail" /* ... */ },
    params: { id: "42" },
    pathname: "/posts/42",
    segmentKey: "root/post-detail",
  },
];
```

---

## `matchRoutes`

A utility function that matches a URL pathname against a route configuration tree.

```ts
import { matchRoutes } from "react-flight-router/router";

function matchRoutes(routes: RouteConfig[], pathname: string): RouteMatch[];
```

Returns an array of `RouteMatch` objects ordered from outermost to innermost. Returns an empty array if no route matches.

### Example

```ts
import { matchRoutes } from "react-flight-router/router";
import { routes } from "./app/routes.js";

const matches = matchRoutes(routes, "/posts/42");

for (const match of matches) {
  console.log(match.segmentKey, match.params);
}
// "root" {}
// "root/post-detail" { id: "42" }
```

`matchRoutes` accepts an optional third argument, `parentSegmentKey`, used internally by parallel-route slot matching to root the resulting segment keys under an owning layout (e.g. `"root@modal"`). Application code typically does not need to pass it.

---

## `SlotMatch`

Represents a parallel-route slot resolved from the URL's search params. The `matchSlots` function returns one `SlotMatch` per declared slot whose `?@<slotName>` param is present and matches its subtree.

```ts
interface SlotMatch {
  parentSegmentKey: string;
  name: string;
  path: string;
  matches: RouteMatch[];
}
```

### Properties

| Property           | Type           | Description                                                                                                                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentSegmentKey` | `string`       | The segment key of the layout route that declared this slot (e.g., `"root"`).                                                                                       |
| `name`             | `string`       | The slot name, taken from the `@<name>` URL search param.                                                                                                           |
| `path`             | `string`       | The slot path from the URL — the value of `?@<name>=...`.                                                                                                           |
| `matches`          | `RouteMatch[]` | The match chain for the slot subtree, with each match's `segmentKey` rooted under the owning layout via the `@<name>` separator (e.g., `"root@modal/photo-modal"`). |

---

## `matchSlots`

Given the matches from `matchRoutes` and a URL's search params, return the `SlotMatch` for every declared slot whose `?@<slotName>` param resolves against its subtree.

```ts
import { matchSlots } from "react-flight-router/router";

function matchSlots(mainMatches: RouteMatch[], searchParams: URLSearchParams): SlotMatch[];
```

Returns an empty array when no slots are open or when no main match declared `slots`. Slots whose path doesn't resolve are dropped silently — the client treats them as closed.

### Example

```ts
import { matchRoutes, matchSlots } from "react-flight-router/router";
import { routes } from "./app/routes.js";

const url = new URL("/photos?@modal=/photo/3", "http://localhost");
const main = matchRoutes(routes, url.pathname);
const slots = matchSlots(main, url.searchParams);

for (const slot of slots) {
  console.log(
    slot.name,
    slot.path,
    slot.matches.map((m) => m.segmentKey),
  );
}
// "modal" "/photo/3" ["root@modal/photo-modal-layout", "root@modal/photo-modal-layout/photo-in-modal"]
```
