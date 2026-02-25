---
title: "Navigation & Links"
description: "How to navigate between pages in React Flight Router using the Link component, programmatic navigation, and hooks for loading states and route params."
---

# Navigation & Links

React Flight Router provides a `<Link>` component and several hooks for navigating between pages in your application. Client-side navigation fetches only the changed segments of the page, avoiding full page reloads.

## The Link Component

Use the `<Link>` component from `"react-flight-router/client"` for declarative navigation. It renders a standard `<a>` element and intercepts clicks to perform SPA-style navigation.

```tsx
"use client";

import { Link } from "react-flight-router/client";

export function Navigation() {
  return (
    <nav>
      <Link to="/">Home</Link>
      <Link to="/about">About</Link>
      <Link to="/posts">Posts</Link>
    </nav>
  );
}
```

Since `<Link>` renders a regular `<a>` tag, it supports progressive enhancement. If JavaScript has not loaded, the link works as a normal browser navigation.

## Programmatic Navigation

Use the `useRouter` hook when you need to navigate in response to events other than link clicks.

```tsx
"use client";

import { useRouter } from "react-flight-router/client";

export function SearchForm() {
  const { navigate } = useRouter();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const query = formData.get("q") as string;
    navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="q" placeholder="Search..." />
      <button type="submit">Search</button>
    </form>
  );
}
```

The `useRouter` hook returns an object with the following properties:

| Property          | Type                        | Description                          |
| ----------------- | --------------------------- | ------------------------------------ |
| `url`             | `string`                    | The current URL.                     |
| `navigate`        | `(url: string) => void`     | Navigate to a new URL.               |
| `segments`        | `Record<string, ReactNode>` | The current rendered segments.       |
| `navigationState` | `"idle" \| "loading"`       | Whether a navigation is in progress. |
| `params`          | `Record<string, string>`    | The current route parameters.        |

## Loading Indicators

Use the `useNavigation` hook to show loading indicators during page transitions.

```tsx
"use client";

import { useNavigation } from "react-flight-router/client";

export function GlobalLoadingBar() {
  const { state } = useNavigation();

  if (state === "idle") return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        background: "#0070f3",
        animation: "loading 1s ease-in-out infinite",
      }}
    />
  );
}
```

The `useNavigation` hook returns:

| Property | Type                  | Description                                        |
| -------- | --------------------- | -------------------------------------------------- |
| `state`  | `"idle" \| "loading"` | `"loading"` during navigation, `"idle"` otherwise. |

## Reading the Current Location

Use the `useLocation` hook to read the current pathname.

```tsx
"use client";

import { useLocation } from "react-flight-router/client";

export function Breadcrumb() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);

  return (
    <nav aria-label="Breadcrumb">
      <ol style={{ display: "flex", gap: "0.5rem", listStyle: "none" }}>
        <li>
          <a href="/">Home</a>
        </li>
        {segments.map((segment, i) => {
          const path = "/" + segments.slice(0, i + 1).join("/");
          return (
            <li key={path}>
              <span aria-hidden="true">/</span> <a href={path}>{segment}</a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
```

## Active Link Styling

The `<Link>` component provides `isActive` and `isPending` state through callback props for `className`, `style`, and `children`. Use these to highlight the currently active link.

```tsx
import { Link } from "react-flight-router/client";

export default function Sidebar() {
  return (
    <nav>
      <Link
        to="/"
        className={({ isActive }) => (isActive ? "font-bold text-blue-600" : "text-gray-600")}
      >
        Home
      </Link>
      <Link
        to="/dashboard"
        end={false}
        className={({ isActive }) => (isActive ? "font-bold text-blue-600" : "text-gray-600")}
      >
        Dashboard
      </Link>
      <Link
        to="/settings"
        className={({ isActive }) => (isActive ? "font-bold text-blue-600" : "text-gray-600")}
      >
        Settings
      </Link>
    </nav>
  );
}
```

### Link props

| Prop        | Type                                        | Default | Description                                                                           |
| ----------- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `to`        | `string`                                    | —       | The target URL path.                                                                  |
| `className` | `string \| (props) => string`               | —       | Static class name, or callback receiving `{ isActive, isPending }`.                   |
| `style`     | `CSSProperties \| (props) => CSSProperties` | —       | Static style, or callback receiving `{ isActive, isPending }`.                        |
| `children`  | `ReactNode \| (props) => ReactNode`         | —       | Static children, or render function receiving `{ isActive, isPending }`.              |
| `end`       | `boolean`                                   | `true`  | When `true`, requires exact pathname match. When `false`, prefix match is sufficient. |

### Exact vs prefix matching

By default (`end={true}`), `isActive` requires an exact pathname match. Set `end={false}` on parent links (like "Dashboard") to keep them active when viewing child routes like `/dashboard/settings`.

### Pending state

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

### Render function children

The `children` prop can be a function:

```tsx
<Link to="/notifications">
  {({ isActive }) => <>Notifications {isActive && <span className="badge">3</span>}</>}
</Link>
```

`Link` automatically sets `aria-current="page"` when active for accessibility.

## Reading Route Parameters

Use the `useParams` hook to access dynamic route parameters. For a route defined as `/posts/:id`, the `id` parameter is available through this hook.

```tsx
"use client";

import { useParams } from "react-flight-router/client";

export function PostHeader() {
  const params = useParams();

  return <p>Viewing post #{params.id}</p>;
}
```

The `useParams` hook returns a `Record<string, string>` containing all matched dynamic segments from the current URL.

## Segment Diffing

When navigating between pages, React Flight Router only fetches and re-renders the segments of the page that have changed. For example, navigating from `/posts/1` to `/posts/2` will re-render the post content but keep the shared layout intact. This makes navigations fast and efficient, since unchanged parts of the page are preserved without any extra work on your part.
