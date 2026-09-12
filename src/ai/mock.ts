import type { z } from 'zod';
import type {
  ChatMessage,
  EmbeddingProvider,
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  STTProvider,
  STTResult,
  StreamChunk,
  StructuredResult,
  ToolCall,
  TTSProvider,
  TTSRequest,
} from './types.js';
import type { AudioPCM } from '../utils/audio.js';

/**
 * Mock-провайдеры: детерминированная замена для тестов и деградации.
 * Никаких искусственных задержек по умолчанию.
 */

export interface MockLLMOptions {
  /** Ответ (или функция от messages) для generate/generateStream. */
  reply?: string | ((messages: ChatMessage[]) => string);
  /** Ответ для generateStructured. */
  structured?: unknown | ((messages: ChatMessage[]) => unknown);
  /** Сколько первых вызовов должны падать (проверка resilience). */
  failTimes?: number;
  /** Задержка между чанками стрима, мс (0 по умолчанию). */
  chunkDelayMs?: number;
  /** Размер чанка стрима в символах. */
  chunkSize?: number;
  /**
   * Сценарий tool-calling: если вернул вызовы — стрим отдаёт tool_calls
   * вместо текста (только когда в истории ещё нет tool-результатов).
   */
  toolScript?: (messages: ChatMessage[]) => ToolCall[] | null;
  /** Текст ответа после выполнения инструментов (второй заход стрима). */
  replyAfterTools?: string;
}

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  /** История вызовов для ассертов в тестах. */
  readonly calls: Array<{ kind: 'generate' | 'stream' | 'structured'; messages: ChatMessage[]; opts?: GenerateOptions }> = [];
  private failuresLeft: number;

  constructor(private opts: MockLLMOptions = {}) {
    this.failuresLeft = opts.failTimes ?? 0;
  }

  private maybeFail(): void {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('mock provider failure');
    }
  }

  private replyFor(messages: ChatMessage[]): string {
    const hasToolResults = messages.some((m) => m.role === 'tool');
    if (hasToolResults && this.opts.replyAfterTools !== undefined) return this.opts.replyAfterTools;
    const r = this.opts.reply ?? 'mock-ответ';
    return typeof r === 'function' ? r(messages) : r;
  }

  async generate(messages: ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
    this.maybeFail();
    this.calls.push({ kind: 'generate', messages, opts });
    const text = this.replyFor(messages);
    return { text, model: 'mock', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: text.length } };
  }

  async *generateStream(messages: ChatMessage[], opts?: GenerateOptions): AsyncIterable<StreamChunk> {
    this.maybeFail();
    this.calls.push({ kind: 'stream', messages, opts });

    // tool-сценарий: первый заход — вызовы инструментов вместо текста
    const hasToolResults = messages.some((m) => m.role === 'tool');
    if (this.opts.toolScript && !hasToolResults && opts?.tools?.length) {
      const calls = this.opts.toolScript(messages);
      if (calls && calls.length > 0) {
        yield { kind: 'tool_calls', toolCalls: calls };
        return;
      }
    }

    const text = this.replyFor(messages);
    const size = this.opts.chunkSize ?? 8;
    for (let i = 0; i < text.length; i += size) {
      if (opts?.signal?.aborted) return;
      if (this.opts.chunkDelayMs) await new Promise((r) => setTimeout(r, this.opts.chunkDelayMs));
      yield { kind: 'text', text: text.slice(i, i + size) };
    }
  }

  async generateStructured<T>(
    messages: ChatMessage[],
    opts: GenerateOptions & { schema: z.ZodType<T> },
  ): Promise<StructuredResult<T>> {
    this.maybeFail();
    this.calls.push({ kind: 'structured', messages, opts });
    const s = this.opts.structured;
    const value = typeof s === 'function' ? (s as (m: ChatMessage[]) => unknown)(messages) : s;
    if (value === undefined) return { ok: false, error: 'mock: structured response not configured' };
    const parsed = opts.schema.safeParse(value);
    if (!parsed.success) return { ok: false, error: parsed.error.message, raw: JSON.stringify(value) };
    return { ok: true, value: parsed.data, raw: JSON.stringify(value) };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = this.opts.failTimes ?? 0;
  }
}

export class MockTTSProvider implements TTSProvider {
  readonly name = 'mock-tts';
  readonly calls: TTSRequest[] = [];
  shouldFail = false;

  /** 50 мс тишины на каждый символ — детерминированная «длительность». */
  async synthesize(req: TTSRequest): Promise<AudioPCM> {
    this.calls.push(req);
    if (this.shouldFail) throw new Error('mock tts failure');
    const samples = Math.max(1, Math.round(req.text.length * 0.05 * 24000));
    return { sampleRate: 24000, channels: 1, data: new Int16Array(samples) };
  }

  async healthCheck(): Promise<boolean> {
    return !this.shouldFail;
  }
}

export class MockSTTProvider implements STTProvider {
  readonly name = 'mock-stt';
  readonly calls: number[] = [];
  text = 'привет это мок распознания';
  shouldFail = false;

  async transcribe(req: { audio: AudioPCM; language?: string; signal?: AbortSignal }): Promise<STTResult> {
    this.calls.push(req.audio.data.length);
    if (this.shouldFail) throw new Error('mock stt failure');
    return { text: this.text };
  }

  async healthCheck(): Promise<boolean> {
    return !this.shouldFail;
  }
}

/**
 * Детерминированные эмбеддинги: bag-of-chars (биграммы) → L2-нормализация.
 * Похожие тексты получают близкие векторы — достаточно для тестов ранжирования.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embeddings';
  readonly dimensions: number;
  calls = 0;
  shouldFail = false;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.shouldFail) throw new Error('mock embeddings failure');
    return texts.map((t) => this.vectorize(t));
  }

  vectorize(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    const norm = text.toLowerCase().replace(/[^a-zа-я0-9 ]/gi, '');
    const tokens = norm.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      for (let i = 0; i < tok.length - 1; i++) {
        const bg = tok.slice(i, i + 2);
        let h = 2166136261;
        for (let c = 0; c < bg.length; c++) h = ((h ^ bg.charCodeAt(c)) * 16777619) >>> 0;
        v[h % this.dimensions]! += 1;
      }
    }
    let sum = 0;
    for (const x of v) sum += x * x;
    const len = Math.sqrt(sum) || 1;
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / len;
    return v;
  }

  async healthCheck(): Promise<boolean> {
    return !this.shouldFail;
  }
}
