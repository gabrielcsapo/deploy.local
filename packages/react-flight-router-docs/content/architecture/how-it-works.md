---
title: "How It Works"
description: "High-level architecture of React Flight Router, covering route matching, segment rendering, RSC streaming, client hydration, and navigation."
---

# How It Works

React Flight Router is built on React Server Components (RSC) and uses React's Flight protocol to stream rendered UI from the server to the client. This page explains the high-level architecture and the request flow for both initial page loads and client-side navigation.

## Core Concepts

### 1. Route Matching

When a request arrives, React Flight Router matches the URL against the route tree defined in your application. Routes are organized hierarchically, and each level of nesting can extract dynamic parameters from the URL path.

For example, given the URL `/posts/42`, the router walks the route tree:

- `/` matches the root layout
- `/posts` matches the posts layout
- `/posts/:id` matches the post detail route, extracting `params.id = "42"`

Each matched route contributes a **segment** to the final render.

### 2. Segment Rendering

Each matched route renders its component into a **segment map** -- a flat key-value structure where keys represent the nesting path and values are the rendered React trees.

For the URL `/posts/42`, the segment map might look like:

```
{
  "root":                    <RootLayout />,
  "root/posts":              <PostsLayout />,
  "root/posts/post-detail":  <PostDetail params={{ id: "42" }} />
}
```

Segments are named by concatenating the parent key with the child route name, separated by `/`. This flat structure makes it straightforward to identify which segments changed during navigation.

### 2a. Boundary Resolution

During segment rendering, routes with `loading` or `error` properties have their boundary components resolved on the server and included in the RSC payload as client component references. These boundary components are `"use client"` modules that the framework uses to automatically wrap `<Outlet />` children:

- **`loading`**: Resolved and sent as a client component reference. On the client, `<Outlet />` wraps children in a `<Suspense>` boundary using this component as the fallback.
- **`error`**: Resolved and sent as a client component reference. On the client, `<Outlet />` wraps children in an `<ErrorBoundary>` using this component as the fallback.

This approach means boundary components are available immediately on the client without additional network requests.

### 3. RSC Streaming

Once the segment map is built, it is serialized using React's Flight protocol (`react-server-dom-webpack/server`) and streamed to the client as an RSC payload. Streaming means the client can begin processing the response before the server has finished rendering all segments.

The server renders components in a single pass, and any async data fetching within server components is resolved as part of the stream.

### 4. Client Hydration

On the client, the RSC stream is deserialized using `react-server-dom-webpack/client`. The deserialized payload produces a React tree that the client mounts into the DOM.

- On the **initial page load**, the server also performs SSR to produce HTML. The client then **hydrates** the pre-rendered HTML using `hydrateRoot`, making it interactive without a full re-render.
- On **subsequent navigations**, the client receives only the RSC payload (no HTML) and updates the React tree in place.

### 5. Navigation

Client-side navigation is triggered by the `<Link>` component. When a user clicks a link:

1. If a loading boundary exists above any changing segments, those segments are immediately replaced with **suspense sentinels** -- triggering the loading fallback before the server responds
2. The client fetches a new RSC payload from the server for the target URL
3. The server performs **segment diffing** to determine which segments changed
4. Only the changed segments are streamed back
5. The client merges the new segments with the existing ones, preserving unchanged layouts and their state

This means shared layouts (like a root navigation bar or a section sidebar) are never re-rendered during navigation, preserving any React state they hold. When a `loading` component is configured, users see the loading fallback instantly rather than waiting for the server to begin streaming.

## RSC Payload Structure

The RSC payload sent from server to client contains:

- **Segment map**: A flat object mapping segment keys to rendered React elements
- **URL**: The current URL the payload represents
- **Params**: Any extracted route parameters
- **Segment keys**: An ordered list of all segment keys for the current URL

```ts
{
  url: "/posts/42",
  params: { id: "42" },
  segmentKeys: ["root", "root/posts", "root/posts/post-detail"],
  segments: {
    "root":                    <RootLayout />,
    "root/posts":              <PostsLayout />,
    "root/posts/post-detail":  <PostDetail />
  }
}
```

### Entry and Outlet Mechanism

The **entry point** wraps the root segment in an `OutletDepthContext.Provider`, which tracks the current nesting depth. Each `<Outlet />` component in a layout finds its child segment by matching the pattern `parentKey/childName`.

For example, if the current segment key is `"root"` and the layout renders an `<Outlet />`, the outlet looks for a child segment whose key starts with `"root/"` -- such as `"root/posts"`. This pattern continues recursively down the tree.

## Request Flow

### Initial Page Load

```
Browser                          Server
  |                                |
  |  GET /posts/42                 |
  |  ----------------------------→ |
  |                                |  1. Match URL to route tree
  |                                |  2. Render ALL segments (full page)
  |                                |  3. Serialize via Flight protocol
  |                                |  4. SSR: deserialize RSC stream,
  |                                |     render to HTML via renderToReadableStream
  |                                |  5. Interleave RSC payload into HTML
  |  ←---------------------------- |
  |  HTML + embedded RSC payload   |
  |                                |
  |  hydrateRoot(document, app)    |
  |  (interactive)                 |
```

On initial load, the server performs both RSC rendering and SSR. The HTML is sent first so the user sees content immediately, and the embedded RSC payload allows React to hydrate without an additional fetch.

### Client-Side Navigation

```
Browser                          Server
  |                                |
  |  User clicks <Link to="/posts/42">
  |                                |
  |  GET /posts/42                 |
  |  X-RSC: 1                     |
  |  X-RSC-Previous-URL: /posts   |
  |  ----------------------------→ |
  |                                |  1. Match both old and new URLs
  |                                |  2. Diff segments (only post-detail is new)
  |                                |  3. Render only changed segments
  |                                |  4. Stream RSC payload
  |  ←---------------------------- |
  |  RSC payload (partial)         |
  |                                |
  |  Merge new segments with       |
  |  existing segment map          |
  |  (root and root/posts preserved)
```

During client-side navigation, the server only renders and streams the segments that actually changed. The client merges these into its existing segment map, preserving layouts and their state. This is covered in detail in the [Segment Diffing](./segment-diffing.md) documentation.

## See also

- [Build Pipeline](./build-pipeline.md) — the 5-phase production build process
- [Segment Diffing](./segment-diffing.md) — how navigation minimizes re-rendering
