const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function SlowChildPage() {
  const start = Date.now();
  await delay(3000);
  const elapsed = Date.now() - start;

  return (
    <div data-testid="slow-child-content">
      <h2 className="text-xl font-semibold mb-4">Slow Child Page</h2>
      <div className="rounded-lg border border-green-200 bg-green-50 p-6">
        <p className="text-green-700">
          This page waited <span className="font-mono font-bold">{elapsed}ms</span> on the server.
          While it loaded, the route-config loading skeleton was shown automatically.
        </p>
        <p className="text-sm text-gray-500 mt-2">Server rendered at {new Date().toISOString()}</p>
      </div>
    </div>
  );
}
