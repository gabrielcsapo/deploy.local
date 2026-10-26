export function isTaskSurface(pathname: string) {
  return ['/dashboard', '/dashboard/', '/dashboard/projects'].includes(pathname);
}

type Pending = { promise: Promise<unknown>; controller: AbortController };
type Prefetch<T> = { id: string; read: (signal: AbortSignal) => Promise<T>; done: () => void };

/** Connection-scoped, bounded task data. Pull requests travel with task detail. */
export class TaskCache<T, D> {
  private entries = new Map<string, { detail?: T; diff?: D }>();
  private pending = new Map<string, Pending>();
  private queue = new Map<string, Prefetch<T>>();
  private prefetches = new Map<string, Pending>();
  private generation = 0;
  private warmed = false;
  private scope: string;
  private readonly limit: number;
  constructor(
    scope: string,
    limit = 24,
    private readonly concurrency = 2,
  ) {
    this.scope = scope;
    this.limit = limit;
  }

  reset(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation++;
    this.cancelPrefetches();
    this.pending.forEach(({ controller }) => controller.abort());
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
    // Promote this task's in-flight detail; cancel competing speculative IO.
    this.cancelPrefetches(id);
    const entry = this.peek(id);
    if (entry) this.remember(id, entry);
    return entry;
  }

  read<K extends 'detail' | 'diff'>(
    id: string,
    kind: K,
    fetch: (signal: AbortSignal) => Promise<K extends 'detail' ? T : D>,
    signal?: AbortSignal,
  ): Promise<K extends 'detail' ? T : D> {
    type Value = K extends 'detail' ? T : D;
    const key = `${kind}:${id}`;
    const existing = this.pending.get(key);
    if (existing && !existing.controller.signal.aborted) return existing.promise as Promise<Value>;
    const generation = this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const pending = { controller, promise: undefined as unknown as Promise<Value> };
    const request = async () => {
      controller.signal.throwIfAborted();
      return fetch(controller.signal);
    };
    pending.promise = request()
      .then((value) => {
        controller.signal.throwIfAborted();
        if (generation !== this.generation)
          throw new DOMException('Connection changed', 'AbortError');
        this.remember(id, { [kind]: value });
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
        signal?.removeEventListener('abort', abort);
      });
    this.pending.set(key, pending);
    return pending.promise;
  }

  /** Detail only: diffs and media belong to the open task. */
  prefetch(id: string, detail: (signal: AbortSignal) => Promise<T>): Promise<void> {
    if (this.peek(id)?.detail) return Promise.resolve();
    const pending = this.pending.get(`detail:${id}`);
    if (pending && !pending.controller.signal.aborted)
      return pending.promise.then(
        () => {},
        () => {},
      );
    if (this.queue.has(id)) return Promise.resolve();
    return new Promise<void>((done) => {
      this.queue.set(id, { id, read: detail, done });
      this.drain();
    });
  }

  cancelPrefetches(selected?: string) {
    this.queue.forEach(({ done }) => done());
    this.queue.clear();
    this.prefetches.forEach((pending, id) => {
      if (id !== selected) pending.controller.abort();
    });
  }

  private drain() {
    while (this.queue.size && this.prefetches.size < this.concurrency) {
      const job = this.queue.values().next().value!;
      this.queue.delete(job.id);
      if (this.peek(job.id)?.detail) {
        job.done();
        continue;
      }
      const promise = this.read(job.id, 'detail', job.read);
      const pending = this.pending.get(`detail:${job.id}`)!;
      this.prefetches.set(job.id, pending);
      void promise
        .catch(() => {})
        .finally(() => {
          if (this.prefetches.get(job.id) === pending) this.prefetches.delete(job.id);
          job.done();
          this.drain();
        });
    }
  }

  warm(tasks: { id: string; updatedAt?: string }[], prefetch: (id: string) => void, selected = '') {
    if (this.warmed) return;
    this.warmed = true;
    [...tasks]
      .filter((task) => task.id !== selected)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, 3)
      .forEach((task) => prefetch(task.id));
  }
}
