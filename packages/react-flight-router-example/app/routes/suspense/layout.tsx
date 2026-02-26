import { Outlet } from "react-flight-router/client";

export default function SuspenseLayout() {
  return (
    <main className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Suspense Examples</h1>
      <p className="text-sm text-gray-500 mb-6">
        Demonstrates how React Suspense integrates with server component streaming.
      </p>
      <Outlet />
    </main>
  );
}
