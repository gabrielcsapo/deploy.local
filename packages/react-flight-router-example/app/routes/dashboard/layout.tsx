import { Outlet } from "react-flight-router/client";
import { DashboardNav } from "../nav.client";

export default function DashboardLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-4">Layout rendered at {new Date().toISOString()}</p>

      <DashboardNav />

      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <Outlet />
      </div>
    </main>
  );
}
