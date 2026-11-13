/** A lazy, bounded per-key view. Synchronous computes remain synchronous. */
export function materialized<K, V>(
  compute: (key: K) => V,
  {
    cadenceMs,
    clock = () => Date.now(),
    maxEntries = 256,
    maxWeight = Infinity,
    weigh = () => 1,
    cadenceFromStart = false,
  }: {
    cadenceMs: number;
    clock?: () => number;
    maxEntries?: number;
    maxWeight?: number;
    weigh?: (value: Awaited<V>) => number;
    cadenceFromStart?: boolean;
  },
) {
  if (
    cadenceMs < 0 ||
    (cadenceMs !== Infinity && !Number.isFinite(cadenceMs)) ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    !(maxWeight > 0)
  )
    throw new Error('Invalid materialized view bounds');
  type Entry = { value: V; at: number; weight: number };
  let weight = 0;
  const entries = new Map<K, Entry>();
  // Active readers keep their in-flight work alive even under LRU pressure. Only settled
  // results occupy the bounded cache; no timer or work is created for an unused key.
  const pending = new Map<K, Entry>();
  function deleteEntry(key: K) {
    weight -= entries.get(key)?.weight ?? 0;
    entries.delete(key);
  }
  function retainEntry(key: K, entry: Entry) {
    deleteEntry(key);
    if (entry.weight > maxWeight) return;
    entries.set(key, entry);
    weight += entry.weight;
    while (entries.size > maxEntries || weight > maxWeight)
      deleteEntry(entries.keys().next().value!);
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
    deleteEntry(key);
    const value = compute(key);
    const entry: Entry = { value, at, weight: 0 };
    if (value instanceof Promise) {
      entry.value = value.then(
        (result) => {
          const frozen = freezeForTests(result);
          if (pending.get(key) === entry) {
            pending.delete(key);
            if (!cadenceFromStart) entry.at = clock();
            entry.weight = weigh(frozen);
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
      entry.weight = weigh(value as Awaited<V>);
      if (retain) retainEntry(key, entry);
    }
    return entry.value;
  }
  return {
    read,
    invalidateWhere(matches: (key: K) => boolean) {
      for (const key of entries.keys()) if (matches(key)) deleteEntry(key);
      for (const key of pending.keys()) if (matches(key)) pending.delete(key);
    },
    invalidate(key?: K) {
      if (arguments.length === 0) {
        entries.clear();
        weight = 0;
        pending.clear();
      } else {
        deleteEntry(key!);
        pending.delete(key!);
      }
    },
  };
}

function freezeForTests<T>(value: T): T {
  if (process.env.NODE_ENV !== 'test') return value;
  const seen = new WeakSet<object>();
  function freeze(item: unknown) {
    // Nonempty typed arrays cannot be frozen. Byte-cache readers return copies.
    if (!item || typeof item !== 'object' || seen.has(item) || ArrayBuffer.isView(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(value);
  return value;
}

/** Immutable, explicitly keyed results use the same bounded LRU and in-flight deduplication. */
export function immutable<K, V>(
  compute: (key: K) => V,
  maxEntries = 256,
  bounds: { maxWeight?: number; weigh?: (value: Awaited<V>) => number } = {},
) {
  return materialized(compute, { cadenceMs: Infinity, maxEntries, ...bounds });
}
