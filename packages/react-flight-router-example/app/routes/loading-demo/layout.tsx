import { Outlet } from "react-flight-router/client";

export default function LoadingDemoLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Loading Boundary Demo</h1>
      <p className="text-sm text-gray-500 mb-6">
        This route has a <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">loading</code>{" "}
        component in its route config. When navigating to the child route, a skeleton loading state
        appears immediately — before the server responds.
      </p>
      <Outlet />
    </main>
  );
}
