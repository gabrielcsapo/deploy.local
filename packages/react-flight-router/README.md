# Flight Router

A React Server Components (RSC) routing framework built on Vite. Server components render on the server and stream to the client via the React Flight protocol, with full support for client components, server actions, SSR, and nested layouts with segment diffing.

## Features

- **React Server Components** — Routes are async server components that can fetch data directly
- **Nested Layouts** — Routes compose via `<Outlet />`, sharing layouts across child routes
- **Dynamic Params** — `:id` style URL segments with params passed to components
- **Server Actions** — `'use server'` functions callable from client components via `useActionState`
- **Client Components** — `'use client'` modules with full React state and interactivity
- **SSR** — Production builds render full HTML on the server for fast FCP and SEO
- **Segment Diffing** — Navigation only re-renders changed segments, preserving shared layouts
- **CSS Support** — Works with Tailwind CSS, CSS modules, or any Vite-compatible CSS tooling
- **Streaming** — RSC payloads stream to the client for zero-waterfall hydration

## Quick Start

```bash
# Create a new project
mkdir my-app && cd my-app
npm init -y
npm install react react-dom react-server-dom-webpack flight-router hono @hono/node-server
npm install -D vite @vitejs/plugin-react typescript
```

### Project Structure

```
my-app/
├── app/
│   ├── routes.ts          # Route configuration
│   ├── root.tsx           # Root layout (renders <html>)
│   └── routes/
│       ├── home.tsx       # Index route (server component)
│       └── about.tsx      # /about route
├── server.ts              # Production server entry
└── vite.config.ts         # Vite config with flight-router plugin
```

### Route Configuration

```ts
// app/routes.ts
import type { RouteConfig } from "flight-router/router";

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
    ],
  },
];
```

### Root Layout

The root layout renders the full HTML document and uses `<Outlet />` for child routes:

```tsx
// app/root.tsx
import { Link, Outlet } from "flight-router/client";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
          <Link to="/posts">Blog</Link>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
```

### Server Components (Data Fetching)

Route components are async server components — fetch data directly with `await`:

```tsx
// app/routes/posts/detail.tsx
import { Link } from "flight-router/client";

export default async function PostPage({ params }: { params: Record<string, string> }) {
  const res = await fetch(`https://api.example.com/posts/${params.id}`);
  const post = await res.json();

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
```

### Client Components

Add interactivity with `'use client'`:

```tsx
// app/routes/counter.client.tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}
```

### Server Actions

```tsx
// app/routes/actions.ts
"use server";

export async function addMessage(prevState: string[], formData: FormData) {
  const text = (formData.get("text") as string)?.trim();
  if (text) prevState.push(text);
  return [...prevState];
}
```

```tsx
// app/routes/message-board.client.tsx
"use client";

import { useActionState } from "react";
import { addMessage } from "./actions.js";

export function MessageBoard() {
  const [messages, formAction, isPending] = useActionState(addMessage, []);

  return (
    <form action={formAction}>
      <input name="text" placeholder="Message" />
      <button type="submit" disabled={isPending}>
        {isPending ? "Sending..." : "Send"}
      </button>
      <ul>
        {messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </form>
  );
}
```

### Vite Config

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

### Production Server

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "flight-router/server";

const app = await createServer({ buildDir: "./dist" });
serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Running at http://localhost:${info.port}`);
});
```

## Development

```bash
# Start dev server (Vite with HMR)
npx vite
```

## Production Build

```bash
# Build (5-phase: RSC → Client → SSR → Manifests → Server)
npx flight-router build

# Start production server
node dist/server.js
```

## API Reference

### Route Config

```ts
interface RouteConfig {
  id: string; // Unique route identifier
  path?: string; // URL segment (e.g., 'about', ':id', 'posts/:slug')
  index?: boolean; // Matches parent path exactly
  component: () => Promise<RouteModule>; // Lazy import of the route module
  children?: RouteConfig[]; // Nested child routes
}
```

### Client Exports (`flight-router/client`)

| Export              | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `<Link to="/path">` | Client-side navigation link (renders `<a>`, intercepts clicks) |
| `<Outlet />`        | Renders the matched child route segment                        |
| `useRouter()`       | Returns `{ url, navigate, segments, navigationState, params }` |
| `useParams()`       | Returns current route params as `Record<string, string>`       |
| `useNavigation()`   | Returns `{ state: 'idle' \| 'loading' }`                       |
| `useLocation()`     | Returns `{ pathname: string }`                                 |

### Route Components

Server components receive a `params` prop with extracted URL parameters:

```tsx
export default async function Page({ params }: { params: Record<string, string> }) {
  // params.id, params.slug, etc.
}
```

### Dynamic Segments

- `:id` — Matches a single path segment, extracted as `params.id`
- `:rest*` — Catch-all, matches remaining path segments

## Architecture

### How It Works

1. **Route Matching** — URL is matched against the route tree, extracting params at each level
2. **Segment Rendering** — Each matched route renders its component into a segment map (e.g., `root`, `root/posts`, `root/posts/post-detail`)
3. **RSC Streaming** — Segments are serialized via React's Flight protocol and streamed to the client
4. **Client Hydration** — The client deserializes the RSC stream, mounts the React tree, and hydrates for interactivity
5. **Navigation** — `<Link>` triggers RSC fetches; segment diffing only re-renders what changed

### Build Pipeline

The production build runs 5 phases:

1. **RSC Build** — Bundles server components with `react-server` condition
2. **Client Build** — Bundles client components, entry, and CSS for the browser
3. **SSR Build** — Bundles client components for server-side rendering
4. **Manifest Generation** — Creates RSC, SSR, and server action manifests
5. **Server Build** — Bundles the production server entry

### Segment Diffing

When navigating between routes that share layouts, only changed segments are re-rendered:

```
/posts → /posts/3
  root         (preserved)
  root/posts   (preserved — same layout)
  root/posts/post-detail  (NEW — rendered with params.id = "3")
```

The client sends `X-RSC-Previous-URL` and the server computes the diff, skipping unchanged segments.

## License

MIT
