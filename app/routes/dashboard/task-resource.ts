/** Coalesce expensive task reads independently of the conversation event loop. */
export class TaskResource<T> {
  private current?: { taskId: string; controller: AbortController; again: boolean };
  private readonly read: (taskId: string, signal: AbortSignal) => Promise<T>;
  private readonly accept: (value: T) => void;
  private readonly fail: (error: unknown) => void;
  constructor(
    read: (taskId: string, signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
    fail: (error: unknown) => void,
  ) {
    this.read = read;
    this.accept = accept;
    this.fail = fail;
  }

  request(taskId: string) {
    if (this.current?.taskId === taskId) {
      this.current.again = true;
      return;
    }
    this.cancel();
    const pending = { taskId, controller: new AbortController(), again: false };
    this.current = pending;
    void (async () => {
      do {
        pending.again = false;
        try {
          const value = await this.read(taskId, pending.controller.signal);
          if (this.current === pending) this.accept(value);
        } catch (error) {
          if (this.current === pending) this.fail(error);
        }
      } while (this.current === pending && pending.again);
      if (this.current === pending) this.current = undefined;
    })();
  }

  cancel() {
    const pending = this.current;
    this.current = undefined;
    pending?.controller.abort();
  }
}
