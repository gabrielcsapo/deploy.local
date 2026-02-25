---
title: "Data Fetching"
description: "Fetch data directly in your route components using async/await, with no client-side state management required. Flight Router streams server-rendered content as data resolves."
---

# Data Fetching

Flight Router route components are React Server Components. This means you can use `async`/`await` directly in your components to fetch data on the server -- no `useEffect`, `useState`, or third-party data fetching libraries required.

## Fetching data in a route component

Any route component can be an `async` function. Use standard `fetch` calls (or any async operation) directly in the component body:

```tsx
interface Post {
  id: number;
  title: string;
  body: string;
}

export default async function PostsPage() {
  const res = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=10");
  const posts: Post[] = await res.json();

  return (
    <div>
      <h1>Recent Posts</h1>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>
            <h2>{post.title}</h2>
            <p>{post.body.slice(0, 120)}...</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

The data is fetched entirely on the server. The client never sees the fetch call or the raw API response -- it only receives the rendered HTML and RSC payload.

## Using route params

Dynamic route segments are passed to your component as a `params` prop with the type `Record<string, string>`. Use them to fetch data for a specific resource:

```tsx
export default async function PostPage({ params }: { params: Record<string, string> }) {
  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${params.id}`);
  const post = await res.json();

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}
```

When the URL is `/posts/42`, the component receives `{ params: { id: "42" } }`. The param names correspond to the dynamic segments defined in your [route configuration](./routing.md) (e.g., `:id` becomes `params.id`).

## Parallel data fetching

When you need to fetch multiple resources, use `Promise.all` to run requests in parallel and avoid waterfalls:

```tsx
export default async function PostDetailPage({ params }: { params: Record<string, string> }) {
  const [postRes, commentsRes] = await Promise.all([
    fetch(`https://jsonplaceholder.typicode.com/posts/${params.id}`),
    fetch(`https://jsonplaceholder.typicode.com/posts/${params.id}/comments`),
  ]);

  const post = await postRes.json();
  const comments = await commentsRes.json();

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>

      <h2>Comments ({comments.length})</h2>
      <ul>
        {comments.map((c: { id: number; name: string; body: string }) => (
          <li key={c.id}>
            <strong>{c.name}</strong>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
```

Both the post and its comments are fetched at the same time, cutting the total wait time roughly in half compared to sequential requests.

## Streaming

Flight Router streams the RSC response to the client as each part of the component tree resolves. This means:

- **No waterfall**: Nested layouts and their children can fetch data independently. Each segment renders as soon as its data is ready.
- **Fast first paint**: The shell of the page (layouts, static content) appears immediately while async content is still loading.
- **No loading spinners required**: In many cases, data resolves quickly enough on the server that the user sees the complete page. For slower requests, you can use React's `<Suspense>` to show a fallback.

```tsx
import { Suspense } from "react";

export default function PostsLayout() {
  return (
    <main>
      <h1>Blog</h1>
      <Suspense fallback={<p>Loading posts...</p>}>
        <PostsList />
      </Suspense>
    </main>
  );
}

async function PostsList() {
  const res = await fetch("https://jsonplaceholder.typicode.com/posts");
  const posts = await res.json();

  return (
    <ul>
      {posts.map((post: { id: number; title: string }) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

The layout renders immediately with the "Loading posts..." fallback, and the posts list streams in once the fetch completes.

## What you do not need

Because route components run on the server, you can drop the client-side data fetching patterns you may be used to:

| Pattern                  | Still needed?                       |
| ------------------------ | ----------------------------------- |
| `useEffect` + `fetch`    | No                                  |
| `useState` for data      | No                                  |
| `useSWR` / `react-query` | No                                  |
| Loading state management | No (use `<Suspense>` if needed)     |
| API route for data proxy | No (fetch directly from the server) |

Your components simply declare what data they need, fetch it, and return JSX. The framework handles streaming, serialization, and hydration.

## Accessing databases and private APIs

Since route components execute on the server, you can safely access databases, internal APIs, or read environment variables without exposing them to the client:

```tsx
export default async function AdminPage() {
  // This code runs only on the server
  const db = await connectToDatabase();
  const users = await db.query("SELECT * FROM users LIMIT 50");

  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
        </tr>
      </thead>
      <tbody>
        {users.map((user: { id: number; name: string; email: string }) => (
          <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.email}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

The database query and its results never leave the server. The client only receives the rendered table markup.
