/** A lazy, bounded per-key view. Synchronous computes remain synchronous. */
export function materialized<K, V>(
  compute: (key: K) => V,
  {
    cadenceMs,
    clock = () => Date.now(),
    maxEntries = 256,
  }: {
    cadenceMs: number;
    clock?: () => number;
    maxEntries?: number;
  },
) {
  if (
    cadenceMs < 0 ||
    !Number.isFinite(cadenceMs) ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1
  )
    throw new Error('Invalid materialized view bounds');
  type Entry = { value: V; at: number };
  const entries = new Map<K, Entry>();
  // Active readers keep their in-flight work alive even under LRU pressure. Only settled
  // results occupy the bounded cache; no timer or work is created for an unused key.
  const pending = new Map<K, Entry>();
  function retainEntry(key: K, entry: Entry) {
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  }
  // A transaction may consume a committed view, but must not publish uncommitted data.
  function read(key: K, retain = true): V {
    const active = pending.get(key);
    if (active) return active.value;
    const at = clock();
    const previous = entries.get(key);
    if (previous && at >= previous.at && at - previous.at < cadenceMs) {
      retainEntry(key, previous);
      return previous.value;
    }
    entries.delete(key);
    const value = compute(key);
    const entry: Entry = { value, at };
    if (value instanceof Promise) {
      entry.value = value.then(
        (result) => {
          const frozen = freezeForTests(result);
          if (pending.get(key) === entry) {
            pending.delete(key);
            entry.at = clock();
            if (retain) retainEntry(key, entry);
          }
          return frozen;
        },
        (error) => {
          if (pending.get(key) === entry) pending.delete(key);
          throw error;
        },
      ) as V;
      pending.set(key, entry);
    } else {
      entry.value = freezeForTests(value);
      if (retain) retainEntry(key, entry);
    }
    return entry.value;
  }
  return {
    read,
    invalidate(key?: K) {
      if (arguments.length === 0) {
        entries.clear();
        pending.clear();
      } else {
        entries.delete(key!);
        pending.delete(key!);
      }
    },
  };
}

function freezeForTests<T>(value: T): T {
  if (process.env.NODE_ENV !== 'test') return value;
  const seen = new WeakSet<object>();
  function freeze(item: unknown) {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(value);
  return value;
}
