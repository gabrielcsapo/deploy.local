---
title: "Your First Route"
description: "Create a root layout, a home page with data fetching, and a client component to see React Flight Router in action."
---

# Your First Route

This guide walks you through building a small working app that showcases what makes React Flight Router different: server components that fetch data directly, client components for interactivity, and nested routes with instant navigation.

## 1. Create the root layout

The root layout is the outermost component in your route hierarchy. It renders the full HTML document and uses `<Outlet />` to display whichever child route matches the current URL.

Create `app/root.tsx`:

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
          <Link to="/notes">Notes</Link>
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

- **`Link`** provides client-side navigation. When the user clicks a `Link`, React Flight Router fetches only the changed segments from the server instead of doing a full page reload.
- **`Outlet`** renders the matched child route. Without it, nested routes would have nowhere to appear.
- The root layout is a **server component** -- it runs on the server and its output is streamed to the client. There is no need for a `"use client"` directive.

## 2. Create a home page with data fetching

Route components are server components by default. They can be `async` functions, which means you can read files, query databases, or call APIs directly in the component body -- no `useEffect` or data-loading library needed.

Create `app/routes/home.tsx`:

```tsx
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export default async function HomePage() {
  // Read a file from disk -- only possible in a server component
  const pkg = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf-8"));

  return (
    <div>
      <h1>{pkg.name}</h1>
      <p>Version: {pkg.version ?? "0.0.0"}</p>
      <p>
        This data was read from <code>package.json</code> on the server. No API endpoint, no
        client-side fetch, no loading spinner.
      </p>
      <p>Server rendered at {new Date().toISOString()}</p>
    </div>
  );
}
```

Because this is a server component, `node:fs` works directly. The file is read at request time on the server, and the rendered HTML is streamed to the client. The browser never downloads `node:fs` or your `package.json`.

## 3. Add a client component for interactivity

Server components cannot use hooks like `useState` or handle browser events. For interactive UI, create a client component with the `"use client"` directive.

Create `app/routes/note-editor.tsx`:

```tsx
"use client";

import { useState } from "react";

export function NoteEditor() {
  const [notes, setNotes] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            setNotes([...notes, draft.trim()]);
            setDraft("");
          }
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a note..."
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {notes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
      {notes.length === 0 && <p>No notes yet. Add one above.</p>}
    </div>
  );
}
```

Now create the server component that uses it. Create `app/routes/notes.tsx`:

```tsx
import { NoteEditor } from "./note-editor.js";

export default async function NotesPage() {
  return (
    <div>
      <h1>Notes</h1>
      <p>This heading is a server component. The editor below is a client component.</p>
      <NoteEditor />
    </div>
  );
}
```

This pattern is central to RSC: the page-level layout and data fetching happen on the server, while interactive widgets are client components that hydrate in the browser. Both compose naturally as JSX.

## 4. Define the route configuration

The route configuration maps URL paths to components. It is a plain TypeScript file that exports an array of `RouteConfig` objects.

Create `app/routes.ts`:

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
        id: "notes",
        path: "notes",
        component: () => import("./routes/notes.js"),
      },
    ],
  },
];
```

Here is what each field does:

- **`id`** -- A unique identifier for the route. React Flight Router uses this internally for segment diffing and partial updates.
- **`path`** -- The URL segment this route matches. The root uses an empty string `""` because it wraps all other routes.
- **`index: true`** -- Marks this as an index route. It matches when the parent path is visited exactly (in this case, `/`).
- **`component`** -- A function that returns a dynamic `import()`. React Flight Router uses this for code splitting so that only the components needed for the current page are loaded.

Note that the import paths use `.js` extensions (e.g., `"./root.js"`). This follows the TypeScript/ESM convention where import specifiers refer to the compiled output, even though the source files are `.tsx`.

## 5. Run the development server

Make sure you have a `vite.config.ts` in place with the `react()` and `flightRouter()` plugins (see [Vite Configuration](./vite-config.md) for the full setup).

Then start the dev server:

```bash
npx vite
```

Open `http://localhost:5173` in your browser. You should see your home page displaying data read from `package.json` on the server.

Click the **Notes** link. Notice the navigation is instant -- React Flight Router fetches only the RSC payload for the changed segment. The root layout stays mounted and is not re-rendered. The note editor is interactive in the browser, while the page heading was rendered on the server.

## What you've built

In a few files you've used three core React Flight Router concepts:

1. **Server components** (`home.tsx`) -- Async components that read files, query databases, or call APIs directly. Zero client-side JavaScript for data fetching.
2. **Client components** (`note-editor.tsx`) -- Interactive components with React state and event handlers that hydrate in the browser.
3. **Nested routing** (`root.tsx` + child routes) -- A shared layout that persists across navigations, with `<Outlet />` rendering the matched child.

## Next steps

From here you can:

- Add **nested layouts** by giving a route both a `component` and `children` and rendering `<Outlet />` in the layout component. See [Layouts & Outlets](../guides/layouts-and-outlets.md).
- Create **dynamic routes** using `:param` segments (e.g., `path: ":id"`) and reading `params` in your component. See [Routing](../guides/routing.md).
- Add **server actions** with `"use server"` for form submissions that mutate data on the server. See [Server Actions](../guides/server-actions.md).
- Set up a [production server](./project-structure.md) with `server.ts` and the `react-flight-router build` command.
