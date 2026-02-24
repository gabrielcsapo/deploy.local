import { Link, Outlet } from 'flight-router/client';

export default function DashboardLayout() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-4">Layout rendered at {new Date().toISOString()}</p>

      <nav className="my-4">
        <div className="flex gap-4">
          <Link to="/dashboard">Overview</Link>
          <Link to="/dashboard/settings">Settings</Link>
        </div>
      </nav>

      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <Outlet />
      </div>
    </main>
  );
}
