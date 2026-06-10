/**
 * Local stand-in for the remote JSON API the example previously fetched
 * (jsonplaceholder.typicode.com). Every accessor awaits a fake network
 * delay so the routes still behave like real async data fetching — they
 * suspend, stream, and exercise the same code paths — but with zero
 * external network dependency, so e2e runs are deterministic on CI.
 */

const NETWORK_DELAY_MS = 100;

function simulateRequest(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, NETWORK_DELAY_MS));
}

export interface Post {
  id: number;
  userId: number;
  title: string;
  body: string;
}

export interface Comment {
  id: number;
  postId: number;
  name: string;
  email: string;
  body: string;
}

export interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  website: string;
  company: { name: string };
}

const USERS: User[] = [
  {
    id: 1,
    name: "Avery Chen",
    username: "averyc",
    email: "avery.chen@example.com",
    phone: "555-0101",
    website: "averychen.example.com",
    company: { name: "Streamline Labs" },
  },
  {
    id: 2,
    name: "Jordan Patel",
    username: "jpatel",
    email: "jordan.patel@example.com",
    phone: "555-0102",
    website: "jordanpatel.example.com",
    company: { name: "Flightworks" },
  },
  {
    id: 3,
    name: "Sam Okafor",
    username: "sokafor",
    email: "sam.okafor@example.com",
    phone: "555-0103",
    website: "samokafor.example.com",
    company: { name: "Hydration Systems" },
  },
  {
    id: 4,
    name: "Riley Nakamura",
    username: "rnakamura",
    email: "riley.nakamura@example.com",
    phone: "555-0104",
    website: "rileynakamura.example.com",
    company: { name: "Suspense & Co" },
  },
];

const POST_TOPICS: [string, string][] = [
  [
    "Why streaming beats buffering",
    "Sending bytes as soon as they exist keeps the browser busy and the user informed. Buffering the whole response trades latency for nothing the user can see.",
  ],
  [
    "Server components and the data waterfall",
    "Fetching data where it is rendered avoids shipping fetching logic to the client, but it makes parallelism your responsibility. Promise.all is your friend.",
  ],
  [
    "Suspense boundaries as loading contracts",
    "A boundary is a promise to the user: this region will fill in. Place them around the slowest data, not around the whole page.",
  ],
  [
    "The case for partial navigation",
    "Re-rendering only the segments that changed keeps layouts stable, preserves client state, and cuts payload size on every click.",
  ],
  [
    "Module preloading in practice",
    "Telling the browser about chunks before it discovers them flattens the fetch waterfall and shaves real milliseconds off interactivity.",
  ],
  [
    "Designing error boundaries that help",
    "An error boundary should say what broke, keep the rest of the page working, and give the user a way forward.",
  ],
  [
    "Prefetching without regret",
    "Prefetch on intent, cap the cache, and expire entries. Stale data served instantly is worse than fresh data served quickly.",
  ],
  [
    "Render timeouts and runaway work",
    "A timeout that only races a response leaves the render burning CPU in the background. Abort signals finish the job.",
  ],
  [
    "Progressive enhancement still matters",
    "Forms that post without JavaScript keep working when bundles fail. The server action is the same either way.",
  ],
  [
    "Measuring before optimizing",
    "Chunk timestamps, resource timings, and CPU samples turn perf arguments into perf answers.",
  ],
];

const POSTS: Post[] = POST_TOPICS.map(([title, body], i) => ({
  id: i + 1,
  userId: (i % USERS.length) + 1,
  title,
  body,
}));

const COMMENT_AUTHORS = [
  ["Morgan Lee", "morgan.lee@example.com"],
  ["Casey Diaz", "casey.diaz@example.com"],
  ["Taylor Brooks", "taylor.brooks@example.com"],
  ["Jamie Park", "jamie.park@example.com"],
  ["Drew Castillo", "drew.castillo@example.com"],
] as const;

const COMMENT_BODIES = [
  "Great writeup — we hit exactly this in production last quarter.",
  "Curious how this interacts with HTTP/2 prioritization.",
  "The measurement section convinced me. Numbers over vibes.",
  "We adopted this pattern and our p95 dropped noticeably.",
  "Would love a follow-up post with a worked example.",
];

const COMMENTS: Comment[] = POSTS.flatMap((post) =>
  COMMENT_AUTHORS.map(([name, email], i) => ({
    id: (post.id - 1) * COMMENT_AUTHORS.length + i + 1,
    postId: post.id,
    name,
    email,
    body: COMMENT_BODIES[(post.id + i) % COMMENT_BODIES.length],
  })),
);

export async function fetchPosts(limit?: number): Promise<Post[]> {
  await simulateRequest();
  return limit ? POSTS.slice(0, limit) : [...POSTS];
}

export async function fetchPost(id: number | string): Promise<Post> {
  await simulateRequest();
  const post = POSTS.find((p) => p.id === Number(id));
  if (!post) throw new Error(`Post ${id} not found`);
  return post;
}

export async function fetchComments(postId: number | string): Promise<Comment[]> {
  await simulateRequest();
  return COMMENTS.filter((c) => c.postId === Number(postId));
}

export async function fetchRecentComments(limit?: number): Promise<Comment[]> {
  await simulateRequest();
  return limit ? COMMENTS.slice(0, limit) : [...COMMENTS];
}

export async function fetchUsers(limit?: number): Promise<User[]> {
  await simulateRequest();
  return limit ? USERS.slice(0, limit) : [...USERS];
}

export async function fetchUser(id: number | string): Promise<User> {
  await simulateRequest();
  const user = USERS.find((u) => u.id === Number(id));
  if (!user) throw new Error(`User ${id} not found`);
  return user;
}

export async function fetchUserPosts(userId: number | string): Promise<Post[]> {
  await simulateRequest();
  return POSTS.filter((p) => p.userId === Number(userId));
}
