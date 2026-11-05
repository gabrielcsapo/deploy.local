import { PerfDashboard } from "./perf-dashboard.client.js";

export default function PerfPage() {
  return (
    <main className="max-w-5xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Performance Dashboard</h1>
      <p className="text-sm text-gray-500 mb-6">
        Live view of request timing data from the{" "}
        <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">onRequestComplete</code>{" "}
        callback. Navigate around the app to see events appear.
      </p>
      <PerfDashboard />
    </main>
  );
}
