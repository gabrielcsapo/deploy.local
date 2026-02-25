import { Link } from "react-flight-router/client";

export default function DashboardNotFound() {
  return (
    <div className="text-center py-8">
      <h2 className="text-xl font-semibold mb-2">Dashboard Page Not Found</h2>
      <p className="text-gray-600 mb-4">This dashboard section doesn't exist.</p>
      <Link to="/dashboard" className="text-blue-600 hover:underline">
        Back to Dashboard
      </Link>
    </div>
  );
}
