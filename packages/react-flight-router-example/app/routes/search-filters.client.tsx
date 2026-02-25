"use client";

import { useSearchParams } from "react-flight-router/client";

export function SearchFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = searchParams.get("sort") ?? "newest";
  const q = searchParams.get("q") ?? "";

  return (
    <div data-testid="search-filters" className="space-y-4">
      <div className="flex gap-4 text-sm">
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 font-medium text-blue-700"
          data-testid="current-sort"
        >
          Sort: {sort}
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 font-medium text-gray-700"
          data-testid="current-query"
        >
          Query: {q || <span className="italic text-gray-400">none</span>}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          data-testid="sort-oldest"
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            sort === "oldest"
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set("sort", "oldest");
            setSearchParams(next);
          }}
        >
          Sort Oldest
        </button>
        <button
          data-testid="sort-newest"
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            sort === "newest"
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set("sort", "newest");
            setSearchParams(next);
          }}
        >
          Sort Newest
        </button>
        <button
          data-testid="set-query"
          className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
          onClick={() => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("q", "hello");
              return next;
            });
          }}
        >
          Set Query
        </button>
        <button
          data-testid="clear-params"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
          onClick={() => {
            setSearchParams(new URLSearchParams());
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
