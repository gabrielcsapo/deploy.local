import { Counter } from "./counter.client.js";
import { SearchFilters } from "./search-filters.client.js";

export default function AboutPage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">About</h1>
      <p className="text-sm text-gray-500 mb-4">Server rendered at {new Date().toISOString()}</p>
      <p className="text-sm text-gray-400 mb-4" data-testid="app-version">
        Version: {__APP_VERSION__}
      </p>
      <p className="mb-4">
        This page demonstrates mixing server and client components. The text above is rendered on
        the server, while the counter below is a client component.
      </p>

      <div className="border border-gray-200 rounded-lg p-6 bg-white mb-4">
        <h2 id="client-component" className="text-xl font-semibold mb-2">
          Client Component
        </h2>
        <Counter />
      </div>

      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <h2 id="search-params" className="text-xl font-semibold mb-2">
          Search Params Demo
        </h2>
        <SearchFilters />
      </div>
    </main>
  );
}
