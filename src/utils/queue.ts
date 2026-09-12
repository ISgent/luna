/**
 * KeyedSerialQueue: на каждый ключ (канал/пользователь) задачи идут строго
 * последовательно, разные ключи — параллельно. Задачи можно отменять.
 * Основа ResponseQueue (см. processing/queues).
 */

export class CancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(reason);
    this.name = 'CancelledError';
  }
}

interface PendingItem<T = unknown> {
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  controller: AbortController;
  started: boolean;
}

export interface QueueHandle<T> {
  promise: Promise<T>;
  cancel(): void;
}

export class KeyedSerialQueue {
  private running = new Map<string, PendingItem>();
  private waiting = new Map<string, PendingItem[]>();
  private activeCount = 0;
  private idleWaiters: Array<() => void> = [];

  /** Резолвится, когда ни одна задача не выполняется и очереди пусты. */
  waitIdle(): Promise<void> {
    if (this.activeCount === 0 && this.waiting.size === 0) return Promise.resolve();
    if (this.activeCount === 0) {
      // остались только отменённые — проверим, есть ли живые
      const hasLive = [...this.waiting.values()].some((list) => list.length > 0);
      if (!hasLive) return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private checkIdle(): void {
    if (this.activeCount > 0) return;
    const hasLive = [...this.waiting.values()].some((list) => list.length > 0);
    if (hasLive) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  run<T>(key: string, task: (signal: AbortSignal) => Promise<T>): QueueHandle<T> {
    const item: PendingItem<T> = {
      task,
      started: false,
      controller: new AbortController(),
      resolve: () => {},
      reject: () => {},
    };
    const promise = new Promise<T>((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    // если никто не слушает результат — не роняем процесс unhandled rejection
    promise.catch(() => {});

    const list = this.waiting.get(key) ?? [];
    list.push(item as PendingItem);
    this.waiting.set(key, list);
    this.pump(key);

    return {
      promise,
      cancel: () => this.cancelItem(key, item as PendingItem),
    };
  }

  private cancelItem(key: string, item: PendingItem): void {
    const list = this.waiting.get(key);
    if (list) {
      const idx = list.indexOf(item);
      if (idx >= 0 && !item.started) {
        list.splice(idx, 1);
        item.controller.abort(new CancelledError());
        item.reject(new CancelledError());
        return;
      }
    }
    if (item.started) item.controller.abort(new CancelledError());
  }

  /** Отменяет текущую задачу и всю очередь ключа. */
  cancelKey(key: string): void {
    const running = this.running.get(key);
    if (running) {
      running.controller.abort(new CancelledError());
    }
    const list = this.waiting.get(key) ?? [];
    for (const item of list) {
      item.controller.abort(new CancelledError());
      item.reject(new CancelledError());
    }
    this.waiting.set(key, []);
  }

  isBusy(key: string): boolean {
    const r = this.running.get(key);
    return r !== undefined && r.started;
  }

  pendingCount(key: string): number {
    return (this.waiting.get(key) ?? []).filter((i) => !i.started).length;
  }

  private pump(key: string): void {
    if (this.running.has(key)) return;
    const list = this.waiting.get(key) ?? [];
    const item = list.shift();
    if (!item) return;
    if (item.controller.signal.aborted) {
      this.pump(key);
      return;
    }
    item.started = true;
    this.running.set(key, item);
    this.activeCount++;

    void item
      .task(item.controller.signal)
      .then((v) => item.resolve(v), (e) => item.reject(e))
      .finally(() => {
        this.running.delete(key);
        this.activeCount--;
        this.pump(key);
        this.checkIdle();
      });
  }
}
