---
title: "Request Context"
description: "Access the current HTTP request in server components and server actions using the built-in getRequest() API. No setup required."
---

# Request Context

Server components and server actions often need access to per-request data like cookies, headers, or authentication state. React Flight Router provides a built-in `getRequest()` function for this.

## Built-in `getRequest()`

Import `getRequest` from `react-flight-router/server` and call it in any server component or server action:

```ts
import { getRequest } from "react-flight-router/server";

export default async function MyComponent() {
  const request = getRequest();
  const cookie = request?.headers.get("Cookie");
  // ...
}
```

**No setup required.** The framework automatically populates `getRequest()` before every RSC render, SSR render, and server action — in both development and production. It also works in [worker-dispatched actions](/docs/guides/worker-threads).

## Example: Authentication

A common use case is reading a session cookie to determine the current user.

### Reading cookies in a server component

```ts
// app/lib/session.ts
import { getRequest } from "react-flight-router/server";

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function getSessionUser() {
  const req = getRequest();
  if (!req) return null;

  const cookieHeader = req.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "session");
  if (!token) return null;

  // Look up session in your database...
  return validateSession(token);
}
```

### Using in a server component

```tsx
// app/routes/root.tsx (server component)
import { getSessionUser } from "../lib/session";

export default async function Root({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <html>
      <body>
        <header>
          {user ? <span>Welcome, {user.username}</span> : <a href="/login">Sign in</a>}
        </header>
        {children}
      </body>
    </html>
  );
}
```

## Server Setup

### Minimal setup

Since `getRequest()` is built-in, you don't need any request context wiring:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

const app = await createServer({ buildDir: "./dist" });
serve({ fetch: app.fetch, port: 3000 });
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [react(), flightRouter()],
});
```

### With Hono API routes

Mount API routes before the flight router. Both API routes and server components can read from the same session cookie — API routes via Hono's `c.req`, server components via `getRequest()`:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "react-flight-router/server";
import { apiApp } from "./app/api";

const flightApp = await createServer({ buildDir: "./dist" });

const app = new Hono();
app.route("/", apiApp); // API routes first (handle /api/*)
app.route("/", flightApp); // Flight router handles everything else

serve({ fetch: app.fetch, port: 3000 });
```

## Cookie-Setting Operations

Server actions return RSC payloads (React Flight protocol), not HTTP responses. This means server actions **cannot set `Set-Cookie` headers**. For operations that need to set cookies (login, register, logout), use regular API endpoints instead:

```ts
// Client component
async function handleLogin(username: string, password: string) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const result = await res.json();
  if (result.error) {
    // Handle error
    return;
  }
  // The server set the cookie via Set-Cookie header.
  // Full page reload to pick up the new session in server components.
  window.location.href = "/";
}
```

Use `window.location.href` (full page reload) instead of client-side `navigate()` after login/logout. Server components that call `getSessionUser()` only run on initial page load or RSC navigation — they don't re-run when client state changes. A full reload ensures the root layout re-renders with the new auth state.

## Custom Request Context (Advanced)

The `onRequest` callback is still available for setting up additional per-request context beyond the raw `Request`. For example, you might use it for logging, tracing, or populating a custom `AsyncLocalStorage`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [
    react(),
    flightRouter({
      onRequest: (request) => {
        // getRequest() is already populated — use onRequest for extras
        console.log(`[request] ${request.method} ${new URL(request.url).pathname}`);
      },
    }),
  ],
});
```

The same applies to `createServer` in production:

```ts
const app = await createServer({
  buildDir: "./dist",
  onRequest: (request) => {
    console.log(`[request] ${request.method} ${new URL(request.url).pathname}`);
  },
});
```

## Important Notes

- **`getRequest()` works everywhere**: initial page loads, RSC navigation, server actions, and worker-dispatched actions. No configuration needed.
- **The `Request` object is read-only**: In dev mode, a lightweight `Request` is constructed from the Node.js `IncomingMessage` with headers and method. In production, the raw Hono request is passed through. Do not attempt to read the body — it may have already been consumed by the framework.
- **`onRequest` fires before `getRequest()` is populated**: If you need the request in `onRequest`, use the `request` parameter passed to the callback.
