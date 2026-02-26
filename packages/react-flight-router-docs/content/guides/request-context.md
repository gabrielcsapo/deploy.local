---
title: "Request Context"
description: "Learn how to use the onRequest callback with AsyncLocalStorage to provide per-request context (cookies, headers, auth) to server components and server actions."
---

# Request Context

Server components and server actions often need access to per-request data like cookies, headers, or authentication state. React Flight Router provides the `onRequest` callback for this purpose.

## The Problem

Server components render on the server and have no built-in way to access the incoming HTTP request. If you need to read a session cookie to determine who is logged in, or check a header for authorization, you need a way to thread that request through to your server code.

## The Solution: `onRequest` + `AsyncLocalStorage`

The `onRequest` callback is called before every RSC/SSR render with the incoming `Request` object. Combined with Node.js `AsyncLocalStorage`, it lets you store the request in a context that any server component or server action can read synchronously during rendering.

```
Request → onRequest(request) → AsyncLocalStorage.enterWith(request)
                                        ↓
                              Server Component renders
                                        ↓
                              getStore() → Request (cookies, headers, etc.)
```

## Setup

### 1. Create a request context module

Create a module that holds the `AsyncLocalStorage` instance and a helper to read from it:

```ts
// app/lib/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__my_app_request_storage__";

export const requestStorage: AsyncLocalStorage<Request> = ((globalThis as any)[GLOBAL_KEY] ??=
  new AsyncLocalStorage<Request>());

export function getRequest(): Request | undefined {
  return requestStorage.getStore();
}
```

**Why `globalThis`?** The RSC server bundle (built with `react-server` conditions) and your server entry are separate bundles. Each gets its own copy of this module. Without a `globalThis` singleton, `enterWith()` in the server entry sets one `AsyncLocalStorage` instance while `getRequest()` in a server component reads from a different one.

### 2. Wire up `onRequest` in development

In your `vite.config.ts`, pass `onRequest` to the `flightRouter` plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "react-flight-router/dev";
import { requestStorage } from "./app/lib/request-context";

export default defineConfig({
  plugins: [
    react(),
    flightRouter({
      routesFile: "./app/routes.ts",
      onRequest: (request) => {
        requestStorage.enterWith(request);
      },
    }),
  ],
});
```

### 3. Wire up `onRequest` in production

In your `server.ts`, pass `onRequest` to `createServer`:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";
import { requestStorage } from "./app/lib/request-context";

const app = await createServer({
  buildDir: "./dist",
  onRequest: (request) => {
    requestStorage.enterWith(request);
  },
});

serve({ fetch: app.fetch, port: 3000 });
```

## Example: Authentication

A common use case is reading a session cookie in server components to determine the current user.

### Reading cookies in a server component

```ts
// app/lib/session.ts
import { getRequest } from "./request-context";

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function getSessionUser() {
  const req = getRequest();
  if (!req) return null;

  const cookieHeader = req.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "session");
  if (!token) return null;

  // Look up session in your database...
  const session = await validateSession(token);
  if (!session) return null;

  // Return the user
  return await findUser(session.userId);
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

Use `window.location.href` (full page reload) instead of client-side `navigate()` after login/logout. Server components that call `getSessionUser()` only run on initial page load or RSC navigation -- they don't re-run when client state changes. A full reload ensures the root layout re-renders with the new auth state.

## Using with Hono API Routes

If your app has API routes (e.g., using Hono), mount them **before** the flight router so they can handle `/api/*` requests. Both the API routes and server components can read from the same session cookie:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "react-flight-router/server";
import { requestStorage } from "./app/lib/request-context";
import { apiApp } from "./app/api/app";

const flightApp = await createServer({
  buildDir: "./dist",
  onRequest: (request) => {
    requestStorage.enterWith(request);
  },
});

const app = new Hono();

// API routes first (they handle /api/* and set cookies)
app.route("/", apiApp);

// Flight router handles everything else (RSC, SSR, static assets)
app.route("/", flightApp);

serve({ fetch: app.fetch, port: 3000 });
```

## Important Notes

- **`onRequest` fires for all request types**: initial page loads (`*`), RSC navigation (`/__rsc`), and server actions (`/__action`). This ensures `getRequest()` works everywhere.
- **Use `enterWith()`, not `run()`**: The framework controls the async scope for rendering. `enterWith()` sets the store for the remainder of the current async context, which is what you want since `onRequest` is called as middleware before the render pipeline.
- **The `Request` object is read-only**: In dev mode, a lightweight `Request` is constructed from the Node.js `IncomingMessage` with headers and method. In production, the raw Hono request is passed through. Do not attempt to read the body -- it may have already been consumed by the framework.
