import { useEffect } from 'react';
import type { SearchScope } from './model.ts';

// The project page being looked at, so ⌘K and the magnifier start inside it.
let pageScope: SearchScope | null = null;
/** A project page says where it is; search opened from it starts in that project. */
export function useSearchScope(scope: SearchScope | null) {
  const { id, name, ref } = scope ?? {};
  useEffect(() => {
    if (!id || !name) return;
    const mine = { id, name, ref };
    pageScope = mine;
    return () => {
      if (pageScope === mine) pageScope = null;
    };
  }, [id, name, ref]);
}
export const currentSearchScope = () => pageScope;
