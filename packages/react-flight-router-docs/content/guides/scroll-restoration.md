---
title: "Scroll Restoration"
description: "Manage scroll position across client-side navigations with the ScrollRestoration component."
---

# Scroll Restoration

The `<ScrollRestoration />` component manages scroll position during client-side navigations. It scrolls to the top when navigating to a new page and restores the previous scroll position when using browser back/forward buttons.

## Setup

Add `<ScrollRestoration />` once in your root layout, inside the `<body>`:

```tsx
import { Link, Outlet, ScrollRestoration } from "react-flight-router/client";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <ScrollRestoration />
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

## Behavior

| Navigation type           | Scroll behavior                        |
| ------------------------- | -------------------------------------- |
| Link click / `navigate()` | Scrolls to top (0, 0)                  |
| Browser back button       | Restores previous scroll position      |
| Browser forward button    | Restores previous scroll position      |
| Page reload               | Restores position (via sessionStorage) |

## How it works

1. Each navigation generates a unique key stored in `history.state`.
2. As the user scrolls, the current position is saved to `sessionStorage` keyed by the history entry key (debounced at 100ms).
3. On back/forward navigation (`popstate` event), the component looks up the saved position and restores it using `requestAnimationFrame` to wait for the DOM to update.
4. On new navigation (link click or programmatic), the component scrolls to the top.

Positions are stored in `sessionStorage`, so they survive page reloads within the same tab but are cleared when the tab is closed.

## API

```ts
function ScrollRestoration(): null;
```

The component renders nothing (`null`). It only manages scroll behavior through side effects.

Place it once in your root layout. Multiple instances are not needed and may cause unexpected behavior.
