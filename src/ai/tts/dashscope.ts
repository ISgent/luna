import type { TTSProvider, TTSRequest } from '../types.js';
import type { AudioPCM } from '../../utils/audio.js';
import { decodeWav } from '../../utils/audio.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * DashScope TTS (qwen3-tts-flash и семейство).
 * Нативный multimodal-generation API: {input:{text, voice}} → JSON
 * с подписанной ссылкой на WAV. Скачиваем WAV и декодируем в PCM.
 */

export interface DashScopeTTSOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/api/v1';

export class DashScopeTTS implements TTSProvider {
  readonly name = 'dashscope-tts';
  private readonly opts: Required<Omit<DashScopeTTSOptions, 'apiKey' | 'fetchImpl'>> & { apiKey?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({ name: 'dashscope-tts', failureThreshold: 4, cooldownMs: 60_000 });

  constructor(options: DashScopeTTSOptions = {}) {
    this.opts = {
      baseUrl: (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model ?? 'qwen3-tts-flash',
      voice: options.voice ?? 'Cherry',
      timeoutMs: options.timeoutMs ?? 15_000,
      maxRetries: options.maxRetries ?? 1,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(req: TTSRequest): Promise<AudioPCM> {
    const text = req.text.trim();
    if (!text) return { sampleRate: 24000, channels: 1, data: new Int16Array(0) };

    return this.breaker.call(() =>
      retryAsync(
        async () => {
          const res = await withTimeout(
            this.opts.timeoutMs,
            (signal) =>
              this.fetchImpl(`${this.opts.baseUrl}/services/aigc/multimodal-generation/generation`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
                },
                body: JSON.stringify({
                  model: this.opts.model,
                  input: { text, voice: req.voice ?? this.opts.voice },
                }),
                signal,
              }),
            req.signal,
            'tts.dashscope',
          );
          const body = await res.text();
          if (!res.ok) {
            throw new ProviderError(`TTS HTTP ${res.status}: ${body.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          let data: {
            output?: { audio?: { url?: string; data?: string } };
            message?: string;
          };
          try {
            data = JSON.parse(body);
          } catch {
            throw new ProviderError(`TTS ответил не-JSON: ${body.slice(0, 200)}`, { provider: this.name, retryable: true });
          }

          const audio = data.output?.audio;
          let wavBuf: Buffer;
          if (audio?.url) {
            const wavRes = await withTimeout(
              this.opts.timeoutMs,
              (signal) => this.fetchImpl(audio.url!, { signal }),
              req.signal,
              'tts.download',
            );
            if (!wavRes.ok) {
              throw new ProviderError(`TTS WAV download HTTP ${wavRes.status}`, { provider: this.name, retryable: true });
            }
            wavBuf = Buffer.from(await wavRes.arrayBuffer());
          } else if (audio?.data) {
            wavBuf = Buffer.from(audio.data, 'base64');
          } else {
            throw new ProviderError(`TTS: нет audio.url/data в ответе: ${body.slice(0, 300)}`, {
              provider: this.name,
              retryable: false,
            });
          }
          return decodeWav(wavBuf);
        },
        {
          attempts: this.opts.maxRetries + 1,
          baseDelayMs: 300,
          shouldRetry: isRetryableError,
          signal: req.signal,
        },
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pcm = await this.synthesize({ text: 'раз два' });
      return pcm.data.length > 0;
    } catch {
      return false;
    }
  }
}
