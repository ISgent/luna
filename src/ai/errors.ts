/** Ошибка провайдера с признаком «можно повторить». */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly opts: { provider: string; status?: number; retryable: boolean; cause?: unknown } = {
      provider: 'unknown',
      retryable: false,
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.opts.retryable;
  }
}

export function isRetryableError(e: unknown): boolean {
  if (e instanceof ProviderError) return e.retryable;
  if (e instanceof Error && e.name === 'TimeoutError') return true;
  // сетевые ошибки fetch
  if (e instanceof TypeError) return true;
  return false;
}

/** HTTP-статус → retryable (429/5xx — да). */
export function statusRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
