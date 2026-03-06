---
title: "Project Structure"
description: "Understand the file and folder conventions used by a React Flight Router application."
---

# Project Structure

React Flight Router uses a straightforward project layout. Routes are defined explicitly in a configuration file rather than derived from the filesystem, giving you full control over your routing hierarchy.

## Typical layout

```
my-app/
├── app/
│   ├── routes.ts          # Route configuration
│   ├── root.tsx           # Root layout (renders <html>)
│   ├── styles.css         # Global CSS
│   └── routes/
│       ├── home.tsx       # Index route
│       ├── about.tsx      # Static page
│       └── posts/
│           ├── layout.tsx # Nested layout
│           ├── index.tsx  # List page
│           └── detail.tsx # Dynamic page
├── server.ts              # Production server
├── vite.config.ts         # Vite + React Flight Router plugin
├── tsconfig.json          # TypeScript configuration
└── package.json
```

## File reference

### `vite.config.ts`

The Vite configuration file where you register the React Flight Router plugin and any other Vite plugins (such as Tailwind CSS). This file tells React Flight Router where to find your route definitions.

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

See [Vite Configuration](./vite-config.md) for the full details.

### `app/routes.ts`

The central route configuration file. It exports an array of `RouteConfig` objects that define the URL structure of your application, including nested layouts and dynamic segments.

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

Each route has:

- **`id`** -- A unique string identifier for the route.
- **`path`** (optional) -- The URL path segment this route matches (e.g., `"about"`, `":id"`). Omit for index routes.
- **`index`** (optional) -- When `true`, this route matches when the parent path is an exact match.
- **`component`** -- A function returning a dynamic `import()` of the route module.
- **`children`** (optional) -- Nested child routes rendered inside the parent's `<Outlet />`.

### `app/root.tsx`

The root layout component. This is the outermost component in your route hierarchy and is responsible for rendering the `<html>`, `<head>`, and `<body>` tags. It uses the `<Outlet />` component to render matched child routes.

```tsx
import { Link, Outlet } from "react-flight-router/client";

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
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
```

### `app/styles.css`

Global CSS for your application. If you are using Tailwind CSS, this file typically contains:

```css
@import "tailwindcss";
```

Import this file in your root layout (`app/root.tsx`) so the styles are included in the build:

```tsx
import "./styles.css";
```

### `app/routes/`

A conventional directory for route components. You can organize files however you like -- React Flight Router does not enforce filesystem conventions. The route configuration in `app/routes.ts` determines which files map to which URLs.

#### Server components

Route components are **React Server Components** by default. They can be `async` functions and can use `await` to fetch data directly:

```tsx
// app/routes/home.tsx
export default async function HomePage() {
  const posts = await fetch("https://api.example.com/posts").then((r) => r.json());

  return (
    <main>
      <h1>Home ({posts.length} posts)</h1>
      <p>Server rendered at {new Date().toISOString()}</p>
    </main>
  );
}
```

#### Client components

Files that need browser interactivity (state, effects, event handlers) must include the `"use client"` directive at the top:

```tsx
// app/routes/counter.tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```

Client components can be imported and rendered inside server components.

#### Nested layouts

A layout component renders `<Outlet />` to display its child routes. This allows you to share UI (such as navigation or sidebars) across a group of pages:

```tsx
// app/routes/posts/layout.tsx
import { Outlet } from "react-flight-router/client";

export default function PostsLayout() {
  return (
    <div>
      <h2>Blog</h2>
      <Outlet />
    </div>
  );
}
```

#### Dynamic routes

Use `:param` segments in the route path to capture dynamic values. The matched parameters are passed to the component via the `params` prop:

```tsx
// app/routes/posts/detail.tsx
export default async function PostDetail({ params }: { params: { id: string } }) {
  const post = await fetch(`https://api.example.com/posts/${params.id}`).then((r) => r.json());

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
```

The corresponding route config uses `:id` in the path:

```ts
{
  id: "post-detail",
  path: ":id",
  component: () => import("./routes/posts/detail.js"),
}
```

### `server.ts`

The production server entry point. React Flight Router provides a `createServer` function that returns a Hono application you can serve with `@hono/node-server`:

```ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

async function main() {
  const app = await createServer({
    buildDir: "./dist",
  });

  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`Server running at http://localhost:${info.port}`);
  });
}

main().catch(console.error);
```

This file is only used in production. During development, `npx vite` handles everything.

## Next steps

With your project structure in place, continue to [Vite Configuration](./vite-config.md) to set up the development server and production build.
