import { Counter } from "../counter.client.js";

export default function DashboardSettings() {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">Settings</h2>
      <p className="mb-4">This is the settings page within the dashboard layout.</p>
      <p className="text-sm text-gray-500 mb-4">Rendered at {new Date().toISOString()}</p>

      <div className="mt-4">
        <h3 className="text-lg font-medium mb-2">Interactive Widget</h3>
        <Counter />
      </div>
    </div>
  );
}
