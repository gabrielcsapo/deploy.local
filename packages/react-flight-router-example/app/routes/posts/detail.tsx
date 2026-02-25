import { Link } from "react-flight-router/client";
import { LikeButton, CommentForm } from "./post-interactions.client.js";

interface Post {
  id: number;
  title: string;
  body: string;
  userId: number;
}

interface Comment {
  id: number;
  name: string;
  email: string;
  body: string;
}

export default async function PostDetailPage({ params }: { params: Record<string, string> }) {
  const postId = params.id;

  const [postRes, commentsRes] = await Promise.all([
    fetch(`https://jsonplaceholder.typicode.com/posts/${postId}`),
    fetch(`https://jsonplaceholder.typicode.com/posts/${postId}/comments`),
  ]);

  const post: Post = await postRes.json();
  const comments: Comment[] = await commentsRes.json();

  return (
    <article>
      <h2 className="text-2xl font-bold mb-2">{post.title}</h2>
      <p className="text-sm text-gray-500 mb-4">
        Post #{post.id} &middot;{" "}
        <Link to={`/users/${post.userId}`} className="text-blue-600 hover:underline">
          View Author
        </Link>
      </p>
      <p className="mb-4 leading-relaxed">{post.body}</p>

      <LikeButton postId={post.id} />

      <h3 className="text-lg font-semibold mt-6 mb-3">Comments ({comments.length})</h3>
      <ul className="space-y-3">
        {comments.map((c) => (
          <li key={c.id} className="border border-gray-200 rounded-lg p-4 bg-white">
            <p className="font-medium text-sm mb-1">{c.name}</p>
            <p className="text-gray-600 text-sm">{c.body}</p>
          </li>
        ))}
      </ul>

      <CommentForm postId={post.id} />
    </article>
  );
}
