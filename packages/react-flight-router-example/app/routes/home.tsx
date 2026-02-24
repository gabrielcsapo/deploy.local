import { MessageBoard } from "./counter.client.js";

export default async function HomePage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Home</h1>
      <p className="text-sm text-gray-500 mb-4">Server rendered at {new Date().toISOString()}</p>
      <p className="mb-4">
        This is a server component. The timestamp above is generated on the server.
      </p>

      <MessageBoard />
    </main>
  );
}
