---
title: "Redirects"
description: "Redirect users from server components using the redirect() function. Works for both initial page loads and client-side navigation without extra round trips."
---

# Redirects

The `redirect()` function lets you redirect the user to a different URL directly from a server component. It works for both the initial page load (SSR) and client-side navigation.

## Basic usage

Import `redirect` from `"react-flight-router/server"` and call it inside any server component:

```tsx
import { redirect } from "react-flight-router/server";

export default async function ProtectedPage() {
  const session = await getSession();
  if (!session) return redirect("/login");

  return <div>Welcome back, {session.user}!</div>;
}
```

Writing `return redirect(...)` makes the early-exit intent clear — it reads like any other early return in a component. The `return` is never actually reached (the function throws internally), but `redirect()` is typed as `never` so TypeScript understands execution stops either way.

## Status codes

The default status code is `302` (temporary redirect). Pass `301` as the second argument for a permanent redirect:

```tsx
// 302 — temporary (default)
return redirect("/login");

// 301 — permanent
return redirect("/new-location", 301);
```

Use `301` for content that has permanently moved (e.g., a renamed route). Use `302` for conditional redirects like auth guards.

## How it works

### Initial page load (SSR)

When a redirect is detected during the initial page load, the server renders the redirect destination page directly and returns it with a `200` status. On hydration, the client router updates the browser URL to the destination via `history.replaceState`.

This avoids the extra round trip that a traditional `302` response would require — the browser receives the destination page content in the very first response.

### Client-side navigation

When the user navigates to a redirecting page via a `<Link>` click or programmatic `navigate()`, the server includes the redirect information in the RSC payload. The client router reads it and navigates to the destination using `replace: true`, so the redirect source is not added to the browser history.

## Auth guard example

A common use case is protecting routes that require authentication:

```tsx
// app/lib/session.ts
import { getRequest } from "react-flight-router/server";

export async function requireSession() {
  const req = getRequest();
  const cookie = req?.headers.get("Cookie") ?? "";
  const token = parseCookie(cookie, "session");
  if (!token) return null;
  return validateToken(token);
}
```

```tsx
// app/routes/dashboard.tsx
import { redirect } from "react-flight-router/server";
import { requireSession } from "../lib/session.js";

export default async function Dashboard() {
  const session = await requireSession();
  if (!session) return redirect("/login?from=/dashboard");

  return <div>Dashboard for {session.user}</div>;
}
```

## Redirect after a server action

`redirect()` also works inside `"use server"` functions. This is useful for redirecting after a form submission:

```tsx
// app/routes/new-post.ts
"use server";

import { redirect } from "react-flight-router/server";

export async function createPost(formData: FormData) {
  const title = formData.get("title") as string;
  const post = await db.posts.create({ title });
  return redirect(`/posts/${post.id}`);
}
```

```tsx
// app/routes/new-post.tsx
import { createPost } from "./new-post.js";

export default function NewPost() {
  return (
    <form action={createPost}>
      <input name="title" placeholder="Post title" />
      <button type="submit">Create</button>
    </form>
  );
}
```

## Notes

- `redirect()` can only be called from server components and `"use server"` functions — not from client components.
- To redirect from a client component, use the `navigate` function from [`useRouter`](./navigation-and-links.md#programmatic-navigation) instead.
- Redirects from nested server components within a Suspense boundary are not currently supported. `redirect()` is detected at the route component level (the component registered in your routes file).

## See also

- [Request Context](./request-context.md) — access cookies and headers to determine redirect conditions
- [Server Actions](./server-actions.md) — redirect after form submissions
- [Navigation & Links](./navigation-and-links.md) — programmatic navigation from client components
