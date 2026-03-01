export default function Home() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Home</h1>
      <p className="text-gray-600" data-testid="server-time">
        Server rendered at {new Date().toISOString()}
      </p>
      <p className="text-gray-500 mt-2">
        This page renders quickly and is used to verify that slow server actions on worker threads
        do not block page rendering.
      </p>
    </div>
  );
}
