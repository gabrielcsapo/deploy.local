---
title: "SSR"
description: "How Flight Router handles server-side rendering for fast initial page loads and SEO, with zero-waterfall hydration powered by RSC."
---

# Server-Side Rendering (SSR)

Flight Router includes built-in server-side rendering. On initial page load, the server renders your application to full HTML so the browser can display content immediately. The client then hydrates the HTML to make it interactive. No configuration is required.

## How It Works

When a user requests a page, Flight Router performs these steps:

1. **RSC rendering** -- The server renders your React Server Components into an RSC payload (a serialized representation of the component tree).
2. **HTML generation** -- The RSC payload is deserialized and rendered to an HTML stream using `react-dom/server`.
3. **RSC payload inlining** -- The RSC payload is embedded in the HTML as `<script>` tags so the client does not need a separate fetch to begin hydration.
4. **Streaming to the client** -- The HTML is streamed to the browser for fast First Contentful Paint (FCP).
5. **Client hydration** -- The client-side React picks up the inlined RSC payload and hydrates the HTML, attaching event handlers and enabling interactivity.

This architecture eliminates the client-server waterfall that traditional SSR approaches suffer from. The RSC payload is already in the HTML, so hydration can begin immediately without waiting for additional network requests.

## Production Builds

The `react-flight-router build` command generates everything needed for SSR automatically:

```bash
pnpm react-flight-router build
```

The build pipeline produces:

- **RSC bundle** -- Server components bundled with the `react-server` condition.
- **Client bundle** -- Client components optimized for the browser.
- **SSR bundle** -- Client components bundled for server-side rendering.
- **Manifests** -- Mapping files that connect RSC references to client and SSR chunks.
- **Server entry** -- The production server that handles requests and performs SSR.

Start the production server:

```bash
node dist/server.js
```

Every page request is server-rendered with the full HTML content.

## Dev Mode SSR

SSR also works in development mode. When you run the dev server, initial page loads are server-rendered just like in production. This means you can develop and debug SSR behavior without running a production build.

```bash
pnpm dev
```

Vite's HMR (Hot Module Replacement) continues to work as expected during development, and the page will hot-reload when you make changes.

## SEO Benefits

Because the server sends fully rendered HTML, search engine crawlers receive complete page content on the initial request. This provides several SEO advantages:

- **Full content indexing** -- Crawlers see the complete page content without executing JavaScript.
- **Fast FCP** -- The Time to First Contentful Paint is minimized since the browser can render the HTML stream as it arrives.
- **Meta tags** -- Any `<title>`, `<meta>`, or other head elements defined in your root layout are present in the initial HTML.

## Client Hydration

After the browser receives the server-rendered HTML, the client entry script runs and hydrates the page. During hydration, React attaches event handlers to the existing DOM and makes the page interactive.

The client detects that SSR has occurred and uses `hydrateRoot` instead of `createRoot`, which preserves the server-rendered DOM rather than replacing it:

```tsx
// This is handled internally by Flight Router.
// You do not need to write this code.
import { hydrateRoot } from "react-dom/client";

hydrateRoot(document, <App />);
```

Users see content instantly and can interact with it as soon as hydration completes.

## Streaming

Flight Router streams the HTML response to the client. This means the browser can start parsing and rendering HTML before the entire response is complete. If your components use `<Suspense>` boundaries, content within those boundaries will be streamed in as it resolves.

```tsx
import { Suspense } from "react";

export default function PostsPage() {
  return (
    <div>
      <h1>Posts</h1>
      <Suspense fallback={<p>Loading posts...</p>}>
        <PostsList />
      </Suspense>
    </div>
  );
}

async function PostsList() {
  const posts = await fetchPosts();
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

The `<h1>Posts</h1>` heading and the `"Loading posts..."` fallback are sent immediately, and the actual posts list is streamed in once the data resolves.
