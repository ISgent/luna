import type { STTProvider, STTRequest, STTResult } from '../types.js';
import { encodeWav } from '../../utils/audio.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * DashScope ASR (qwen3-asr-flash и семейство) через OpenAI-совместимый чат
 * с input_audio (data-URL) — форма, подтверждённая round-trip'ом на живом ключе.
 * Никакого «красивого исправления» вторым LLM — только распознавание.
 */

export interface DashScopeSTTOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export class DashScopeSTT implements STTProvider {
  readonly name = 'dashscope-stt';
  private readonly opts: Required<Omit<DashScopeSTTOptions, 'apiKey' | 'fetchImpl'>> & { apiKey?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker({ name: 'dashscope-stt', failureThreshold: 4, cooldownMs: 60_000 });

  constructor(options: DashScopeSTTOptions = {}) {
    this.opts = {
      baseUrl: (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ''),
      apiKey: options.apiKey,
      model: options.model ?? 'qwen3-asr-flash',
      language: options.language ?? 'ru',
      timeoutMs: options.timeoutMs ?? 15_000,
      maxRetries: options.maxRetries ?? 1,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(req: STTRequest): Promise<STTResult> {
    if (req.audio.data.length === 0) return { text: '' };
    const wav = encodeWav(req.audio);
    const dataUrl = `data:audio/wav;base64,${wav.toString('base64')}`;

    return this.breaker.call(() =>
      retryAsync(
        async () => {
          const res = await withTimeout(
            this.opts.timeoutMs,
            (signal) =>
              this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
                },
                // Подтверждённая round-trip'ом форма: ТОЛЬКО input_audio (data-URL).
                // Текстовая часть в content ломает dedicated-задачу asr (HTTP 400),
                // язык модель определяет сама.
                body: JSON.stringify({
                  model: this.opts.model,
                  messages: [
                    {
                      role: 'user',
                      content: [{ type: 'input_audio', input_audio: { data: dataUrl, format: 'wav' } }],
                    },
                  ],
                }),
                signal,
              }),
            req.signal,
            'stt.dashscope',
          );
          const body = await res.text();
          if (!res.ok) {
            throw new ProviderError(`STT HTTP ${res.status}: ${body.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          let data: {
            choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
            error?: { message?: string } | string;
          };
          try {
            data = JSON.parse(body);
          } catch {
            throw new ProviderError(`STT ответил не-JSON: ${body.slice(0, 200)}`, { provider: this.name, retryable: true });
          }
          if (data.error) {
            const msg = typeof data.error === 'string' ? data.error : data.error.message ?? 'unknown';
            throw new ProviderError(`STT error в теле 200: ${msg}`, { provider: this.name, retryable: true });
          }
          const content = data.choices?.[0]?.message?.content;
          const text = Array.isArray(content)
            ? content.map((c) => c.text ?? '').join('')
            : (content ?? '');
          return { text: text.trim() };
        },
        { attempts: this.opts.maxRetries + 1, baseDelayMs: 300, shouldRetry: isRetryableError, signal: req.signal },
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      // 100 мс тишины — дешёвая проверка доступности
      const silence = { sampleRate: 16000, channels: 1 as const, data: new Int16Array(1600) };
      await this.transcribe({ audio: silence });
      return true;
    } catch {
      return false;
    }
  }
}
