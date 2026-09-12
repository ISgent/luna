import type { STTProvider, STTRequest, STTResult } from '../types.js';
import { encodeWav } from '../../utils/audio.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * OpenAI-совместимый STT: POST /audio/transcriptions (multipart, WAV).
 */

export interface OpenAISTTOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAISTT implements STTProvider {
  readonly name = 'openai-stt';
  private readonly opts: Required<Omit<OpenAISTTOptions, 'apiKey' | 'fetchImpl'>> & { apiKey?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({ name: 'openai-stt', failureThreshold: 4, cooldownMs: 60_000 });

  constructor(options: OpenAISTTOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model ?? 'whisper-1',
      language: options.language ?? 'ru',
      timeoutMs: options.timeoutMs ?? 15_000,
      maxRetries: options.maxRetries ?? 1,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(req: STTRequest): Promise<STTResult> {
    if (req.audio.data.length === 0) return { text: '' };
    const wav = encodeWav(req.audio);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', this.opts.model);
    form.append('language', req.language ?? this.opts.language);

    return this.breaker.call(() =>
      retryAsync(
        async () => {
          const res = await withTimeout(
            this.opts.timeoutMs,
            (signal) =>
              this.fetchImpl(`${this.opts.baseUrl}/audio/transcriptions`, {
                method: 'POST',
                headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
                body: form,
                signal,
              }),
            req.signal,
            'stt.openai',
          );
          const body = await res.text();
          if (!res.ok) {
            throw new ProviderError(`STT HTTP ${res.status}: ${body.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          try {
            const data = JSON.parse(body) as { text?: string; error?: { message?: string } | string };
            if (data.error) {
              const msg = typeof data.error === 'string' ? data.error : data.error.message ?? 'unknown';
              throw new ProviderError(`STT error в теле 200: ${msg}`, { provider: this.name, retryable: true });
            }
            return { text: (data.text ?? '').trim() };
          } catch (e) {
            if (e instanceof ProviderError) throw e;
            throw new ProviderError(`STT ответил не-JSON: ${body.slice(0, 200)}`, { provider: this.name, retryable: true });
          }
        },
        { attempts: this.opts.maxRetries + 1, baseDelayMs: 300, shouldRetry: isRetryableError, signal: req.signal },
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const silence = { sampleRate: 16000, channels: 1 as const, data: new Int16Array(1600) };
      await this.transcribe({ audio: silence });
      return true;
    } catch {
      return false;
    }
  }
}
