import { useEffect, useRef, useState } from "react";
import { useSearch } from "../hooks/use-search";
import { useRouter } from "../router";

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { query, search, results, loading } = useSearch();
  const { navigate } = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Global keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) {
          onClose();
        } else {
          // Trigger open from parent — parent manages open state
          // This is handled by the header component
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      search("");
      setSelectedIndex(0);
    }
  }, [open, search]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      navigate(results[selectedIndex].item.path);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-xl">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Search input */}
          <div className="flex items-center border-b border-gray-200 dark:border-gray-700 px-4">
            <svg
              className="w-5 h-5 text-gray-400 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search documentation..."
              className="flex-1 px-3 py-4 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            <kbd className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-80 overflow-y-auto">
            {loading && <div className="p-4 text-center text-gray-500">Loading...</div>}

            {!loading && query && results.length === 0 && (
              <div className="p-4 text-center text-gray-500">No results found for "{query}"</div>
            )}

            {!loading && results.length > 0 && (
              <ul className="py-2">
                {results.map((result, i) => (
                  <li key={result.item.slug}>
                    <button
                      onClick={() => {
                        navigate(result.item.path);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(i)}
                      className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${
                        i === selectedIndex
                          ? "bg-blue-50 dark:bg-blue-950"
                          : "hover:bg-gray-50 dark:hover:bg-gray-800"
                      }`}
                    >
                      <svg
                        className="w-5 h-5 text-gray-400 mt-0.5 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                          {result.item.title}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {result.item.section}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!loading && !query && (
              <div className="p-4 text-center text-sm text-gray-400">
                Type to search the documentation
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
