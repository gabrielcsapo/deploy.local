# React Flight Router

A React Server Components (RSC) routing framework built on Vite. Server components render on the server and stream to the client via the React Flight protocol, with full support for client components, server actions, SSR, and nested layouts with segment diffing.

## Features

- **React Server Components** — Routes are async server components that can fetch data directly
- **Nested Layouts** — Routes compose via `<Outlet />`, sharing layouts across child routes
- **Dynamic Params** — `:id` style URL segments with params passed to components
- **Server Actions** — `'use server'` functions callable from client components
- **Client Components** — `'use client'` modules with full React state and interactivity
- **SSR** — Production builds render full HTML on the server for fast FCP and SEO
- **Loading Boundaries** — Route-level `loading` components provide automatic Suspense fallbacks during navigation
- **Error Boundaries** — Route-level `error` components catch both import failures and client-side render errors
- **Segment Diffing** — Navigation only re-renders changed segments, preserving shared layouts
- **CSS Support** — Works with Tailwind CSS, CSS modules, or any Vite-compatible CSS tooling
- **Streaming** — RSC payloads stream to the client for zero-waterfall hydration
- **Custom Routes** — An `extend` hook registers your own HTTP routes and WebSocket upgrades, identically in dev and production

## Quick Start

```bash
mkdir my-app && cd my-app
npm init -y
npm install react react-dom react-server-dom-webpack react-flight-router hono @hono/node-server
npm install -D vite @vitejs/plugin-react typescript
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

```bash
# Development
npx vite

# Production build & serve
npx react-flight-router build
node dist/server.js
```

## Custom routes and WebSockets

Apps usually need more than pages — an API, a health check, a file route, a
WebSocket. The `extend` hook hands you a Hono app to register them on, and it
runs in both environments, so routes are written once.

Development and production reach the server by different paths (Vite's dev
middleware vs. your entry file), so pass the same hook to both:

```ts
// app/server-routes.ts
import type { Hono } from "hono";

export function registerRoutes(app: Hono) {
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/rooms/:code", (c) => c.json({ code: c.req.param("code") }));
}
```

```ts
// vite.config.ts
flightRouter({
  routesFile: "./app/routes.ts",
  extend: ({ app }) => registerRoutes(app),
});
```

```ts
// server.ts
const app = await createServer({
  buildDir: "./dist",
  extend: ({ app }) => registerRoutes(app),
});
```

Your routes are matched before the SSR catch-all, so any path the framework
does not already claim (`/assets/*`, the RSC endpoint, the action endpoint)
reaches them. Anything that matches none of your routes falls through to the
router and renders a page as usual — so **do not register a `*` catch-all**.

The app you get is your own in both modes, not the framework's, so `onError`
and `notFound` cover the routes you register and leave page rendering alone.

`extend` may be async, and requests wait for it to finish before being served.

### WebSockets

The hook also receives the Node HTTP server for `upgrade` handling. In
development that is Vite's server; in production it is `null`, because your
entry file creates the server itself:

```ts
// server.ts
const app = await createServer({ buildDir: "./dist", extend: ({ app }) => registerRoutes(app) });
const server = serve({ fetch: app.fetch, port: 3000 });
attachWebSockets(server);
```

```ts
// vite.config.ts
flightRouter({
  extend: ({ app, httpServer }) => {
    registerRoutes(app);
    if (httpServer) attachWebSockets(httpServer);
  },
});
```

## Documentation

For full documentation — including guides, API reference, and architecture details — visit:

**[https://gabrielcsapo.github.io/react-flight-router/](https://gabrielcsapo.github.io/react-flight-router/)**
