---
title: "Layouts & Outlets"
description: "Use layouts and the Outlet component to create shared UI that persists across navigations, with nested route rendering and segment-level updates."
---

# Layouts & Outlets

Layouts are route components that wrap child routes with shared UI -- things like navigation bars, sidebars, headers, and footers. The `<Outlet />` component renders whichever child route matches the current URL.

## The Outlet component

Import `Outlet` from `react-flight-router/client` and render it wherever you want the child route to appear:

```tsx
import { Outlet } from "react-flight-router/client";

export default function MyLayout() {
  return (
    <div>
      <h1>My App</h1>
      <Outlet />
    </div>
  );
}
```

`Outlet` automatically resolves the correct child segment from the current route match. If no child matches, it renders nothing.

## Root layout

The root layout is the outermost route in your configuration. It typically renders the `<html>`, `<head>`, and `<body>` elements, along with site-wide navigation:

```tsx
import { Link, Outlet } from "react-flight-router/client";
import "./styles.css";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My App</title>
      </head>
      <body>
        <nav>
          <ul>
            <li>
              <Link to="/">Home</Link>
            </li>
            <li>
              <Link to="/about">About</Link>
            </li>
            <li>
              <Link to="/posts">Blog</Link>
            </li>
          </ul>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
```

In the route configuration, the root layout uses `path: ""` so it matches every URL:

```ts
{
  id: "root",
  path: "",
  component: () => import("./root.js"),
  children: [
    // child routes rendered via <Outlet />
  ],
}
```

## Nested layouts

Any route with `children` in the route configuration acts as a layout. The component for that route should render an `<Outlet />` to display its children.

For example, a posts section with its own layout:

```tsx
// app/routes/posts/layout.tsx
import { Link, Outlet } from "react-flight-router/client";

export default function PostsLayout() {
  return (
    <main>
      <h1>Blog</h1>
      <nav>
        <Link to="/posts">All Posts</Link>
      </nav>
      <Outlet />
    </main>
  );
}
```

```tsx
// app/routes/posts/index.tsx
export default async function PostsIndex() {
  return <p>Select a post to read.</p>;
}
```

```tsx
// app/routes/posts/detail.tsx
export default async function PostDetail({ params }: { params: Record<string, string> }) {
  return <h2>Post #{params.id}</h2>;
}
```

With the corresponding route configuration:

```ts
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
}
```

When the user navigates to `/posts`, the posts layout renders with the index page inside its `<Outlet />`. When they navigate to `/posts/42`, the layout stays mounted and only the outlet content changes to the detail page.

## Layout preservation during navigation

React Flight Router uses segment-level diffing to minimize re-renders during client-side navigation. When the user navigates between sibling routes, only the changed segments are re-rendered on the server and sent to the client. Parent layouts remain untouched.

For example, navigating from `/posts` to `/posts/42`:

1. The root layout (`root`) is unchanged -- it is preserved.
2. The posts layout (`posts`) is unchanged -- it is preserved.
3. Only the child segment changes from `posts-index` to `post-detail`.

This means:

- Layout state (like scroll position, form inputs, or client component state in the layout) is preserved.
- Only the minimal amount of data is transferred from the server.
- The navigation feels instant because most of the page stays in place.

## Loading and error boundaries

When a route config includes `loading` or `error` properties, `<Outlet />` automatically wraps its children with the appropriate boundaries. This means you do not need to manually add `<Suspense>` or error boundary code in your layout components.

```ts
{
  id: "dashboard",
  path: "dashboard",
  component: () => import("./routes/dashboard/layout.js"),
  loading: () => import("./routes/dashboard/loading.client.js"),
  error: () => import("./routes/dashboard/error.client.js"),
  children: [/* ... */],
}
```

With this configuration, the dashboard layout's `<Outlet />` automatically wraps children in both a Suspense boundary (with the loading component as fallback) and an ErrorBoundary (with the error component as fallback). The layout component itself remains simple:

```tsx
import { Outlet } from "react-flight-router/client";

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <Outlet />
    </div>
  );
}
```

For more control over boundary placement, you can use the `<Loading>` and `<ErrorBoundary>` components from `react-flight-router/client` directly in your layout. Manual boundaries take precedence over automatic ones. See the [Suspense & Streaming guide](./suspense.md) and [Error Handling guide](./error.md) for details.

## Multiple levels of nesting

You can nest layouts as deeply as you need. Each level adds another `<Outlet />`:

```
RootLayout (/)
  └── <Outlet />
        └── DashboardLayout (/dashboard)
              └── <Outlet />
                    └── SettingsPage (/dashboard/settings)
```

```ts
{
  id: "root",
  path: "",
  component: () => import("./root.js"),
  children: [
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
    },
  ],
}
```

The dashboard layout can include its own navigation, and both the root and dashboard layouts persist when switching between dashboard sub-pages.

## The Link component

Use the `<Link>` component from `react-flight-router/client` for client-side navigation. It renders a standard `<a>` tag with an `href` attribute (for accessibility and SEO) but intercepts clicks to perform RSC-powered navigation without a full page reload:

```tsx
import { Link } from "react-flight-router/client";

<Link to="/posts">View Posts</Link>
<Link to={`/posts/${post.id}`}>Read More</Link>
```

`Link` passes through all standard anchor attributes, so you can add `className`, `aria-*` attributes, and other props as needed.
