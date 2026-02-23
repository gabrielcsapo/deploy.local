import { Link, Outlet } from 'flight-router/client';

export default function DashboardLayout() {
  return (
    <main>
      <h1>Dashboard</h1>
      <p className="timestamp">Layout rendered at {new Date().toISOString()}</p>

      <nav style={{ margin: '1rem 0' }}>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link to="/dashboard">Overview</Link>
          <Link to="/dashboard/settings">Settings</Link>
        </div>
      </nav>

      <div className="card">
        <Outlet />
      </div>
    </main>
  );
}
