import { Outlet } from "react-flight-router/client";

export default function ErrorDemoLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Error Boundary Demo</h1>
      <p className="text-sm text-gray-500 mb-6">
        This route has an <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">error</code>{" "}
        component in its route config. When a child route throws during rendering, the error
        boundary catches it and shows a fallback.
      </p>
      <Outlet />
    </main>
  );
}
