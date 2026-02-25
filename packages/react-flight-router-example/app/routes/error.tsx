import { Link } from "react-flight-router/client";
import "./error.css";

export default function ErrorPage({ error }: { error?: Error }) {
  return (
    <main className="max-w-3xl mx-auto p-8 text-center">
      <div className="error-page" data-testid="error-content">
        <h1 className="text-6xl font-bold text-red-300 mb-4">500</h1>
        <h2 className="text-2xl font-semibold mb-2">Something Went Wrong</h2>
        <p className="text-gray-600 mb-6">{error?.message ?? "An unexpected error occurred."}</p>
        <Link to="/" className="text-blue-600 hover:underline">
          Go home
        </Link>
      </div>
    </main>
  );
}
