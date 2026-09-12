import type { z } from 'zod';
import { z as zod } from 'zod';
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  StreamChunk,
  StructuredResult,
} from '../types.js';
import { ProviderError, isRetryableError, statusRetryable } from '../errors.js';
import { CircuitBreaker, retryAsync, withTimeout } from '../../utils/async.js';

/**
 * OpenAI-совместимый LLM-адаптер (chat completions, SSE-стриминг).
 * Работает с DashScope compatible-mode, OpenAI, OpenRouter, Groq и т.п.
 *
 * Особенности, учтённые из практики:
 * - некоторые шлюзы отдают HTTP 200 с {"error": ...} внутри (в т.ч. в SSE) — проверяем тело;
 * - retry только для 429/5xx/сети, с ограниченным backoff + circuit breaker;
 * - стрим — одна попытка (переигрывать середину нельзя), ретраями управляет вызывающий.
 */

export interface OpenAICompatibleOptions {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string } | string;
}

/**
 * Внутренние ChatMessage → wire-формат OpenAI:
 * assistant с toolCalls и role=tool требуют специальных полей.
 */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        })),
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAICompatibleLLM implements LLMProvider {
  readonly name: string;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.name ?? 'openai-compatible';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.breaker = new CircuitBreaker({
      name: this.name,
      failureThreshold: opts.failureThreshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 30_000,
    });
  }

  private url(path: string): string {
    return `${this.opts.baseUrl}${path}`;
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.opts.apiKey) h['Authorization'] = `Bearer ${this.opts.apiKey}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private body(messages: ChatMessage[], opts: GenerateOptions = {}, stream: boolean): Record<string, unknown> {
    return {
      model: opts.model ?? this.opts.model,
      messages: toWireMessages(messages),
      temperature: opts.temperature ?? this.opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? this.opts.maxTokens ?? 700,
      stream,
      ...(opts.stop ? { stop: opts.stop } : {}),
      ...(opts.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? 20_000;
    const attempts = (this.opts.maxRetries ?? 2) + 1;

    return this.breaker.call(() =>
      retryAsync(
        async () => {
          const res = await withTimeout(
            timeoutMs,
            (signal) =>
              this.fetchImpl(this.url('/chat/completions'), {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(this.body(messages, opts, false)),
                signal,
              }),
            opts.signal,
            'llm.generate',
          );
          const text = await res.text();
          if (!res.ok) {
            throw new ProviderError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, {
              provider: this.name,
              status: res.status,
              retryable: statusRetryable(res.status),
            });
          }
          let data: {
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            error?: { message?: string } | string;
            model?: string;
          };
          try {
            data = JSON.parse(text);
          } catch {
            throw new ProviderError(`LLM ответил не-JSON: ${text.slice(0, 200)}`, {
              provider: this.name,
              retryable: true,
            });
          }
          // шлюзы-ловушки: 200 с error внутри
          if (data.error) {
            const msg = typeof data.error === 'string' ? data.error : data.error.message ?? 'unknown error';
            throw new ProviderError(`LLM error в теле 200: ${msg}`, { provider: this.name, retryable: true });
          }
          const content = data.choices?.[0]?.message?.content;
          if (content === undefined) {
            throw new ProviderError('LLM: пустой ответ (нет choices[0].message.content)', {
              provider: this.name,
              retryable: true,
            });
          }
          return {
            text: content,
            model: data.model ?? (opts.model ?? this.opts.model),
            finishReason: data.choices?.[0]?.finish_reason ?? undefined,
            usage: data.usage
              ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
              : undefined,
          };
        },
        {
          attempts,
          baseDelayMs: 300,
          maxDelayMs: 5000,
          shouldRetry: isRetryableError,
          signal: opts.signal,
        },
      ),
    );
  }

  async *generateStream(messages: ChatMessage[], opts: GenerateOptions = {}): AsyncIterable<StreamChunk> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? 20_000;
    const ac = new AbortController();
    const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal;
    const timer = setTimeout(() => ac.abort(new ProviderError('LLM stream timeout', { provider: this.name, retryable: true })), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.body(messages, opts, true)),
        signal,
      });
    } catch (e) {
      clearTimeout(timer);
      this.breaker.call(() => Promise.reject(e)).catch(() => {});
      throw e;
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const body = await res.text().catch(() => '');
      const err = new ProviderError(`LLM stream HTTP ${res.status}: ${body.slice(0, 300)}`, {
        provider: this.name,
        status: res.status,
        retryable: statusRetryable(res.status),
      });
      this.breaker.call(() => Promise.reject(err)).catch(() => {});
      throw err;
    }

    const decoder = new TextDecoder();
    let buf = '';
    let gotContent = false;
    // фрагменты tool_calls приходят кусками и сливаются по index
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    const flushToolCalls = (): StreamChunk | null => {
      if (toolAcc.size === 0) return null;
      const calls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, v]) => ({ id: v.id ?? `call_${i}`, name: v.name ?? '', argumentsJson: v.args }));
      toolAcc.clear();
      return { kind: 'tool_calls', toolCalls: calls };
    };

    try {
      for await (const rawChunk of res.body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(rawChunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            const tc = flushToolCalls();
            if (tc) yield tc;
            this.breaker.call(async () => true).catch(() => {});
            return;
          }
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // мусорную строку пропускаем
          }
          if (chunk.error) {
            const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'unknown';
            throw new ProviderError(`LLM stream error в SSE: ${msg}`, { provider: this.name, retryable: true });
          }
          const choice = chunk.choices?.[0];
          const deltaContent = choice?.delta?.content;
          if (deltaContent) {
            gotContent = true;
            yield { kind: 'text', text: deltaContent };
          }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) ?? { args: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
          if (choice?.finish_reason) {
            const tcChunk = flushToolCalls();
            if (tcChunk) yield tcChunk;
            this.breaker.call(async () => true).catch(() => {});
            return;
          }
        }
      }
      const tc = flushToolCalls();
      if (tc) yield tc;
      this.breaker.call(async () => true).catch(() => {});
    } catch (e) {
      if (!gotContent) this.breaker.call(() => Promise.reject(e)).catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStructured<T>(
    messages: ChatMessage[],
    opts: GenerateOptions & { schema: z.ZodType<T> },
  ): Promise<StructuredResult<T>> {
    const hint = zodSchemaToJsonHint(opts.schema);
    const jsonInstruction: ChatMessage = {
      role: 'system',
      content:
        'Отвечай СТРОГО валидным JSON без пояснений и markdown-обёрток.' +
        (hint ? ` JSON Schema: ${hint}` : ''),
    };
    let raw: string;
    try {
      const res = await this.generate([jsonInstruction, ...messages], {
        ...opts,
        temperature: opts.temperature ?? 0.2,
      });
      raw = res.text;
    } catch (e) {
      return { ok: false, error: `LLM request failed: ${String(e)}` };
    }

    const first = parseJsonLoose(raw, opts.schema);
    if (first.ok) return { ok: true, value: first.value, raw };

    // одна попытка починки — только для фоновых задач
    try {
      const repair = await this.generate(
        [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Твой ответ не прошёл валидацию: ${first.error}. Верни ИСПРАВЛЕННЫЙ валидный JSON по той же схеме, без пояснений.`,
          },
        ],
        { ...opts, temperature: 0 },
      );
      const second = parseJsonLoose(repair.text, opts.schema);
      if (second.ok) return { ok: true, value: second.value, raw: repair.text };
      return { ok: false, error: second.error, raw: repair.text };
    } catch (e) {
      return { ok: false, error: `repair failed: ${String(e)}`, raw };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await withTimeout(
        10_000,
        (signal) => this.fetchImpl(this.url('/models'), { headers: this.headers(), signal }),
        undefined,
        'llm.healthCheck',
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Достаёт JSON из текста (возможны ```json-обёртки) и валидирует zod-схемой. */
export function parseJsonLoose<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1]!.trim();
  // первый { до последнего } — частый мусор вокруг JSON
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `JSON parse: ${String(e)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: result.data };
}

/** Текстовая подсказка схемы для промпта: JSON Schema, если zod её умеет, иначе пусто. */
function zodSchemaToJsonHint(schema: z.ZodType<unknown>): string {
  try {
    const toJsonSchema = (zod as unknown as { toJSONSchema?: (s: unknown, opts?: unknown) => unknown })
      .toJSONSchema;
    if (typeof toJsonSchema === 'function') {
      return JSON.stringify(toJsonSchema(schema, { target: 'draft-7' })).slice(0, 3000);
    }
  } catch {
    // подсказка не критична — схема описана в самом промпте вызывающим
  }
  return '';
}
