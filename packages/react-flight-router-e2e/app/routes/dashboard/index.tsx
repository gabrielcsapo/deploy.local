export default function DashboardIndex() {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">Dashboard Overview</h2>
      <p className="mb-4">Welcome to the dashboard. This is a nested route inside the dashboard layout.</p>
      <p className="text-sm text-gray-500">Rendered at {new Date().toISOString()}</p>
    </div>
  );
}
