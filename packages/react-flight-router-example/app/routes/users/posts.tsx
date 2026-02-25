import { Link } from "react-flight-router/client";

interface Post {
  id: number;
  title: string;
  body: string;
}

export default async function UserPostsPage({ params = {} }: { params?: Record<string, string> }) {
  const userId = params.id;

  const postsRes = await fetch(`https://jsonplaceholder.typicode.com/users/${userId}/posts`);
  const posts: Post[] = await postsRes.json();

  return (
    <div>
      <p data-testid="user-posts-params-id">User ID: {userId}</p>
      <h2 className="text-xl font-semibold mb-4">Posts</h2>
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
    </div>
  );
}
