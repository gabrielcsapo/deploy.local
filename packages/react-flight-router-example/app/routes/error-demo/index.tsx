import { Link } from "react-flight-router/client";

export default function ErrorDemoIndex() {
  return (
    <div data-testid="error-demo-index">
      <h2 className="text-xl font-semibold mb-4">Choose a scenario</h2>
      <div className="space-y-3">
        <Link
          to="/error-with-component/client-error"
          className="block rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 hover:bg-red-100"
          data-testid="nav-client-error"
        >
          Navigate to client-side error page →
        </Link>
      </div>
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="text-lg font-semibold mb-3">How it works</h3>
        <ul className="space-y-2 text-gray-700 text-sm">
          <li className="flex gap-2">
            <span className="text-red-500 font-bold">1.</span>
            Click the link above to navigate to a child that throws during render
          </li>
          <li className="flex gap-2">
            <span className="text-red-500 font-bold">2.</span>
            The route-config error boundary catches the error
          </li>
          <li className="flex gap-2">
            <span className="text-red-500 font-bold">3.</span>
            The error fallback component renders with the error message
          </li>
        </ul>
      </div>
    </div>
  );
}
