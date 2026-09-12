/**
 * Примитивы надёжности: таймауты, ограниченное число повторов
 * с экспоненциальным backoff, circuit breaker.
 * Бесконечных retry в системе быть не должно.
 */

export class TimeoutError extends Error {
  constructor(public readonly ms: number, what = 'operation') {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class BreakerOpenError extends Error {
  constructor(public readonly target: string) {
    super(`circuit breaker open: ${target}`);
    this.name = 'BreakerOpenError';
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'AbortError' || e.name === 'CancelledError' || /abort|cancel/i.test(e.message))
  );
}

/**
 * Оборачивает promise жёстким таймаутом; внешний signal тоже учитывается.
 * Прерывает ожидание, даже если fn игнорирует signal (Promise.race).
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  external?: AbortSignal,
  what = 'operation',
): Promise<T> {
  const ac = new AbortController();
  const signal = external ? AbortSignal.any([ac.signal, external]) : ac.signal;
  const timer = setTimeout(() => ac.abort(new TimeoutError(ms, what)), ms);
  const task = fn(signal);
  task.catch(() => {}); // fn может отклониться после нашего abort — глушим unhandled
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** Полное число попыток (1 = без повторов). */
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Повторы с экспоненциальным backoff и джиттером.
 * AbortError/CancelledError никогда не ретраятся.
 */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 200;
  const factor = opts.factor ?? 2;
  const maxDelay = opts.maxDelayMs ?? 5000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt >= attempts) break;
      if (isAbortError(e)) break;
      if (opts.shouldRetry && !opts.shouldRetry(e, attempt)) break;
      const exp = Math.min(maxDelay, base * factor ** (attempt - 1));
      const delay = opts.jitter === false ? exp : Math.round(exp * (0.5 + Math.random() * 0.5));
      opts.onRetry?.(e, attempt, delay);
      try {
        await sleep(delay, opts.signal);
      } catch {
        break; // отменили во время паузы
      }
    }
  }
  throw lastErr;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  /** Сколько подряд ошибок до открытия. */
  failureThreshold?: number;
  /** Сколько держим открытым перед half-open, мс. */
  cooldownMs?: number;
  /** Сколько пробных запросов пропускаем в half-open. */
  halfOpenMax?: number;
  now?: () => number;
}

/**
 * Circuit breaker: провайдер, который стабильно падает, временно отключается,
 * чтобы не жечь таймауты на каждом сообщении. Открытый breaker → BreakerOpenError
 * (вызывающий решает, чем деградировать).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMax: number;
  private readonly now: () => number;

  constructor(private opts: CircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.halfOpenMax = opts.halfOpenMax ?? 1;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.failures >= this.failureThreshold) {
      return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
    }
    return 'closed';
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const st = this.state;
    if (st === 'open') throw new BreakerOpenError(this.opts.name);
    if (st === 'half-open') {
      if (this.halfOpenInFlight >= this.halfOpenMax) throw new BreakerOpenError(this.opts.name);
      this.halfOpenInFlight++;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      // Отмена пользователем — не вина провайдера
      if (!isAbortError(e)) this.onFailure();
      else if (st === 'half-open') this.halfOpenInFlight--;
      throw e;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.halfOpenInFlight = 0;
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.openedAt = this.now(); // продлеваем open
      this.failures = Math.max(this.failures, this.failureThreshold);
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }

  reset(): void {
    this.failures = 0;
    this.halfOpenInFlight = 0;
    this.openedAt = 0;
  }
}
