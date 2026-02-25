---
title: "Client Exports"
description: "API reference for all client-side exports from flight-router/client, including components (Link, Outlet, RouterProvider), hooks (useRouter, useParams, useNavigation, useLocation), and utilities."
---

# Client Exports

All client-side components, hooks, and utilities are available from the `"flight-router/client"` import path. These are `"use client"` modules and can be used in both client components and server components that need to render interactive UI.

```ts
import {
  Link,
  Outlet,
  RouterProvider,
  useRouter,
  useParams,
  useNavigation,
  useLocation,
  callServer,
} from "flight-router/client";
```

---

## Components

### `<Link>`

A client-side navigation link that renders a standard `<a>` element but intercepts clicks for SPA-style navigation. Uses the router context to trigger RSC-powered transitions without a full page reload.

```ts
interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children: ReactNode;
}
```

| Prop       | Type                   | Required | Description                                                                                      |
| ---------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `to`       | `string`               | Yes      | The target URL path to navigate to (e.g., `"/about"`, `"/posts/42"`).                            |
| `children` | `ReactNode`            | Yes      | The content to render inside the link.                                                           |
| `...rest`  | `AnchorHTMLAttributes` | No       | All standard `<a>` element attributes (`className`, `style`, `aria-*`, etc.) are passed through. |

The `<Link>` component allows default browser behavior for modifier-key clicks (`Ctrl`, `Meta`, `Shift`, `Alt`) and non-primary mouse buttons, so "open in new tab" works as expected.

#### Usage

```tsx
"use client";

import { Link } from "flight-router/client";

export function Navigation() {
  return (
    <nav>
      <Link to="/">Home</Link>
      <Link to="/about" className="nav-link">
        About
      </Link>
      <Link to="/posts/42">Post #42</Link>
    </nav>
  );
}
```

---

### `<Outlet />`

Renders the matched child route segment inside a layout component. Each `<Outlet />` reads the current segment depth from context and looks up the next-level child segment in the segment map.

```ts
function Outlet(): ReactNode | null;
```

Takes no props. Returns `null` if no child segment matches.

#### Usage

```tsx
// app/routes/root.tsx (a layout route)
import { Outlet } from "flight-router/client";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <header>
          <h1>My App</h1>
        </header>
        <main>
          <Outlet />
        </main>
        <footer>Built with Flight Router</footer>
      </body>
    </html>
  );
}
```

Outlets can be nested. Each layout in the route tree renders its own `<Outlet />`, and the framework automatically resolves which child segment to display based on the current URL and segment key hierarchy.

```tsx
// app/routes/dashboard.tsx (a nested layout)
import { Outlet } from "flight-router/client";

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <div className="dashboard-content">
        <Outlet />
      </div>
    </div>
  );
}
```

---

### `<RouterProvider>`

The top-level provider that wraps the entire application with routing context. This component is used internally by the client entry and is generally not needed in application code. It manages URL state, segment state, navigation transitions, and browser history.

```ts
interface RouterProviderProps {
  children: ReactNode;
  initialUrl: string;
  initialSegments: Record<string, ReactNode>;
  initialParams: Record<string, string>;
  createFromReadableStream: (
    stream: ReadableStream,
    opts: { callServer: CallServerFn },
  ) => Promise<any>;
  callServer: CallServerFn;
}

function RouterProvider(props: RouterProviderProps): ReactNode;
```

| Prop                       | Type                        | Required | Description                                                                                           |
| -------------------------- | --------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `children`                 | `ReactNode`                 | Yes      | The application tree, typically the root segment wrapped in `OutletDepthContext.Provider`.            |
| `initialUrl`               | `string`                    | Yes      | The initial URL from the RSC payload.                                                                 |
| `initialSegments`          | `Record<string, ReactNode>` | Yes      | The initial segment map from the RSC payload (e.g., `{ "root": <Layout />, "root/home": <Home /> }`). |
| `initialParams`            | `Record<string, string>`    | Yes      | The initial route params extracted from the URL.                                                      |
| `createFromReadableStream` | `Function`                  | Yes      | The RSC deserialization function (from `react-server-dom-webpack/client`).                            |
| `callServer`               | `Function`                  | Yes      | The server action invocation function.                                                                |

The `RouterProvider` handles:

- Client-side navigation via `navigate()` (fetches RSC payloads from the server)
- Segment diffing and merging during navigation (only changed segments are re-rendered)
- Browser history management (`pushState` and `popstate` event handling)
- Navigation state tracking (idle vs. loading) using React transitions

---

## Hooks

### `useRouter()`

Returns the full router context value. This is the most comprehensive hook and provides access to all routing state and the navigation function.

```ts
function useRouter(): RouterContextValue;

interface RouterContextValue {
  url: string;
  navigate: (to: string) => void;
  segments: Record<string, ReactNode>;
  navigationState: "idle" | "loading";
  params: Record<string, string>;
}
```

| Return Property   | Type                        | Description                                                                                                                                                              |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`             | `string`                    | The current URL path.                                                                                                                                                    |
| `navigate`        | `(to: string) => void`      | Programmatic navigation function. Pushes a new entry to browser history and fetches the RSC payload for the target URL. The navigation is wrapped in a React transition. |
| `segments`        | `Record<string, ReactNode>` | The current segment map. Keys are hierarchical segment keys (e.g., `"root"`, `"root/home"`), values are rendered React elements.                                         |
| `navigationState` | `"idle" \| "loading"`       | The current navigation state. `"loading"` while a navigation transition is pending, `"idle"` otherwise.                                                                  |
| `params`          | `Record<string, string>`    | The current URL parameters extracted from the matched route.                                                                                                             |

#### Usage

```tsx
"use client";

import { useRouter } from "flight-router/client";

export function SearchForm() {
  const { navigate, navigationState } = useRouter();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const query = formData.get("q") as string;
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="q" placeholder="Search..." />
      <button type="submit" disabled={navigationState === "loading"}>
        {navigationState === "loading" ? "Searching..." : "Search"}
      </button>
    </form>
  );
}
```

---

### `useParams()`

Returns the current route parameters as a plain object. This is a convenience wrapper around `useRouter().params`.

```ts
function useParams(): Record<string, string>;
```

Returns a `Record<string, string>` containing all dynamic parameters from the matched route hierarchy. Parameters are merged from parent to child -- if a parent route matches `:orgId` and a child matches `:userId`, the returned object contains both.

#### Usage

```tsx
"use client";

import { useParams } from "flight-router/client";

export function PostHeader() {
  const params = useParams();
  return <h2>Viewing post #{params.id}</h2>;
}
```

---

### `useNavigation()`

Returns the current navigation state. Useful for showing loading indicators during page transitions.

```ts
function useNavigation(): { state: "idle" | "loading" };
```

| Return Property | Type                  | Description                                                                                    |
| --------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `state`         | `"idle" \| "loading"` | `"loading"` while a navigation is in progress (RSC payload being fetched), `"idle"` otherwise. |

Navigation transitions use `React.useTransition` under the hood, so existing content remains visible while the new page loads.

#### Usage

```tsx
"use client";

import { useNavigation } from "flight-router/client";

export function GlobalLoadingBar() {
  const { state } = useNavigation();

  if (state === "idle") return null;

  return (
    <div className="loading-bar" role="progressbar">
      Loading...
    </div>
  );
}
```

---

### `useLocation()`

Returns the current location with the pathname extracted from the URL.

```ts
function useLocation(): { pathname: string };
```

| Return Property | Type     | Description                                                                            |
| --------------- | -------- | -------------------------------------------------------------------------------------- |
| `pathname`      | `string` | The current URL pathname (e.g., `"/posts/42"`). Derived from the router's `url` state. |

#### Usage

```tsx
"use client";

import { useLocation } from "flight-router/client";
import { Link } from "flight-router/client";

export function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const isActive = pathname === to;

  return (
    <Link to={to} className={isActive ? "active" : ""}>
      {children}
    </Link>
  );
}
```

---

## Utilities

### `callServer`

The internal function used to invoke server actions from the client. It serializes the action ID and arguments, sends them to the server via POST, and deserializes the RSC response.

```ts
async function callServer(id: string, args: unknown[]): Promise<unknown>;
```

| Parameter | Type        | Description                                                              |
| --------- | ----------- | ------------------------------------------------------------------------ |
| `id`      | `string`    | The server action identifier (automatically generated by the framework). |
| `args`    | `unknown[]` | The arguments to pass to the server action.                              |

This function is used automatically by React when you call a server action -- you typically do not need to call it directly. It is passed to `createFromReadableStream` and `RouterProvider` so that React can invoke server actions transparently.

#### How it works

1. Serializes `args` using `encodeReply` from `react-server-dom-webpack/client.browser`.
2. Sends a POST request to the server's action endpoint with the action ID in the `X-RSC-Action` header.
3. Deserializes the RSC response stream using `createFromReadableStream`.
4. Returns the result to the calling component.

#### Usage (advanced)

In most cases, server actions are invoked directly and this function is called automatically:

```tsx
// app/routes/actions.ts
"use server";

export async function addItem(name: string) {
  // This runs on the server
  await db.items.create({ name });
}
```

```tsx
// app/routes/items.client.tsx
"use client";

import { addItem } from "./actions";

export function AddItemForm() {
  return (
    <form action={addItem}>
      <input name="name" />
      <button type="submit">Add</button>
    </form>
  );
}
```

---

## Additional Exports

### `SegmentRoot`

A wrapper component used internally to set the initial segment key context for the root segment. Not typically used in application code.

```ts
function SegmentRoot({
  segmentKey,
  children,
}: {
  segmentKey: string;
  children: ReactNode;
}): ReactNode;
```

### `OutletDepthContext`

A React context that tracks the current segment key and nesting depth. Used internally by `<Outlet />` and `<SegmentRoot />` to resolve child segments. Exported for advanced use cases such as custom SSR setups.

```ts
const OutletDepthContext: React.Context<{
  segmentKey: string;
  depth: number;
}>;
```
