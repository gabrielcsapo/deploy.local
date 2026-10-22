/** Connection-scoped, bounded task data. Pull requests travel with task detail. */
export class TaskCache<T, D> {
  private entries = new Map<string, { detail?: T; diff?: D }>();
  private pending = new Map<string, Promise<unknown>>();
  private controllers = new Set<AbortController>();
  private generation = 0;
  private warmed = false;
  private scope: string;
  private readonly limit: number;
  constructor(scope: string, limit = 24) {
    this.scope = scope;
    this.limit = limit;
  }

  reset(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation++;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
    this.entries.clear();
    this.pending.clear();
    this.warmed = false;
  }

  peek(id: string) {
    return this.entries.get(id);
  }

  remember(id: string, value: { detail?: T; diff?: D }) {
    const entry = { ...this.entries.get(id), ...value };
    this.entries.delete(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry;
  }

  open(id: string) {
    const entry = this.peek(id);
    if (entry) this.remember(id, entry);
    return entry;
  }

  read<K extends 'detail' | 'diff'>(
    id: string,
    kind: K,
    fetch: (signal: AbortSignal) => Promise<K extends 'detail' ? T : D>,
  ): Promise<K extends 'detail' ? T : D> {
    type Value = K extends 'detail' ? T : D;
    const key = `${kind}:${id}`;
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<Value>;
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    const pending = fetch(controller.signal)
      .then((value) => {
        if (generation !== this.generation)
          throw new DOMException('Connection changed', 'AbortError');
        this.remember(id, { [kind]: value });
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
        this.controllers.delete(controller);
      });
    this.pending.set(key, pending);
    return pending;
  }

  async prefetch(
    id: string,
    detail: (signal: AbortSignal) => Promise<T>,
    diff: (signal: AbortSignal) => Promise<D>,
  ) {
    await Promise.allSettled([
      this.peek(id)?.detail ? Promise.resolve() : this.read(id, 'detail', detail),
      this.peek(id)?.diff ? Promise.resolve() : this.read(id, 'diff', diff),
    ]);
  }

  warm(tasks: { id: string; updatedAt?: string }[], prefetch: (id: string) => void) {
    if (this.warmed) return;
    this.warmed = true;
    [...tasks]
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, 6)
      .forEach((task) => prefetch(task.id));
  }
}
