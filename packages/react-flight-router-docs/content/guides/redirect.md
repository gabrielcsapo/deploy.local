---
title: 'Redirects'
description: 'Redirect users with a redirect declared on a route, or from server components using the redirect() function. Works for both initial page loads and client-side navigation.'
---

# Redirects

There are two ways to send a visitor elsewhere: declare `redirect` on a route when the destination follows from the URL alone, or call `redirect()` in a server component when it depends on something else, such as a session.

## Declared redirects

A route with `redirect` has no component. A document request is answered with a real HTTP redirect (`308` unless you set `redirectStatus`), and client navigation follows it, keeping the URL's fragment as a browser does:

```ts
// app/routes.ts
export const routes: RouteConfig[] = [
  {
    id: 'root',
    path: '',
    component: () => import('./root.js'),
    children: [
      // A fixed destination.
      { id: 'old-about', path: 'about-us', redirect: '/about' },
      // A destination computed from the params and the request URL.
      {
        id: 'old-post',
        path: 'blog/:slug',
        redirectStatus: 301,
        redirect: ({ params, url }) => `/posts/${params.slug}${url.search}`,
      },
    ],
  },
];
```

The function runs on the server for each request it matches, so it can't read browser state such as local storage. When finding the destination needs that, render a client component that calls `navigate()` instead. If several routes in the matched chain declare `redirect`, the outermost one answers.

## `redirect()` in a server component

The `redirect()` function lets you redirect the user to a different URL directly from a server component. It works for both the initial page load (SSR) and client-side navigation.

## Basic usage

Import `redirect` from `"react-flight-router/server"` and call it inside any server component:

```tsx
import { redirect } from 'react-flight-router/server';

export default async function ProtectedPage() {
  const session = await getSession();
  if (!session) return redirect('/login');

  return <div>Welcome back, {session.user}!</div>;
}
```

Writing `return redirect(...)` makes the early-exit intent clear — it reads like any other early return in a component. The `return` is never actually reached (the function throws internally), but `redirect()` is typed as `never` so TypeScript understands execution stops either way.

## Status codes

The default status code is `302` (temporary redirect). Pass `301`, `307` or `308` as the second argument:

```tsx
// 302 — temporary (default)
return redirect('/login');

// 301 — permanent
return redirect('/new-location', 301);

// 307 and 308 — temporary and permanent, and the method is kept
return redirect('/new-location', 308);
```

Use `301` or `308` for content that has permanently moved (e.g., a renamed route). Use `302` or `307` for conditional redirects like auth guards. The status matters when the redirect is answered as a real HTTP redirect (another origin, or a long chain).

## How it works

### Initial page load (SSR)

When a redirect is detected during the initial page load, the server renders the redirect destination page directly and returns it with a `200` status. On hydration, the client router updates the browser URL to the destination via `history.replaceState`.

This avoids the extra round trip that a traditional `302` response would require — the browser receives the destination page content in the very first response.

A destination that redirects again is followed too, up to five hops, and `getRequest()` describes each hop's own URL. A redirect to another origin, or a chain longer than that, is answered with a real redirect with that status and a `Location` header, so the browser follows it (and applies its own loop limit).

### Client-side navigation

When the user navigates to a redirecting page via a `<Link>` click or programmatic `navigate()`, the server includes the redirect information in the RSC payload. The client router reads it and navigates to the destination using `replace: true`, so the redirect source is not added to the browser history.

## Auth guard example

A common use case is protecting routes that require authentication:

```tsx
// app/lib/session.ts
import { getRequest } from 'react-flight-router/server';

export async function requireSession() {
  const req = getRequest();
  const cookie = req?.headers.get('Cookie') ?? '';
  const token = parseCookie(cookie, 'session');
  if (!token) return null;
  return validateToken(token);
}
```

```tsx
// app/routes/dashboard.tsx
import { redirect } from 'react-flight-router/server';
import { requireSession } from '../lib/session.js';

export default async function Dashboard() {
  const session = await requireSession();
  if (!session) return redirect('/login?from=/dashboard');

  return <div>Dashboard for {session.user}</div>;
}
```

## Redirect after a server action

`redirect()` also works inside `"use server"` functions. This is useful for redirecting after a form submission. Called with JavaScript (`callServer`, `useActionState`), the action's promise resolves with `undefined` and the router navigates to the destination; a native form post without JavaScript gets a `303` to it:

```tsx
// app/routes/new-post.ts
'use server';

import { redirect } from 'react-flight-router/server';

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string;
  const post = await db.posts.create({ title });
  return redirect(`/posts/${post.id}`);
}
```

```tsx
// app/routes/new-post.tsx
import { createPost } from './new-post.js';

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
