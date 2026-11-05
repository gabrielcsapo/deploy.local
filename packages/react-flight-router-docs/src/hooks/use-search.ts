import { useState, useEffect, useCallback, useRef } from "react";
import Fuse from "fuse.js";

interface SearchEntry {
  title: string;
  slug: string;
  path: string;
  section: string;
  headings: string[];
  content: string;
}

interface SearchResult {
  item: SearchEntry;
  matches?: readonly Fuse.FuseResultMatch[];
}

let cachedFuse: Fuse<SearchEntry> | null = null;
let loadingPromise: Promise<Fuse<SearchEntry>> | null = null;

async function getFuse(): Promise<Fuse<SearchEntry>> {
  if (cachedFuse) return cachedFuse;
  if (loadingPromise) return loadingPromise;

  loadingPromise = fetch(`${import.meta.env.BASE_URL}search-index.json`)
    .then((res) => res.json())
    .then((data: SearchEntry[]) => {
      cachedFuse = new Fuse(data, {
        keys: [
          { name: "title", weight: 3 },
          { name: "headings", weight: 2 },
          { name: "content", weight: 1 },
        ],
        includeMatches: true,
        threshold: 0.3,
        minMatchCharLength: 2,
      });
      return cachedFuse;
    });

  return loadingPromise;
}

export function useSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback((q: string) => {
    setQuery(q);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (!q.trim()) {
      setResults([]);
      return;
    }

    timeoutRef.current = setTimeout(async () => {
      setLoading(true);
      const fuse = await getFuse();
      const res = fuse.search(q, { limit: 10 });
      setResults(res);
      setLoading(false);
    }, 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return { query, search, results, loading };
}
