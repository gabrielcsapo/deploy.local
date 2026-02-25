const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function SlowPage() {
  const start = Date.now();
  await delay(3000);
  const elapsed = Date.now() - start;

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Slow Page</h1>
      <p className="text-sm text-gray-500 mb-6">Server rendered at {new Date().toISOString()}</p>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 mb-6">
        <h2 className="text-lg font-semibold text-amber-800 mb-2">Simulated Slow Response</h2>
        <p className="text-amber-700">
          This page waited <span className="font-mono font-bold">{elapsed}ms</span> on the server
          before rendering. While it loaded, the nav link showed a pending state with a pulsing
          animation.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <ul className="space-y-2 text-gray-700">
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">1.</span>
            You clicked the "Slow" link in the nav
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">2.</span>
            The Link's <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">
              isPending
            </code>{" "}
            became true immediately
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">3.</span>
            The server component awaited a 3s delay before returning RSC payload
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">4.</span>
            Once the payload arrived, React committed the update and{" "}
            <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">isPending</code> became
            false
          </li>
        </ul>
      </div>
    </main>
  );
}
