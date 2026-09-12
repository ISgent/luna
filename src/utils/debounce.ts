/**
 * BatchDebouncer — батчинг «очереди быстрых сообщений».
 * НЕ искусственная задержка: окно открывается только когда сообщения
 * реально сыплются пачкой (человек пишет три строки подряд).
 */
export interface DebouncerOptions<T> {
  /** Окно ожидания следующего элемента, мс. 0 = немедленно. */
  windowMs: number;
  /** Жёсткий потолок ожидания от первого элемента, мс. */
  maxWaitMs?: number;
  onFlush: (batch: T[]) => void;
}

export class BatchDebouncer<T> {
  private items: T[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private firstPushAt = 0;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly onFlush: (batch: T[]) => void;

  constructor(opts: DebouncerOptions<T>) {
    this.windowMs = Math.max(0, opts.windowMs);
    this.maxWaitMs = opts.maxWaitMs ?? Number.POSITIVE_INFINITY;
    this.onFlush = opts.onFlush;
  }

  push(item: T): void {
    if (this.items.length === 0) this.firstPushAt = Date.now();
    this.items.push(item);

    if (this.windowMs === 0) {
      this.flushNow();
      return;
    }
    const elapsed = Date.now() - this.firstPushAt;
    const wait = Math.min(this.windowMs, Math.max(0, this.maxWaitMs - elapsed));
    if (this.timer) clearTimeout(this.timer);
    if (wait <= 0) {
      this.flushNow();
      return;
    }
    this.timer = setTimeout(() => this.flushNow(), wait);
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.items;
    this.items = [];
    this.firstPushAt = 0;
    if (batch.length > 0) this.onFlush(batch);
  }

  /** Сброс без вызова onFlush (например, канал удалили). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
    this.firstPushAt = 0;
  }

  get pending(): readonly T[] {
    return this.items;
  }
}
