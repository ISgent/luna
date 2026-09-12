import type { z } from 'zod';
import type { AudioPCM } from '../utils/audio.js';

/**
 * Абстракции AI-провайдеров.
 * ConversationManager/MemoryManager НЕ знают, кто конкретно отвечает:
 * замена модели/провайдера — это изменение config + registry.
 */

// ---------- LLM ----------

export interface ToolCall {
  id: string;
  name: string;
  /** Аргументы сырым JSON-текстом (модель иногда выдаёт их кусками). */
  argumentsJson: string;
}

/** JSON-Schema параметров инструмента (передаётся модели как есть). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant: вызовы инструментов, которые модель хочет выполнить. */
  toolCalls?: ToolCall[];
  /** tool: ответ на конкретный вызов. */
  toolCallId?: string;
  /** tool: имя инструмента. */
  name?: string;
}

export interface GenerateOptions {
  /** Переопределение модели (например, фоновая модель вместо основной). */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  stop?: string[];
  signal?: AbortSignal;
  /** Инструменты, доступные модели в этом запросе. */
  tools?: ToolDef[];
}

/**
 * Поток генерации: приращения текста и/или вызовы инструментов
 * (tool_calls отдаются одним событием в конце стрима).
 */
export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; toolCalls: ToolCall[] };

export interface GenerateResult {
  text: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
}

export type StructuredResult<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; error: string; raw?: string };

export interface LLMProvider {
  readonly name: string;
  generate(messages: ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  /** Потоковая генерация: текст-чанки и (возможные) tool_calls. Один запуск = одна попытка. */
  generateStream(messages: ChatMessage[], opts?: GenerateOptions): AsyncIterable<StreamChunk>;
  /**
   * Генерация JSON по zod-схеме. Только для ФОНОВЫХ задач —
   * в горячем пути ответа использоваться не должно.
   */
  generateStructured<T>(
    messages: ChatMessage[],
    opts: GenerateOptions & { schema: z.ZodType<T> },
  ): Promise<StructuredResult<T>>;
  healthCheck(): Promise<boolean>;
}

// ---------- TTS ----------

export interface TTSRequest {
  text: string;
  voice?: string;
  signal?: AbortSignal;
}

export interface TTSProvider {
  readonly name: string;
  /** Синтез целой фразы. Потоковая озвучка достигается нарезкой на предложения выше по стеку. */
  synthesize(req: TTSRequest): Promise<AudioPCM>;
  healthCheck(): Promise<boolean>;
}

// ---------- STT ----------

export interface STTRequest {
  audio: AudioPCM;
  language?: string;
  signal?: AbortSignal;
}

export interface STTResult {
  text: string;
}

export interface STTProvider {
  readonly name: string;
  transcribe(req: STTRequest): Promise<STTResult>;
  healthCheck(): Promise<boolean>;
}

// ---------- Embeddings ----------

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  healthCheck(): Promise<boolean>;
}
