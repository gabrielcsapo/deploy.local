import { Suspense } from "react";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Async server components with simulated latency
// ---------------------------------------------------------------------------

async function SlowPosts() {
  await delay(5000);
  const res = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=5");
  const posts: { id: number; title: string }[] = await res.json();

  return (
    <ul data-testid="suspense-posts" className="space-y-2">
      {posts.map((post) => (
        <li key={post.id} className="border border-gray-200 rounded p-3 bg-white text-sm">
          {post.title}
        </li>
      ))}
    </ul>
  );
}

async function FastUsers() {
  await delay(2000);
  const res = await fetch("https://jsonplaceholder.typicode.com/users?_limit=4");
  const users: { id: number; name: string; email: string }[] = await res.json();

  return (
    <ul data-testid="suspense-users" className="space-y-2">
      {users.map((user) => (
        <li key={user.id} className="border border-gray-200 rounded p-3 bg-white text-sm">
          <span className="font-medium">{user.name}</span>
          <span className="text-gray-400 ml-2">{user.email}</span>
        </li>
      ))}
    </ul>
  );
}

async function OuterContent() {
  await delay(3000);

  return (
    <div data-testid="suspense-outer-content">
      <p className="text-sm text-gray-700 mb-3">
        This outer content resolved after ~3s. The comments below have their own Suspense boundary
        and are still loading...
      </p>
      <Suspense
        fallback={
          <div
            data-testid="suspense-fallback-inner"
            className="animate-pulse bg-gray-100 rounded p-4 text-sm text-gray-400"
          >
            Loading comments (inner boundary)...
          </div>
        }
      >
        <InnerComments />
      </Suspense>
    </div>
  );
}

async function InnerComments() {
  await delay(4000);
  const res = await fetch("https://jsonplaceholder.typicode.com/comments?_limit=3");
  const comments: { id: number; name: string; body: string }[] = await res.json();

  return (
    <ul data-testid="suspense-inner-comments" className="space-y-2">
      {comments.map((c) => (
        <li key={c.id} className="border border-gray-200 rounded p-3 bg-white text-sm">
          <p className="font-medium mb-1">{c.name}</p>
          <p className="text-gray-600">{c.body.slice(0, 100)}...</p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Shared loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton({ label, testId }: { label: string; testId?: string }) {
  return (
    <div data-testid={testId} className="animate-pulse space-y-2">
      <p className="text-sm text-gray-400">{label}</p>
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-gray-100 rounded p-3 h-10" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SuspenseIndexPage() {
  return (
    <div data-testid="suspense-page" className="space-y-10">
      {/* ---- Section 1: Basic Suspense ---- */}
      <section data-testid="suspense-section-basic">
        <h2 className="text-xl font-semibold mb-1">1. Basic Suspense</h2>
        <p className="text-sm text-gray-500 mb-4">
          A single <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{"<Suspense>"}</code>{" "}
          boundary wraps an async server component that fetches posts with a ~5s delay. The fallback
          is shown immediately while the server streams in the real content.
        </p>
        <Suspense
          fallback={<LoadingSkeleton label="Loading posts..." testId="suspense-fallback-posts" />}
        >
          <SlowPosts />
        </Suspense>
      </section>

      {/* ---- Section 2: Parallel Streaming ---- */}
      <section data-testid="suspense-section-parallel">
        <h2 className="text-xl font-semibold mb-1">2. Parallel Streaming</h2>
        <p className="text-sm text-gray-500 mb-4">
          Two independent Suspense boundaries side-by-side. Users (~2s) resolves before posts (~5s),
          demonstrating that each boundary streams independently.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Users (~2s)</h3>
            <Suspense
              fallback={
                <LoadingSkeleton label="Loading users..." testId="suspense-fallback-users" />
              }
            >
              <FastUsers />
            </Suspense>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Posts (~5s)</h3>
            <Suspense
              fallback={
                <LoadingSkeleton
                  label="Loading posts..."
                  testId="suspense-fallback-posts-parallel"
                />
              }
            >
              <SlowPosts />
            </Suspense>
          </div>
        </div>
      </section>

      {/* ---- Section 3: Nested Suspense ---- */}
      <section data-testid="suspense-section-nested">
        <h2 className="text-xl font-semibold mb-1">3. Nested Suspense</h2>
        <p className="text-sm text-gray-500 mb-4">
          An outer boundary resolves after ~3s revealing content that contains an inner boundary.
          The inner boundary then resolves after an additional ~4s. This demonstrates progressive
          disclosure — content appears in stages as each layer of data becomes available.
        </p>
        <Suspense
          fallback={
            <div
              data-testid="suspense-fallback-outer"
              className="animate-pulse bg-gray-100 rounded p-4 text-sm text-gray-400"
            >
              Loading outer content...
            </div>
          }
        >
          <OuterContent />
        </Suspense>
      </section>

      {/* ---- How it works ---- */}
      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <ul className="space-y-2 text-gray-700 text-sm">
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">1.</span>
            The server begins rendering all components in parallel.
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">2.</span>
            Synchronous content and Suspense fallbacks are sent to the browser immediately.
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">3.</span>
            As each async component resolves, its HTML is streamed in and replaces the fallback.
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">4.</span>
            Each <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">
              {"<Suspense>"}
            </code>{" "}
            boundary is independent — fast data appears without waiting for slow data.
          </li>
        </ul>
      </section>
    </div>
  );
}
