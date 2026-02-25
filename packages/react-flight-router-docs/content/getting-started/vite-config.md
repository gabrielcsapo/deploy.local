---
title: "Vite Configuration"
description: "Configure Vite with the React Flight Router plugin to enable React Server Components, SSR, and development tooling."
---

# Vite Configuration

React Flight Router integrates with [Vite](https://vite.dev/) through a dedicated plugin that handles React Server Component rendering, server-side rendering, hot module replacement, and the production build pipeline.

## Basic configuration

Create a `vite.config.ts` file in the root of your project:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

The two required plugins are:

1. **`@vitejs/plugin-react`** -- Enables React Fast Refresh and JSX transformation during development.
2. **`flightRouter()`** -- The React Flight Router plugin that provides RSC support, SSR, client/server component splitting, and the build orchestrator.

### Plugin options

The `flightRouter` plugin accepts the following options:

| Option       | Type     | Required | Description                                                         |
| ------------ | -------- | -------- | ------------------------------------------------------------------- |
| `routesFile` | `string` | Yes      | Path to the route configuration file, relative to the project root. |

```ts
flightRouter({ routesFile: "./app/routes.ts" });
```

## Adding Tailwind CSS

To use [Tailwind CSS v4](https://tailwindcss.com/) with React Flight Router, install the dependencies and add the Tailwind plugin to your Vite config. The Tailwind plugin should come **before** the other plugins:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [tailwindcss(), react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

Then create a CSS file that imports Tailwind (for example, `app/styles.css`):

```css
@import "tailwindcss";
```

Import it in your root layout so the styles are included throughout your application:

```tsx
// app/root.tsx
import "./styles.css";
```

## Running the development server

Start the development server with:

```bash
npx vite
```

This starts a dev server (typically at `http://localhost:5173`) with:

- **Server-side rendering (SSR)** -- Pages are fully rendered to HTML on the server for fast initial loads.
- **Hot Module Replacement (HMR)** -- Changes to both server and client components are reflected instantly without a full page reload.
- **React Server Components** -- Server components run on the server and stream their output to the client. Client components are hydrated in the browser.

## Production build

To build your application for production, run:

```bash
npx react-flight-router build
```

This executes a multi-phase build that produces:

1. **RSC bundle** -- Server components bundled with the `react-server` condition.
2. **Client bundle** -- Client components and entry point optimized for the browser.
3. **SSR bundle** -- Client components compiled for server-side rendering.
4. **Manifests** -- Module maps that connect server and client components.
5. **Server entry** -- Your `server.ts` bundled into `dist/server.js`.

After building, start the production server:

```bash
node dist/server.js
```

## Full example

Here is a complete `vite.config.ts` with Tailwind CSS:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [tailwindcss(), react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

## Next steps

With Vite configured, you are ready to create [your first route](./first-route.md).
