export default function DashboardIndex() {
  return (
    <div>
      <h2>Dashboard Overview</h2>
      <p>Welcome to the dashboard. This is a nested route inside the dashboard layout.</p>
      <p className="timestamp">Rendered at {new Date().toISOString()}</p>
    </div>
  );
}
