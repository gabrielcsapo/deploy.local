---
title: "Your First Route"
description: "Create a root layout, a home page, and a route configuration to get your Flight Router application running."
---

# Your First Route

This guide walks you through creating the minimum set of files needed to see a working Flight Router application: a root layout, a home page component, and the route configuration that ties them together.

## 1. Create the root layout

The root layout is the outermost component in your route hierarchy. It renders the full HTML document and uses `<Outlet />` to display whichever child route matches the current URL.

Create `app/root.tsx`:

```tsx
import { Link, Outlet } from "flight-router/client";

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
        </nav>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  );
}
```

Key points:

- **`Link`** provides client-side navigation. When the user clicks a `Link`, Flight Router fetches only the changed segments from the server instead of doing a full page reload.
- **`Outlet`** renders the matched child route. Without it, nested routes would have nowhere to appear.
- The root layout is a **server component** -- it runs on the server and its output is streamed to the client. There is no need for a `"use client"` directive.

## 2. Create a home page

Route components are server components by default. They can be `async` functions, which means you can `await` data fetches directly in the component body without needing `useEffect` or a data-loading library.

Create `app/routes/home.tsx`:

```tsx
export default async function HomePage() {
  return (
    <div>
      <h1>Welcome to Flight Router</h1>
      <p>Server rendered at {new Date().toISOString()}</p>
      <p>This page is a React Server Component. The timestamp above was generated on the server.</p>
    </div>
  );
}
```

Because this is a server component, the timestamp is computed on the server at request time. Each navigation to this page produces a fresh timestamp without any client-side JavaScript.

## 3. Define the route configuration

The route configuration maps URL paths to components. It is a plain TypeScript file that exports an array of `RouteConfig` objects.

Create `app/routes.ts`:

```ts
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
    ],
  },
];
```

Here is what each field does:

- **`id`** -- A unique identifier for the route. Flight Router uses this internally for segment diffing and partial updates.
- **`path`** -- The URL segment this route matches. The root uses an empty string `""` because it wraps all other routes.
- **`index: true`** -- Marks this as an index route. It matches when the parent path is visited exactly (in this case, `/`).
- **`component`** -- A function that returns a dynamic `import()`. Flight Router uses this for code splitting so that only the components needed for the current page are loaded.

Note that the import paths use `.js` extensions (e.g., `"./root.js"`). This follows the TypeScript/ESM convention where import specifiers refer to the compiled output, even though the source files are `.tsx`.

## 4. Run the development server

Make sure you have a `vite.config.ts` in place (see [Vite Configuration](./vite-config.md)):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter({ routesFile: "./app/routes.ts" })],
});
```

Then start the dev server:

```bash
npx vite
```

Open `http://localhost:5173` in your browser. You should see your home page with the server-generated timestamp.

## 5. Add a second route

To see client-side navigation in action, add an about page.

Create `app/routes/about.tsx`:

```tsx
export default async function AboutPage() {
  return (
    <div>
      <h1>About</h1>
      <p>This is a simple about page rendered as a server component.</p>
    </div>
  );
}
```

Add it to the route configuration in `app/routes.ts`:

```ts
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
    ],
  },
];
```

Update the root layout to include a link to the about page:

```tsx
import { Link, Outlet } from "flight-router/client";

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
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  );
}
```

Click between the Home and About links. Notice that the navigation is instant -- Flight Router performs a client-side navigation, fetching only the RSC payload for the changed segment rather than reloading the entire page. The root layout stays mounted and is not re-rendered.

## Next steps

From here you can:

- Add **nested layouts** by giving a route both a `component` and `children` and rendering `<Outlet />` in the layout component.
- Create **dynamic routes** using `:param` segments (e.g., `path: ":id"`) and reading `params` in your component.
- Add **client components** with the `"use client"` directive for interactive UI like forms, counters, or modals.
- Set up a [production server](./project-structure.md#serverts) with `server.ts` and the `flight-router build` command.
