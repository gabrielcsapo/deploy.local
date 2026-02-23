import { Counter } from './counter.client.js';

export default function AboutPage() {
  return (
    <main>
      <h1>About</h1>
      <p className="timestamp">Server rendered at {new Date().toISOString()}</p>
      <p>
        This page demonstrates mixing server and client components.
        The text above is rendered on the server, while the counter below is a client component.
      </p>

      <div className="card">
        <h2>Client Component</h2>
        <Counter />
      </div>
    </main>
  );
}
