---
title: "Server Exports"
description: "API reference for the server-side APIs in React Flight Router, including createServer for production, flightRouter Vite plugin for development, and the react-flight-router build CLI."
---

# Server Exports

React Flight Router provides server-side APIs for both production and development. The production server is built on [Hono](https://hono.dev/), while the development experience is powered by a Vite plugin.

---

## `createServer(options)`

**Import:** `"react-flight-router/server"`

Creates a production [Hono](https://hono.dev/) application that serves your React Flight Router app with full SSR, RSC streaming, server actions, and static asset serving.

```ts
import { createServer } from "react-flight-router/server";

async function createServer(options: CreateServerOptions): Promise<Hono>;
```

### Options

```ts
interface CreateServerOptions {
  /** Path to the build output directory (typically "./dist") */
  buildDir: string;
}
```

| Option     | Type     | Required | Description                                                                                                                                                                                             |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildDir` | `string` | Yes      | Path to the build output directory. This is the directory produced by `react-flight-router build` (defaults to `./dist`). Can be relative or absolute -- it is resolved to an absolute path internally. |

### What it sets up

The returned Hono app includes the following route handlers:

| Route       | Method | Description                                                                                                                                         |
| ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/assets/*` | GET    | Serves static assets from the client build with immutable cache headers (`max-age=31536000`).                                                       |
| `/__rsc`    | GET    | The RSC endpoint for client-side navigation. Returns an RSC stream for the requested URL. Supports segment diffing via `X-RSC-Previous-URL` header. |
| `/__action` | POST   | The server actions endpoint. Accepts serialized action calls and returns RSC responses.                                                             |
| `*`         | GET    | Catch-all for initial page loads. Renders the full page via SSR with the RSC payload inlined as `<script>` tags for zero-waterfall hydration.       |

### Usage

Create a `server.ts` file in your project root:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

const app = await createServer({
  buildDir: "./dist",
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});
```

Then run the production server after building:

```bash
react-flight-router build
node dist/server.js
```

### How SSR works

On each initial page load, `createServer` performs the following:

1. Renders the RSC payload for the requested URL using routes and the client manifest.
2. Buffers the RSC stream and scans for client module references to build a per-page module map.
3. Deserializes the RSC payload into a React tree using `react-server-dom-webpack/client.node`.
4. Wraps the tree in `RouterProvider` and `OutletDepthContext.Provider` (SSR-built versions).
5. Renders the React tree to an HTML stream using `react-dom/server`.
6. Inlines the RSC payload as `<script>` tags after the HTML for client hydration.

The client receives fully rendered HTML on the initial load and hydrates using `hydrateRoot`, then switches to RSC-powered client-side navigation for subsequent page transitions.

---

## Additional server exports

The `"react-flight-router/server"` module also re-exports lower-level utilities for advanced use cases:

```ts
import {
  createServer,
  loadManifests,
  renderRSC,
  renderSSR,
  handleAction,
} from "react-flight-router/server";
```

| Export                    | Description                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadManifests(buildDir)` | Loads all build manifests (RSC client manifest, SSR manifest, server actions manifest, client entry URL, CSS files) from the build directory. |
| `renderRSC(options)`      | Renders an RSC stream for a given URL and route configuration. Used by both the RSC endpoint and SSR pipeline.                                |
| `renderSSR(options)`      | Takes an RSC stream and renders it to an HTML stream with inlined RSC payload for hydration.                                                  |
| `handleAction(options)`   | Processes a server action request: decodes the action, executes it, and returns an RSC response.                                              |

---

## `flightRouter(options)`

**Import:** `"react-flight-router/dev"`

A Vite plugin (actually an array of plugins) that enables the React Flight Router development experience. It handles RSC rendering, SSR, server actions, `"use client"` / `"use server"` directive transformation, and HMR.

```ts
import { flightRouter } from "react-flight-router/dev";

function flightRouter(options?: FlightRouterDevOptions): Plugin[];
```

### Options

```ts
interface FlightRouterDevOptions {
  /** Path to the routes file relative to app root (default: "./app/routes.ts") */
  routesFile?: string;
}
```

| Option       | Type     | Required | Default             | Description                                                                                                             |
| ------------ | -------- | -------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `routesFile` | `string` | No       | `"./app/routes.ts"` | Path to the routes file, relative to the project root. This file must export a `routes` array of `RouteConfig` objects. |

### Usage

Add the plugin to your `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [
    react(),
    flightRouter({
      routesFile: "./app/routes.ts",
    }),
  ],
});
```

Then start the development server:

```bash
npx vite
```

### What it provides

The `flightRouter` plugin registers three internal Vite plugins:

1. **`use-client` plugin** -- Transforms modules with `"use client"` directives. In RSC rendering mode, these modules are replaced with proxy stubs that emit client component references into the RSC stream. In SSR mode (marked with `?ssr` query), the real module code is preserved.

2. **`use-server` plugin** -- Transforms modules with `"use server"` directives. Registers server action functions so they can be invoked from the client.

3. **`react-flight-router:dev` plugin** -- The main dev server plugin that:
   - Configures Vite's SSR externals and `optimizeDeps` for React and RSC packages.
   - Registers middleware on Vite's dev server for RSC rendering, SSR, and server actions.
   - Handles initial page loads with full SSR (RSC stream, deserialization, `react-dom/server` rendering, HTML with inlined RSC payload).
   - Handles client-side navigation by serving RSC streams at the `/__rsc` endpoint.
   - Handles server action invocations at the `/__action` endpoint.
   - Supports HMR: when server component files change, connected clients are notified to revalidate. Client component changes are handled by Vite's standard HMR.
   - Injects CSS `<link>` tags discovered from the SSR module graph.
   - Injects the client entry script (`react-flight-router/client/entry`) into the SSR HTML.

### Dev vs. Production differences

| Feature           | Dev (`flightRouter` plugin)                                      | Production (`createServer`)                                 |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| RSC rendering     | Via Vite `ssrLoadModule` with react-server conditions            | Via pre-built RSC bundle with react-server variant of React |
| Client components | Served by Vite with HMR                                          | Pre-built and served as static assets                       |
| SSR               | HTML rendered on each request, processed by `transformIndexHtml` | HTML rendered from pre-built SSR bundle                     |
| Module resolution | Proxy-based manifests with lazy lookup                           | Static manifests generated during build                     |
| CSS               | Collected from Vite module graph, injected as `<link>` tags      | Pre-built CSS files listed in build manifests               |

---

## CLI: `react-flight-router build`

Runs the production build pipeline. This is a CLI command provided by the `react-flight-router` package.

```bash
npx react-flight-router build
```

### What it does

The build pipeline runs 5 sequential phases:

| Phase | Name                    | Description                                                                                                                                                                                                        |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | **RSC Build**           | Bundles route modules and the RSC runtime with the `react-server` resolve condition. This produces server-side code that can call `renderToReadableStream` without needing `--conditions=react-server` at runtime. |
| 2     | **Client Build**        | Bundles client components, the client entry, and CSS entries for the browser. Produces hashed assets in `dist/client/assets/`.                                                                                     |
| 3     | **SSR Build**           | Bundles client components for server-side rendering (Node.js). These are the real implementations of `"use client"` modules used during SSR.                                                                       |
| 4     | **Manifest Generation** | Generates the RSC client manifest, SSR manifest, server actions manifest, and `build-meta.json`. These manifests map module IDs to chunk URLs and file paths.                                                      |
| 5     | **Server Entry Build**  | Bundles your `server.ts` into `dist/server.js` as a self-contained production server entry point.                                                                                                                  |

### Configuration

The build command is run from your project root directory and uses the following defaults:

| Option           | Default                                    | Description                                       |
| ---------------- | ------------------------------------------ | ------------------------------------------------- |
| App root         | Current working directory                  | The directory containing your `app/` folder.      |
| Output directory | `./dist`                                   | Where build artifacts are written.                |
| Routes file      | `./app/routes.ts`                          | Your route definitions.                           |
| Client entry     | `react-flight-router/dist/client/entry.js` | The client-side entry point (from the framework). |

The build automatically loads your project's `vite.config.ts` to pick up user-configured plugins (such as Tailwind CSS). React Flight Router's own plugins (`react`, `flightRouter`) are filtered out to avoid duplication.

### Add to `package.json`

```json
{
  "scripts": {
    "dev": "vite",
    "build": "react-flight-router build",
    "start": "node dist/server.js"
  }
}
```

### Build output structure

After running `react-flight-router build`, the `dist/` directory contains:

```
dist/
  client/
    assets/          # Hashed JS/CSS bundles for the browser
  server/
    rsc-entry.js     # RSC route bundle (react-server variant)
    rsc-runtime.js   # RSC runtime (renderToReadableStream, decodeReply)
    ssr/             # SSR-built client components
    chunks/          # Server action chunks
    server-action-*.js  # Server action entry files
  server.js          # Production server entry point
  build-meta.json    # Build metadata (manifests, entry URLs, CSS files)
```
