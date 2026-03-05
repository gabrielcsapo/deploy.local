---
title: "Segment Diffing"
description: "How React Flight Router compares route segments between the previous and next URL to minimize re-rendering during client-side navigation."
---

# Segment Diffing

Segment diffing is React Flight Router's mechanism for minimizing the amount of work done during client-side navigation. When navigating between routes that share layouts, only the segments that actually changed are re-rendered on the server and streamed to the client.

## Why Segment Diffing Matters

In a nested routing architecture, navigating from one page to another often shares most of the route tree. For example, navigating from `/posts` to `/posts/3` only changes the innermost segment -- the root layout and posts layout remain the same.

Without segment diffing, every navigation would re-render the entire page from the root down. With segment diffing:

- **Shared layouts maintain their React state** (e.g., form inputs, scroll position, open modals)
- **Less data is transferred** over the network
- **Navigation is faster** because only the changed portion of the UI is rendered

## Example

Navigating from `/posts` to `/posts/3`:

```
URL: /posts                         URL: /posts/3

Segments:                           Segments:
  root              ── preserved ──   root
  root/posts        ── preserved ──   root/posts
                                      root/posts/post-detail  (NEW)
```

Only `root/posts/post-detail` is rendered and streamed. The `root` and `root/posts` segments are kept as-is on the client.

Navigating from `/posts/3` to `/users/5`:

```
URL: /posts/3                       URL: /users/5

Segments:                           Segments:
  root              ── preserved ──   root
  root/posts        ── REMOVED
  root/posts/post-detail ── REMOVED
                                      root/users       (NEW)
                                      root/users/user-detail  (NEW)
```

Here, the root layout is preserved, but the entire posts subtree is replaced by the users subtree.

## How It Works

The diffing process involves coordination between the client and server across six steps:

### Step 1: Client Sends Previous URL

When the user navigates via a `<Link>` component, the client includes the current URL in the request headers:

```
GET /posts/3
X-RSC: 1
X-RSC-Previous-URL: /posts
```

The `X-RSC` header signals that this is an RSC payload request (not a full page load). The `X-RSC-Previous-URL` header tells the server where the user is navigating **from**.

### Step 2: Server Matches Both URLs

The server matches both the previous URL (`/posts`) and the new URL (`/posts/3`) against the route tree. This produces two lists of matched route segments:

```
Previous: ["root", "root/posts"]
New:      ["root", "root/posts", "root/posts/post-detail"]
```

### Step 3: Server Computes the Diff

The `diffSegments()` function compares the two segment lists to determine which segments changed:

- Segments present in both lists with the same route and params are **unchanged**
- Segments present only in the new list are **added**
- Segments present only in the previous list are **removed** (the client will drop them)
- Segments present in both but with different params are **changed** (re-rendered)

In this example, `root` and `root/posts` are unchanged, and `root/posts/post-detail` is new.

### Step 4: Only Changed Segments Are Rendered

The server only renders the segments identified as new or changed. Unchanged segments are skipped entirely, saving server-side rendering time and reducing the RSC payload size. Changed segments are loaded **in parallel** using `Promise.all`, so the total loading time is determined by the slowest module rather than the sum of all modules.

```ts
// Server renders only:
{
  segments: {
    "root/posts/post-detail": <PostDetail params={{ id: "3" }} />
  }
}
```

### Step 5: Response Includes All Segment Keys

The response includes a `segmentKeys` array listing every segment key for the new URL, regardless of whether each segment was re-rendered:

```ts
{
  segmentKeys: ["root", "root/posts", "root/posts/post-detail"],
  segments: {
    "root/posts/post-detail": <PostDetail params={{ id: "3" }} />
  }
}
```

This array is essential for the client merge step -- it tells the client which segments should exist in the final state.

### Step 6: Client Merges Segments

The client iterates over the `segmentKeys` array and builds the new segment map:

```ts
for (const key of segmentKeys) {
  if (newSegments[key] !== undefined) {
    // Use the newly rendered segment from the server
    mergedSegments[key] = newSegments[key];
  } else {
    // Keep the existing segment from the previous render
    mergedSegments[key] = previousSegments[key];
  }
}
```

Segments not listed in `segmentKeys` are discarded (they belong to the previous route and are no longer relevant).

## Initial Page Load

On the initial page load, there is no previous URL and no `X-RSC-Previous-URL` header. In this case:

- The server renders **all** segments for the requested URL
- No `segmentKeys` array is included in the response
- The client performs a **full replace** of the segment map (no merging)

This ensures the first load always produces a complete page, while subsequent navigations benefit from diffing.

## Benefits

| Aspect              | Without Diffing          | With Diffing                   |
| ------------------- | ------------------------ | ------------------------------ |
| Shared layout state | Lost on every navigation | Preserved across navigations   |
| Data transferred    | Full page payload        | Only changed segments          |
| Server render time  | All segments rendered    | Only changed segments rendered |
| Perceived speed     | Full page transition     | Instant for shared layouts     |

## Suspense Sentinels

When a route has a `loading` component configured, the client can provide immediate visual feedback during navigation without waiting for the server response.

Before the RSC payload request is sent, the client identifies segments that will change and have a loading boundary above them. These segments are replaced with **suspense sentinels** -- placeholder values that trigger the loading component's Suspense fallback. This happens synchronously, so the user sees the loading UI the instant they click a link.

```
Browser                          Server
  |                                |
  |  User clicks <Link to="/dashboard/analytics">
  |                                |
  |  [Immediately replace          |
  |   dashboard child segment      |
  |   with suspense sentinel]      |
  |                                |
  |  → Loading fallback visible    |
  |                                |
  |  GET /dashboard/analytics      |
  |  X-RSC: 1                     |
  |  ----------------------------→ |
  |                                |  Render changed segments
  |  ←---------------------------- |
  |  RSC payload (partial)         |
  |                                |
  |  Merge and replace sentinel    |
  |  with real content             |
```

Sentinels only apply to segments below a loading boundary. Segments without a loading boundary above them continue to use the standard behavior (content remains visible until the new content arrives).

## Edge Cases

### Dynamic Params Change at the Same Level

When navigating from `/posts/3` to `/posts/7`, the `root/posts/post-detail` segment exists in both the old and new URL, but with different params. The server detects the param change and re-renders that segment while preserving `root` and `root/posts`.

### Complete Route Change

When navigating between entirely different route branches (e.g., `/posts` to `/about`), most segments will be new. Only truly shared ancestors (like the root layout) are preserved.

### Back/Forward Navigation

Browser back/forward navigation follows the same diffing logic. The client sends the current URL as `X-RSC-Previous-URL`, and the server diffs against the target URL from the history entry.

## See also

- [How It Works](./how-it-works.md) — high-level architecture and request flow
- [Build Pipeline](./build-pipeline.md) — the 5-phase production build process
- [Navigation & Links](../guides/navigation-and-links.md) — client-side navigation that triggers segment diffing
