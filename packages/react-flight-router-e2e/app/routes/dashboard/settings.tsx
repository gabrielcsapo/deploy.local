import { Counter } from '../counter.client.js';

export default function DashboardSettings() {
  return (
    <div>
      <h2>Settings</h2>
      <p>This is the settings page within the dashboard layout.</p>
      <p className="timestamp">Rendered at {new Date().toISOString()}</p>

      <div style={{ marginTop: '1rem' }}>
        <h3>Interactive Widget</h3>
        <Counter />
      </div>
    </div>
  );
}
