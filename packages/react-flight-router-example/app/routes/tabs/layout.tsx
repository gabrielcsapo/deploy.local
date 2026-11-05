import { Outlet } from "react-flight-router/client";
import { TabsNav } from "./nav.client";

export default function TabsLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8" data-testid="tabs-layout">
      <h1 className="text-3xl font-bold mb-2">Tabs</h1>
      <p className="text-sm text-gray-500 mb-4" data-testid="tabs-layout-timestamp">
        Layout rendered at {new Date().toISOString()}
      </p>

      <TabsNav />

      <div
        className="border border-gray-200 rounded-lg p-6 bg-white mt-4"
        data-testid="tabs-content"
      >
        <Outlet />
      </div>
    </main>
  );
}
