'use client';

import { useState, useActionState } from 'react';
import { addComment } from './post-actions.js';

export function LikeButton({ postId }: { postId: number }) {
  const [liked, setLiked] = useState(false);

  return (
    <div className="my-4">
      <button
        className={`px-4 py-2 text-white rounded cursor-pointer ${liked ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'}`}
        onClick={() => setLiked((l) => !l)}
      >
        {liked ? 'Liked' : 'Like'}
      </button>
    </div>
  );
}

export function CommentForm({ postId }: { postId: number }) {
  const [comments, formAction, isPending] = useActionState(addComment, []);

  return (
    <div className="border border-gray-200 rounded-lg p-6 bg-white mt-6">
      <h3 className="text-lg font-semibold mb-3">Add a Comment</h3>
      <form action={formAction}>
        <input type="hidden" name="postId" value={postId} />
        <div className="flex flex-col gap-2">
          <input
            name="name"
            placeholder="Your name"
            className="px-3 py-2 border border-gray-300 rounded text-base"
          />
          <input
            name="body"
            placeholder="Your comment"
            className="px-3 py-2 border border-gray-300 rounded text-base"
          />
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer self-start"
          >
            {isPending ? 'Posting...' : 'Post Comment'}
          </button>
        </div>
      </form>

      {comments.length > 0 && (
        <div className="mt-4">
          <h4 className="font-semibold mb-2">Your Comments</h4>
          <ul className="space-y-2">
            {comments.map((c, i) => (
              <li key={i} className="text-sm">
                <strong>{c.name}</strong>: {c.body}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
