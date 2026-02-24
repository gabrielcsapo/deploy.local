"use server";

interface UserComment {
  name: string;
  body: string;
  postId: number;
}

const commentsByPost = new Map<number, UserComment[]>();

export async function addComment(
  prevState: UserComment[],
  formData: FormData,
): Promise<UserComment[]> {
  const postId = Number(formData.get("postId"));
  const name = (formData.get("name") as string)?.trim();
  const body = (formData.get("body") as string)?.trim();

  if (name && body) {
    if (!commentsByPost.has(postId)) {
      commentsByPost.set(postId, []);
    }
    commentsByPost.get(postId)!.push({ name, body, postId });
  }

  return [...(commentsByPost.get(postId) ?? [])];
}
