import type { TTSProvider, TTSRequest } from '../types.js';
import type { AudioPCM } from '../../utils/audio.js';
import { decodeWav } from '../../utils/audio.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * OpenAI-совместимый TTS: POST /audio/speech, response_format=wav.
 * (mp3 сознательно не используем: на машине нет FFmpeg, WAV декодируем сами.)
 */

export interface OpenAITTSOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAITTS implements TTSProvider {
  readonly name = 'openai-tts';
  private readonly opts: Required<Omit<OpenAITTSOptions, 'apiKey' | 'fetchImpl'>> & { apiKey?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({ name: 'openai-tts', failureThreshold: 4, cooldownMs: 60_000 });

  constructor(options: OpenAITTSOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model ?? 'tts-1',
      voice: options.voice ?? 'alloy',
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
              this.fetchImpl(`${this.opts.baseUrl}/audio/speech`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
                },
                body: JSON.stringify({
                  model: this.opts.model,
                  input: text,
                  voice: req.voice ?? this.opts.voice,
                  response_format: 'wav',
                }),
                signal,
              }),
            req.signal,
            'tts.openai',
          );
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new ProviderError(`TTS HTTP ${res.status}: ${body.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          const buf = Buffer.from(await res.arrayBuffer());
          return decodeWav(buf);
        },
        { attempts: this.opts.maxRetries + 1, baseDelayMs: 300, shouldRetry: isRetryableError, signal: req.signal },
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
