import { Link } from "flight-router/client";

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  website: string;
  company: { name: string };
}

interface Post {
  id: number;
  title: string;
  body: string;
}

export default async function UserDetailPage({ params }: { params: Record<string, string> }) {
  const userId = params.id;

  const [userRes, postsRes] = await Promise.all([
    fetch(`https://jsonplaceholder.typicode.com/users/${userId}`),
    fetch(`https://jsonplaceholder.typicode.com/users/${userId}/posts`),
  ]);

  const user: User = await userRes.json();
  const posts: Post[] = await postsRes.json();

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-1">{user.name}</h1>
      <p className="text-sm text-gray-500 mb-4">@{user.username}</p>

      <div className="border border-gray-200 rounded-lg p-5 bg-white mb-6">
        <p className="mb-1">
          <span className="font-medium">Email:</span> {user.email}
        </p>
        <p className="mb-1">
          <span className="font-medium">Phone:</span> {user.phone}
        </p>
        <p className="mb-1">
          <span className="font-medium">Website:</span> {user.website}
        </p>
        <p>
          <span className="font-medium">Company:</span> {user.company.name}
        </p>
      </div>

      <h2 className="text-xl font-semibold mb-4">Posts by {user.name}</h2>
      <ul className="space-y-4">
        {posts.map((post) => (
          <li key={post.id} className="border border-gray-200 rounded-lg p-5 bg-white">
            <Link to={`/posts/${post.id}`}>
              <h3 className="text-lg font-medium text-blue-600 hover:underline mb-1">
                {post.title}
              </h3>
            </Link>
            <p className="text-gray-600 text-sm">{post.body.slice(0, 120)}...</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
