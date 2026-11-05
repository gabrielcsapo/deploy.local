import { Link } from "../router";

export function NotFoundPage() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">This page could not be found.</p>
      <Link
        to="/"
        className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2 rounded-lg transition-colors"
      >
        Go Home
      </Link>
    </div>
  );
}
