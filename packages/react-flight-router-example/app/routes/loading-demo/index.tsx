import { Link } from "react-flight-router/client";

export default function LoadingDemoIndex() {
  return (
    <div data-testid="loading-demo-index">
      <h2 className="text-xl font-semibold mb-4">Choose a page</h2>
      <div className="space-y-3">
        <Link
          to="/loading-with-component/slow-child"
          className="block rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-700 hover:bg-blue-100"
          data-testid="nav-slow-child"
        >
          Navigate to slow child page (3s delay) →
        </Link>
      </div>
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="text-lg font-semibold mb-3">How it works</h3>
        <ul className="space-y-2 text-gray-700 text-sm">
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">1.</span>
            Click the link above to navigate to a slow child route
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">2.</span>A loading skeleton appears
            immediately (before server responds)
          </li>
          <li className="flex gap-2">
            <span className="text-blue-500 font-bold">3.</span>
            After ~3s, the server content replaces the skeleton
          </li>
        </ul>
      </div>
    </div>
  );
}
