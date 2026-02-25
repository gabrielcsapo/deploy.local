# React Flight Router

A React Server Components (RSC) routing framework built on Vite. Server components render on the server and stream to the client via the React Flight protocol, with full support for client components, server actions, SSR, and nested layouts with segment diffing.

## Features

- **React Server Components** — Routes are async server components that can fetch data directly
- **Nested Layouts** — Routes compose via `<Outlet />`, sharing layouts across child routes
- **Dynamic Params** — `:id` style URL segments with params passed to components
- **Server Actions** — `'use server'` functions callable from client components
- **Client Components** — `'use client'` modules with full React state and interactivity
- **SSR** — Production builds render full HTML on the server for fast FCP and SEO
- **Segment Diffing** — Navigation only re-renders changed segments, preserving shared layouts
- **CSS Support** — Works with Tailwind CSS, CSS modules, or any Vite-compatible CSS tooling
- **Streaming** — RSC payloads stream to the client for zero-waterfall hydration

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

## Documentation

For full documentation — including guides, API reference, and architecture details — visit:

**[https://gabrielcsapo.github.io/react-flight-router/](https://gabrielcsapo.github.io/react-flight-router/)**
