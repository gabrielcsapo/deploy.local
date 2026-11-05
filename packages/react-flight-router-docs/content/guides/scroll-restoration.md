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

| Navigation type                      | Scroll behavior                        |
| ------------------------------------ | -------------------------------------- |
| Link click / `navigate()`            | Scrolls to top (0, 0)                  |
| Navigation with `preventScrollReset` | Stays where it is                      |
| Browser back button                  | Restores previous scroll position      |
| Browser forward button               | Restores previous scroll position      |
| Page reload                          | Restores position (via sessionStorage) |

## Holding the scroll position

Some URL changes don't replace what the user is reading: a modal route opening over a list, a filter toggling in the query string, in-place pagination. Resetting to the top on those is disorienting — worse on a long or infinitely-scrolled page, where the position is expensive to get back to.

Pass `preventScrollReset` to opt a single navigation out of the reset:

```tsx
// A card that opens a modal route over the list it sits in
<Link to={`/models/${slug}`} preventScrollReset>
  {name}
</Link>

// ...and the button that closes it again
<Link to="/models" preventScrollReset aria-label="Close">
  ✕
</Link>
```

The same option works on `navigate()` and on the closer returned by `useCloseSlot()`:

```tsx
const { navigate } = useRouter();
navigate("/models", { preventScrollReset: true });

const closeModal = useCloseSlot("modal", { preventScrollReset: true });
```

It only suppresses the scroll-to-top. The position is still recorded for the new history entry, so a later back/forward onto it restores normally.

Note that this controls scrolling only — whether the page _underneath_ keeps its state (loaded pages of an infinite list, for example) is a separate question, answered by whether the router re-renders that segment. Segments whose route and search params are unchanged are reused across a navigation, so their client state survives.

## How It Works

1. Each navigation generates a unique key stored in `history.state`.
2. As the user scrolls, the current position is saved to `sessionStorage` keyed by the history entry key (debounced at 100ms).
3. On back/forward navigation (`popstate` event), the component looks up the saved position and restores it using `requestAnimationFrame` to wait for the DOM to update.
4. On new navigation (link click or programmatic), the component scrolls to the top — unless the navigation set `preventScrollReset`, which is recorded on the history entry alongside its key.

Positions are stored in `sessionStorage`, so they survive page reloads within the same tab but are cleared when the tab is closed.

## API

```ts
function ScrollRestoration(): null;
```

The component renders nothing (`null`). It only manages scroll behavior through side effects.

Place it once in your root layout. Multiple instances are not needed and may cause unexpected behavior.

## See also

- [Navigation & Links](./navigation-and-links.md) — the Link component and client-side navigation
