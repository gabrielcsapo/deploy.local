import { Link, Outlet } from 'flight-router/client';

export default function PostsLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Blog</h1>
      <nav className="mb-6">
        <Link to="/posts">All Posts</Link>
      </nav>
      <Outlet />
    </main>
  );
}
