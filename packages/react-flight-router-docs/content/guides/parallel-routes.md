---
title: "Parallel Routes & Modals"
description: "Render a second route subtree alongside the main page using parallel-route slots. The classic use case is a modal that overlays the current page while still being shareable as a URL."
---

# Parallel Routes & Modals

A parallel-route slot lets you render a second route subtree on top of the current page. The slot has its own match chain — its own layouts, dynamic params, error and loading boundaries — and lives in the URL as a search param so the result is still a shareable, refreshable URL.

The canonical use case is a photo modal: clicking a thumbnail in a gallery opens the photo over the gallery, but pasting that URL into a new tab renders the photo as a regular full-page route.

## When to use a slot vs. a child route

Reach for a slot when both of these are true:

- The overlay UI should not replace the underlying page (the gallery should stay mounted, scroll position preserved).
- A direct visit to the overlay's "real" URL should render that page on its own (modals are meant to be skipped on cold loads).

If neither is true — e.g. a true sub-page — use ordinary nested children. Slots add a second match dimension to your URL handling, which is overhead you only want when you need it.

## How it works

A slot has three pieces:

1. **A `slots` config** on the layout where it should attach.
2. **A search-param URL convention** — the slot's path lives in `?@<slotName>=<path>`.
3. **An `<Outlet name="<slotName>" />`** in the layout, rendered alongside the regular `<Outlet />`.

When the URL contains `?@modal=/photo/3`, the router matches `/photo/3` against the slot's route tree and renders the result into the named outlet. When the param is absent, the slot is empty.

A direct visit to `/photo/3` (no slot param) is matched against the main route tree and renders normally — the share-link property of intercepting routes falls out of this for free.

## A complete example

This is the photo-modal POC from the e2e test suite, end to end.

### Route configuration

```ts
// app/routes.ts
import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    slots: {
      // The "modal" slot has its own route subtree.
      modal: [
        {
          id: "photo-modal-layout",
          path: "",
          component: () => import("./routes/photo-modal-layout.js"),
          children: [
            {
              id: "photo-in-modal",
              path: "photo/:id",
              component: () => import("./routes/photo-in-modal.js"),
            },
          ],
        },
      ],
    },
    children: [
      {
        id: "photos",
        path: "photos",
        component: () => import("./routes/photos.js"),
      },
      {
        // Direct-visit version of the same path. Same component, different
        // context — slots and main routes are independent trees.
        id: "photo",
        path: "photo/:id",
        component: () => import("./routes/photo.js"),
      },
    ],
  },
];
```

### Root layout with both outlets

The root layout renders the regular outlet for the page underneath, and a named outlet for the modal layer:

```tsx
// app/root.tsx
import { Outlet } from "react-flight-router/client";

export default function RootLayout() {
  return (
    <html lang="en">
      <body>
        <main>
          <Outlet />
        </main>
        <Outlet name="modal" />
      </body>
    </html>
  );
}
```

### The slot's outer layout

The slot's outermost route is an ordinary layout. It renders modal chrome around its own `<Outlet />`:

```tsx
// app/routes/photo-modal-layout.tsx
import { Outlet } from "react-flight-router/client";
import PhotoModal from "./photo-modal.client.js";

export default function PhotoModalSlot() {
  return (
    <PhotoModal>
      <Outlet />
    </PhotoModal>
  );
}
```

```tsx
// app/routes/photo-modal.client.tsx
"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useCloseSlot } from "react-flight-router/client";

export default function PhotoModal({ children }: { children?: ReactNode }) {
  const close = useCloseSlot("modal");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center" onClick={close}>
      <div className="bg-white rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
        <button onClick={close} aria-label="Close">
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
```

### Linking into the slot

`<Link intoSlot="modal" to="/photo/3">` rewrites the click target to `<currentPathname>?@modal=/photo/3`, which keeps the underlying page mounted and opens the modal on top.

```tsx
// app/routes/photos.tsx
import { Link } from "react-flight-router/client";

export default function PhotosPage() {
  return (
    <ul>
      {photos.map((p) => (
        <li key={p.id}>
          <Link to={`/photo/${p.id}`} intoSlot="modal">
            <img src={p.thumb} alt={p.title} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

## The three exits

Once a modal is open, there are three different "exits" — choose the one that matches what the user is trying to do.

| Exit               | Result                                                     | API                                                   |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| **Close**          | Drops `?@<slot>=...`, returns to the underlying page.      | `useCloseSlot(name)`                                  |
| **Open full page** | Drops the slot param _and_ navigates to the canonical URL. | `<Link to="/photo/3">` (a normal link, no `intoSlot`) |
| **Browser back**   | Pops the history entry that opened the modal.              | Native back button                                    |

The "open full page" affordance is worth shipping — without it, users who hard-load a `?@modal=...` URL have no path to the standalone version of the page. A typical pattern:

```tsx
// app/routes/photo-in-modal.tsx
import { Link } from "react-flight-router/client";
import PhotoPage from "./photo.js";

export default function PhotoInModal({ params }: { params?: Record<string, string> }) {
  return (
    <>
      <PhotoPage params={params} />
      {params?.id && <Link to={`/photo/${params.id}`}>Open full page →</Link>}
    </>
  );
}
```

This is wired into the slot subtree (not the main `/photo/:id` route), so it only renders inside the modal.

## Why hard-loading preserves the modal

The URL `?@modal=/photo/3` literally encodes "modal is open with this path." Hard-loading or refreshing such a URL faithfully re-renders both layers — that's the share-link property and the reason slots exist. If reload silently dropped the slot, share links would be useless.

To leave the modal, use one of the three exits above.

## Multiple slots side-by-side

Because `slots` is a record, a single layout can declare any number of named slots. They render simultaneously, are matched independently, and are closed independently. Adding a side drawer alongside the photo modal:

```ts
{
  id: "root",
  path: "",
  component: () => import("./root.js"),
  slots: {
    modal: [/* photo modal subtree from above */],
    drawer: [
      {
        id: "cart-drawer-layout",
        path: "",
        component: () => import("./routes/cart-drawer-layout.js"),
        children: [
          {
            id: "cart-in-drawer",
            path: "cart",
            component: () => import("./routes/cart.js"),
          },
        ],
      },
    ],
  },
  // ...children
}
```

Each slot gets its own `<Outlet name>` and its own URL search param:

```tsx
// app/root.tsx
<main>
  <Outlet />
</main>
<Outlet name="modal" />
<Outlet name="drawer" />
```

```tsx
<Link to="/cart" intoSlot="drawer">
  View Cart
</Link>
```

When both are open, the URL looks like `?@modal=/photo/3&@drawer=/cart` — and that URL is shareable: hard-loading it SSRs the gallery, the photo modal, and the cart drawer in one response. Closing either calls `useCloseSlot("modal")` or `useCloseSlot("drawer")` independently; the other slot's segments are preserved.

A few things to mind when stacking slots:

- **Z-index ordering matters.** If two slots overlap visually (a fullscreen modal and a side drawer), pick a stacking order that keeps the underlying slot's interactive elements reachable. In the example above the drawer sits above the modal so its close button is always clickable.
- **Each slot has its own close handler.** `useCloseSlot("modal")` and `useCloseSlot("drawer")` are independent — closing one preserves the other's URL param and segments.
- **Escape and backdrop conventions are yours to design.** If both slots register `keydown` listeners for Escape, both will close. If you want "Escape closes only the topmost slot," you have to coordinate it in your client components (e.g., via a shared context).

## Server-side details

On every navigation the server runs `matchSlots()` against both the previous and current URL's search params. For each declared slot:

- If the slot path is **unchanged** between the two URLs, its segments are skipped on the server and reused on the client (just like main-tree segment diffing).
- If the slot path is **different** or **newly opened**, its entire subtree re-renders and is included in the response.
- If the slot was open before but is now **closed**, its keys are simply omitted from the canonical `segmentKeys` list and the client drops them from its segment map.

Slot segments are keyed under `<parent>@<slotName>/...` — for example, `root@modal/photo-modal-layout/photo-in-modal`. This namespace separation keeps slot diffing independent of main-tree diffing.

## Known limitations

A few sharp edges to be aware of:

- **No boundary "above" the slot.** A slot's outermost route can declare `loading` and `error`, but those wrap its own children — there is no boundary that wraps the slot container itself. If you need a graceful skeleton while the modal is opening, you have to put a layout route at the top of the slot's tree.
- **Coarse slot diffing.** When the slot path changes (e.g. `/photo/3` → `/photo/4`), the entire slot subtree re-renders. Sub-segment diffing inside the slot is not yet implemented.
- **No nested slots.** `matchSlots()` only inspects matches in the main tree. Slot routes declaring their own `slots` are silently ignored.
- **Slot params don't appear in `useParams()`.** `useParams()` returns the leaf params of the _main_ match chain. To get a slot's leaf params, render the value through the slot route component's `params` prop and pass it down explicitly.
- **History semantics are a judgment call.** Opening a modal pushes a history entry; closing replaces it. Switching photos within the modal pushes additional entries. Tune to taste with `navigate(..., { replace: true })`.
- **URL aesthetics.** Browsers may percent-encode `@` to `%40` in the address bar. The server decodes either form, but shared URLs may look uglier than expected.

## See also

- [Layouts & Outlets](./layouts-and-outlets.md) — the foundational mental model for `<Outlet />` and segment diffing
- [Navigation & Links](./navigation-and-links.md) — `<Link>` mechanics, including the `intoSlot` prop
- [Search Params](./search-params.md) — read and write search params for non-slot use cases
- [Route Config](../api-reference/route-config.md) — the `slots` field reference
- [Client Exports](../api-reference/client-exports.md) — `<Outlet name>`, `<Link intoSlot>`, `useCloseSlot()`
