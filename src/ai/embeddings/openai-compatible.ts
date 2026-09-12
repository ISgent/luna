import type { EmbeddingProvider } from '../types.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * OpenAI-совместимый embeddings-адаптер (POST /embeddings).
 * Один вызов — батч текстов. Кэширование — на уровне MemoryRetrieval.
 */

export interface OpenAIEmbeddingsOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai-embeddings';
  readonly dimensions: number;
  private readonly opts: Required<Omit<OpenAIEmbeddingsOptions, 'apiKey' | 'fetchImpl'>> & { apiKey?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({ name: 'openai-embeddings', failureThreshold: 4, cooldownMs: 60_000 });
  private readonly cache = new Map<string, Float32Array>();
  private readonly cacheLimit = 512;

  constructor(options: OpenAIEmbeddingsOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model ?? 'text-embedding-v4',
      dimensions: options.dimensions ?? 1024,
      timeoutMs: options.timeoutMs ?? 8_000,
      maxRetries: options.maxRetries ?? 1,
    };
    this.dimensions = this.opts.dimensions;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const missing = [...new Set(texts.filter((t) => !this.cache.has(t)))];
    if (missing.length > 0) {
      const vectors = await this.request(missing, signal);
      for (let i = 0; i < missing.length; i++) {
        if (this.cache.size >= this.cacheLimit) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(missing[i]!, vectors[i]!);
      }
    }
    return texts.map((t) => this.cache.get(t)!);
  }

  private async request(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.breaker.call(() =>
      retryAsync(
        async () => {
          const res = await withTimeout(
            this.opts.timeoutMs,
            (sig) =>
              this.fetchImpl(`${this.opts.baseUrl}/embeddings`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
                },
                body: JSON.stringify({
                  model: this.opts.model,
                  input: texts,
                  dimensions: this.opts.dimensions,
                  encoding_format: 'float',
                }),
                signal: sig,
              }),
            signal,
            'embeddings',
          );
          const body = await res.text();
          if (!res.ok) {
            throw new ProviderError(`Embeddings HTTP ${res.status}: ${body.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          const data = JSON.parse(body) as {
            data?: Array<{ embedding: number[]; index: number }>;
            error?: { message?: string } | string;
          };
          if (data.error) {
            const msg = typeof data.error === 'string' ? data.error : data.error.message ?? 'unknown';
            throw new ProviderError(`Embeddings error в теле 200: ${msg}`, { provider: this.name, retryable: true });
          }
          const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
          if (rows.length !== texts.length) {
            throw new ProviderError(`Embeddings: ждали ${texts.length} векторов, получили ${rows.length}`, {
              provider: this.name,
              retryable: true,
            });
          }
          return rows.map((r) => Float32Array.from(r.embedding));
        },
        { attempts: this.opts.maxRetries + 1, baseDelayMs: 200, shouldRetry: isRetryableError, signal },
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const [v] = await this.embed(['ping']);
      return !!v && v.length > 0;
    } catch {
      return false;
    }
  }
}
