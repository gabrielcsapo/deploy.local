import { Link } from "react-flight-router/client";
import { fetchPosts } from "../../lib/fake-api.js";

export default async function PostsIndexPage() {
  const posts = await fetchPosts(10);

  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">Recent Posts</h2>
      <p className="text-sm text-gray-500 mb-4">
        Fetched {posts.length} posts at {new Date().toISOString()}
      </p>
      <ul className="space-y-4">
        {posts.map((post) => (
          <li key={post.id} className="border border-gray-200 rounded-lg p-5 bg-white">
            <Link to={`/posts/${post.id}`}>
              <h3 className="text-lg font-medium text-blue-600 hover:underline mb-1">
                {post.title}
              </h3>
            </Link>
            <p className="text-gray-600 text-sm mb-2">{post.body.slice(0, 120)}...</p>
            <Link
              to={`/users/${post.userId}`}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              View Author
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
