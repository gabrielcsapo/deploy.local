---
title: "Route Config"
description: "API reference for the route configuration types exported from react-flight-router/router, including RouteConfig, RouteModule, and RouteMatch."
---

# Route Config

Flight Router uses a code-based route configuration. Routes are defined as an array of `RouteConfig` objects exported from your routes file (typically `app/routes.ts`). All types are available from the `"react-flight-router/router"` import path.

```ts
import type { RouteConfig, RouteModule, RouteMatch } from "react-flight-router/router";
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

### Example

```ts
// app/routes.ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    component: () => import("./routes/root.tsx"),
    children: [
      {
        id: "home",
        index: true,
        component: () => import("./routes/home.tsx"),
      },
      {
        id: "about",
        path: "about",
        component: () => import("./routes/about.tsx"),
      },
      {
        id: "posts",
        path: "posts",
        component: () => import("./routes/posts.tsx"),
        children: [
          {
            id: "post-detail",
            path: ":id",
            component: () => import("./routes/post-detail.tsx"),
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

The shape of a module imported by a route's `component` function. Each route module must have a default export and may optionally export an `ErrorBoundary`.

```ts
interface RouteModule {
  default: ComponentType<{ params?: Record<string, string>; children?: ReactNode }>;
  ErrorBoundary?: ComponentType<{ error: Error }>;
}
```

### Properties

| Property        | Type                                    | Required | Description                                                                                                                                                         |
| --------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | `ComponentType<{ params?, children? }>` | Yes      | The page or layout component. Receives extracted URL `params` as a prop. Layout components also receive `children` (though typically you use `<Outlet />` instead). |
| `ErrorBoundary` | `ComponentType<{ error: Error }>`       | No       | An error boundary component rendered when this route or its children throw during rendering. Receives the thrown `error` as a prop.                                 |

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

### Example: Error boundary

```tsx
// app/routes/posts.tsx
import { Outlet } from "react-flight-router/client";

export default function PostsLayout() {
  return (
    <section>
      <h1>Blog</h1>
      <Outlet />
    </section>
  );
}

export function ErrorBoundary({ error }: { error: Error }) {
  return (
    <section>
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
    </section>
  );
}
```

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
    component: () => import("./routes/root.tsx"),
    children: [
      {
        id: "post-detail",
        path: "posts/:id",
        component: () => import("./routes/post-detail.tsx"),
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
import { routes } from "./app/routes";

const matches = matchRoutes(routes, "/posts/42");

for (const match of matches) {
  console.log(match.segmentKey, match.params);
}
// "root" {}
// "root/post-detail" { id: "42" }
```
