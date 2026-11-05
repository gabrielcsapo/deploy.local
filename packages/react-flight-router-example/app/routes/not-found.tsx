import { Link } from "react-flight-router/client";

export default function NotFound() {
  return (
    <main className="max-w-3xl mx-auto p-8 text-center">
      <h1 className="text-6xl font-bold text-gray-300 mb-4">404</h1>
      <h2 className="text-2xl font-semibold mb-2">Page Not Found</h2>
      <p className="text-gray-600 mb-6">The page you're looking for doesn't exist.</p>
      <Link to="/" className="text-blue-600 hover:underline">
        Go home
      </Link>
    </main>
  );
}
