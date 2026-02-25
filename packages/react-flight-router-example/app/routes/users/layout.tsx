import { Link, Outlet } from "react-flight-router/client";

interface User {
  id: number;
  name: string;
  username: string;
}

export default async function UserLayout({ params = {} }: { params?: Record<string, string> }) {
  const userId = params.id;

  const userRes = await fetch(`https://jsonplaceholder.typicode.com/users/${userId}`);
  const user: User = await userRes.json();

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-1">{user.name}</h1>
      <p className="text-sm text-gray-500 mb-4">@{user.username}</p>

      <nav className="flex gap-4 mb-6 border-b border-gray-200 pb-3">
        <Link to={`/users/${userId}`} className="text-blue-600 hover:underline font-medium">
          Profile
        </Link>
        <Link to={`/users/${userId}/posts`} className="text-blue-600 hover:underline font-medium">
          Posts
        </Link>
      </nav>

      <Outlet />
    </main>
  );
}
