import { MessageBoard, ActionPropDemo } from "./counter.client.js";
import { addMessage } from "./actions.js";

export default async function HomePage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <div className="flex items-center gap-4 mb-4">
        <img
          src="/logo.svg"
          alt="React Flight Router logo"
          width={48}
          height={48}
          data-testid="home-logo"
        />
        <h1 className="text-3xl font-bold">Home</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">Server rendered at {new Date().toISOString()}</p>
      <p className="mb-4">
        This is a server component. The timestamp above is generated on the server.
      </p>

      <MessageBoard />

      <ActionPropDemo addMessage={addMessage} />
    </main>
  );
}
