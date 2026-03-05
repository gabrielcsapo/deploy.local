---
title: "Client Exports"
description: "API reference for all client-side exports from react-flight-router/client, including components (Link, Outlet, ScrollRestoration, RouterProvider, Loading, ErrorBoundary), hooks (useRouter, useParams, useNavigation, useLocation, useSearchParams), and utilities."
---

# Client Exports

All client-side components, hooks, and utilities are available from the `"react-flight-router/client"` import path. These are `"use client"` modules and can be used in both client components and server components that need to render interactive UI.

```ts
import {
  Link,
  Outlet,
  Loading,
  ErrorBoundary,
  ScrollRestoration,
  RouterProvider,
  useRouter,
  useParams,
  useNavigation,
  useLocation,
  useSearchParams,
  callServer,
} from "react-flight-router/client";
```

---

## Components

### `<Link>`

A client-side navigation link that renders a standard `<a>` element but intercepts clicks for SPA-style navigation. Uses the router context to trigger RSC-powered transitions without a full page reload.

The `<Link>` component also provides active and pending state awareness, making it suitable for navigation menus, sidebars, and tabs where you need to highlight the current route.

```ts
interface LinkProps extends Omit<
  AnchorHTMLAttributes,
  "className" | "style" | "href" | "children"
> {
  to: string;
  children: ReactNode | ((props: LinkRenderProps) => ReactNode);
  className?: string | ((props: LinkRenderProps) => string | undefined);
  style?: CSSProperties | ((props: LinkRenderProps) => CSSProperties | undefined);
  end?: boolean;
}

type LinkRenderProps = { isActive: boolean; isPending: boolean };
```

| Prop        | Type                                        | Default | Description                                                                           |
| ----------- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `to`        | `string`                                    | —       | The target URL path to navigate to (e.g., `"/about"`, `"/posts/42"`).                 |
| `className` | `string \| (props) => string`               | —       | Static class name, or a callback receiving `{ isActive, isPending }`.                 |
| `style`     | `CSSProperties \| (props) => CSSProperties` | —       | Static style, or a callback receiving `{ isActive, isPending }`.                      |
| `children`  | `ReactNode \| (props) => ReactNode`         | —       | Static children, or a render function receiving `{ isActive, isPending }`.            |
| `end`       | `boolean`                                   | `true`  | When `true`, requires exact pathname match. When `false`, prefix match is sufficient. |
| `...rest`   | `AnchorHTMLAttributes`                      | —       | All standard `<a>` element attributes (`aria-*`, etc.) are passed through.            |

The `<Link>` component allows default browser behavior for modifier-key clicks (`Ctrl`, `Meta`, `Shift`, `Alt`) and non-primary mouse buttons, so "open in new tab" works as expected.

Sets `aria-current="page"` when active for accessibility.

#### Basic usage

```tsx
"use client";

import { Link } from "react-flight-router/client";

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

#### Active state styling

```tsx
<Link
  to="/dashboard"
  end={false}
  className={({ isActive }) => (isActive ? "font-bold text-blue-600" : "text-gray-600")}
>
  Dashboard
</Link>
```

#### Pending state

`isPending` is `true` when a navigation to the link's destination is in progress:

```tsx
<Link
  to="/dashboard"
  className={({ isActive, isPending }) => {
    if (isPending) return "text-gray-400 animate-pulse";
    if (isActive) return "font-bold text-blue-600";
    return "text-gray-600";
  }}
>
  Dashboard
</Link>
```

#### Render function children

```tsx
<Link to="/notifications">
  {({ isActive }) => <>Notifications {isActive && <span className="badge">3</span>}</>}
</Link>
```

See [Navigation & Links](../guides/navigation-and-links.md) for more detailed usage.

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
import { Outlet } from "react-flight-router/client";

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
        <footer>Built with React Flight Router</footer>
      </body>
    </html>
  );
}
```

Outlets can be nested. Each layout in the route tree renders its own `<Outlet />`, and the framework automatically resolves which child segment to display based on the current URL and segment key hierarchy.

```tsx
// app/routes/dashboard.tsx (a nested layout)
import { Outlet } from "react-flight-router/client";

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

#### Automatic boundary wrapping

When the parent route config has a `loading` or `error` property, `<Outlet />` automatically wraps its children with the appropriate boundaries:

- **`loading` present**: Children are wrapped in a `<Suspense>` boundary using the loading component as the fallback.
- **`error` present**: Children are wrapped in an `<ErrorBoundary>` that catches render errors and displays the error component.
- **Both present**: Children are wrapped in both (ErrorBoundary outside, Suspense inside).

If you also place manual `<Loading>` or `<ErrorBoundary>` components inside your layout, the manual (closer) boundary takes precedence.

---

### `<Loading>`

A Suspense boundary component that can be placed manually in layout components to control where the loading fallback appears. Wraps its `children` in a `<Suspense>` boundary with the provided `fallback`.

```ts
function Loading({ children, fallback }: { children: ReactNode; fallback: ReactNode }): ReactNode;
```

| Prop       | Type        | Required | Description                                         |
| ---------- | ----------- | -------- | --------------------------------------------------- |
| `children` | `ReactNode` | Yes      | The content to wrap in a Suspense boundary.         |
| `fallback` | `ReactNode` | Yes      | The fallback UI shown while children are suspended. |

When placed manually in a layout, `<Loading>` takes precedence over the automatic Suspense boundary that `<Outlet />` creates from the route config's `loading` property (since the manual boundary is closer to the content).

#### Usage

```tsx
"use client";

import { Loading, Outlet } from "react-flight-router/client";

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <div className="dashboard-content">
        <Loading fallback={<div className="skeleton">Loading dashboard...</div>}>
          <Outlet />
        </Loading>
      </div>
    </div>
  );
}
```

---

### `<ErrorBoundary>`

A React error boundary component that can be placed manually in layout components to catch render errors in child routes. Displays the `fallback` component when an error is caught.

```ts
function ErrorBoundary({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ComponentType<{ error: Error }>;
}): ReactNode;
```

| Prop       | Type                              | Required | Description                                                               |
| ---------- | --------------------------------- | -------- | ------------------------------------------------------------------------- |
| `children` | `ReactNode`                       | Yes      | The content to wrap in an error boundary.                                 |
| `fallback` | `ComponentType<{ error: Error }>` | Yes      | A component rendered when an error is caught. Receives `error` as a prop. |

When placed manually in a layout, `<ErrorBoundary>` takes precedence over the automatic error boundary that `<Outlet />` creates from the route config's `error` property (since the manual boundary is closer to the content).

#### Usage

```tsx
"use client";

import { ErrorBoundary, Outlet } from "react-flight-router/client";

function DashboardError({ error }: { error: Error }) {
  return (
    <div className="error-panel">
      <h2>Dashboard Error</h2>
      <p>{error.message}</p>
    </div>
  );
}

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>Dashboard Sidebar</aside>
      <div className="dashboard-content">
        <ErrorBoundary fallback={DashboardError}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}
```

---

### `<ScrollRestoration />`

Manages scroll position across client-side navigations. Scrolls to top on new navigations and restores scroll position on back/forward. Renders nothing.

```ts
function ScrollRestoration(): null;
```

Place once in your root layout. Positions are stored in `sessionStorage` keyed by history entry. See the [Scroll Restoration guide](../guides/scroll-restoration.md) for details.

#### Usage

```tsx
import { ScrollRestoration, Outlet } from "react-flight-router/client";

export default function RootLayout() {
  return (
    <body>
      <ScrollRestoration />
      <Outlet />
    </body>
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

interface NavigateOptions {
  replace?: boolean;
}

interface RouterContextValue {
  url: string;
  navigate: (to: string, options?: NavigateOptions) => void;
  segments: Record<string, ReactNode>;
  navigationState: "idle" | "loading";
  pendingUrl: string | null;
  params: Record<string, string>;
}
```

| Return Property   | Type                                              | Description                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `string`                                          | The current URL path.                                                                                                                                                                        |
| `navigate`        | `(to: string, options?: NavigateOptions) => void` | Programmatic navigation function. By default pushes a new entry to browser history. Pass `{ replace: true }` to use `replaceState` instead. The navigation is wrapped in a React transition. |
| `segments`        | `Record<string, ReactNode>`                       | The current segment map. Keys are hierarchical segment keys (e.g., `"root"`, `"root/home"`), values are rendered React elements.                                                             |
| `navigationState` | `"idle" \| "loading"`                             | The current navigation state. `"loading"` while a navigation transition is pending, `"idle"` otherwise.                                                                                      |
| `pendingUrl`      | `string \| null`                                  | The URL of the in-progress navigation, or `null` when idle. Useful for building loading indicators that show where the user is navigating to.                                                |
| `params`          | `Record<string, string>`                          | The current URL parameters extracted from the matched route.                                                                                                                                 |

#### Usage

```tsx
"use client";

import { useRouter } from "react-flight-router/client";

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

import { useParams } from "react-flight-router/client";

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

import { useNavigation } from "react-flight-router/client";

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

import { useLocation } from "react-flight-router/client";

export function Breadcrumb() {
  const { pathname } = useLocation();
  const parts = pathname.split("/").filter(Boolean);

  return (
    <nav aria-label="Breadcrumb">
      <a href="/">Home</a>
      {parts.map((part, i) => {
        const path = "/" + parts.slice(0, i + 1).join("/");
        return (
          <span key={path}>
            {" "}
            / <a href={path}>{part}</a>
          </span>
        );
      })}
    </nav>
  );
}
```

---

### `useSearchParams()`

Read and write URL search parameters. Returns a `[searchParams, setSearchParams]` tuple.

```ts
function useSearchParams(): [
  URLSearchParams,
  (next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)) => void,
];
```

| Return            | Type              | Description                                                                               |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `searchParams`    | `URLSearchParams` | The current URL search parameters.                                                        |
| `setSearchParams` | `Function`        | Updates the search params and navigates. Accepts a `URLSearchParams` or updater function. |

`setSearchParams` uses `replaceState` by default, so filter changes don't create extra history entries.

#### Usage

```tsx
"use client";

import { useSearchParams } from "react-flight-router/client";

export function Pagination() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get("page") ?? "1");

  return (
    <button
      onClick={() => {
        const next = new URLSearchParams(searchParams);
        next.set("page", String(page + 1));
        setSearchParams(next);
      }}
    >
      Next page
    </button>
  );
}
```

See the [Search Params guide](../guides/search-params.md) for more examples.

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
// app/routes/items.tsx
"use client";

import { addItem } from "./actions.js";

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
