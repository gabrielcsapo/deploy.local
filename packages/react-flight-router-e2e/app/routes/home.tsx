import { MessageBoard } from './counter.client.js';

export default async function HomePage() {
  return (
    <main>
      <h1>Home</h1>
      <p className="timestamp">Server rendered at {new Date().toISOString()}</p>
      <p>This is a server component. The timestamp above is generated on the server.</p>

      <MessageBoard />
    </main>
  );
}
