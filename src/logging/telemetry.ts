import { newId } from '../utils/ids.js';

/**
 * Телеметрия латентности.
 *
 * Каждый запрос пользователя получает RequestTracer с точками (span marks).
 * Из точек считаются производные метрики — чтобы на вопрос
 * «почему Luna сегодня отвечала 4 секунды?» отвечала конкретная строка,
 * а не просто "request took 4s".
 */

export const SPANS = [
  'message_received',
  'stt_start',
  'stt_end',
  'retrieval_start',
  'retrieval_end',
  'context_ready',
  'llm_request_start',
  'first_token',
  'llm_complete',
  'first_visible_output',
  'tts_start',
  'first_audio',
  'response_complete',
  'background_start',
  'background_end',
] as const;

export type SpanName = (typeof SPANS)[number];

export interface TelemetryMetrics {
  sttMs?: number;
  memoryRetrievalMs?: number;
  contextBuildMs?: number;
  ttftMs?: number;
  llmTotalMs?: number;
  firstVisibleMs?: number;
  ttsFirstAudioMs?: number;
  totalMs?: number;
  backgroundMs?: number;
}

export interface TelemetryEntry {
  requestId: string;
  kind: 'text' | 'voice';
  userId?: string;
  channelId?: string;
  provider?: string;
  model?: string;
  spans: Partial<Record<SpanName, number>>;
  metrics: TelemetryMetrics;
  error?: string;
  createdAt: number;
}

export interface TelemetrySink {
  record(entry: TelemetryEntry): void;
}

const diff = (spans: Partial<Record<SpanName, number>>, a: SpanName, b: SpanName): number | undefined => {
  const x = spans[a];
  const y = spans[b];
  return x !== undefined && y !== undefined ? y - x : undefined;
};

export function computeMetrics(spans: Partial<Record<SpanName, number>>): TelemetryMetrics {
  return {
    sttMs: diff(spans, 'stt_start', 'stt_end'),
    memoryRetrievalMs: diff(spans, 'retrieval_start', 'retrieval_end'),
    contextBuildMs: diff(spans, 'message_received', 'context_ready'),
    ttftMs: diff(spans, 'llm_request_start', 'first_token'),
    llmTotalMs: diff(spans, 'llm_request_start', 'llm_complete'),
    firstVisibleMs: diff(spans, 'message_received', 'first_visible_output'),
    ttsFirstAudioMs: diff(spans, 'tts_start', 'first_audio'),
    totalMs: diff(spans, 'message_received', 'response_complete'),
    backgroundMs: diff(spans, 'background_start', 'background_end'),
  };
}

export interface TracerMeta {
  kind: 'text' | 'voice';
  userId?: string;
  channelId?: string;
}

export class RequestTracer {
  readonly requestId: string;
  readonly startedAt = Date.now();
  private readonly spans: Partial<Record<SpanName, number>> = {};
  meta: TracerMeta;
  provider?: string;
  model?: string;
  error?: string;

  constructor(meta: TracerMeta, requestId?: string) {
    this.requestId = requestId ?? newId('req');
    this.meta = meta;
  }

  /** Ставит точку. Повторная постановка той же точки игнорируется (первая побеждает). */
  mark(name: SpanName, at = Date.now()): void {
    if (this.spans[name] === undefined) this.spans[name] = at;
  }

  /** Переставляет точку принудительно (например, message_received задаётся задним числом). */
  set(name: SpanName, at: number): void {
    this.spans[name] = at;
  }

  get metrics(): TelemetryMetrics {
    return computeMetrics(this.spans);
  }

  toEntry(): TelemetryEntry {
    return {
      requestId: this.requestId,
      kind: this.meta.kind,
      userId: this.meta.userId,
      channelId: this.meta.channelId,
      provider: this.provider,
      model: this.model,
      spans: { ...this.spans },
      metrics: this.metrics,
      error: this.error,
      createdAt: this.startedAt,
    };
  }
}

export interface TelemetryDeps {
  sink?: TelemetrySink;
  log?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
  enabled?: boolean;
}

/**
 * Пишет завершённый трейс в sink (БД) и одной компактной строкой в лог.
 * Ошибки телеметрии не должны ронять основной поток — всё глушится.
 */
export class Telemetry {
  constructor(private deps: TelemetryDeps = {}) {}

  finish(tracer: RequestTracer): void {
    if (this.deps.enabled === false) return;
    try {
      const entry = tracer.toEntry();
      this.deps.sink?.record(entry);
      const m = entry.metrics;
      const parts = [
        `req=${entry.requestId}`,
        `kind=${entry.kind}`,
        m.ttftMs !== undefined && `ttft=${m.ttftMs}ms`,
        m.memoryRetrievalMs !== undefined && `mem=${m.memoryRetrievalMs}ms`,
        m.contextBuildMs !== undefined && `ctx=${m.contextBuildMs}ms`,
        m.firstVisibleMs !== undefined && `first_visible=${m.firstVisibleMs}ms`,
        m.llmTotalMs !== undefined && `llm=${m.llmTotalMs}ms`,
        m.ttsFirstAudioMs !== undefined && `tts=${m.ttsFirstAudioMs}ms`,
        m.sttMs !== undefined && `stt=${m.sttMs}ms`,
        m.totalMs !== undefined && `total=${m.totalMs}ms`,
        entry.model && `model=${entry.model}`,
        entry.error && `error=${entry.error}`,
      ].filter(Boolean);
      const msg = `latency ${parts.join(' ')}`;
      if (entry.error) this.deps.log?.warn({ entry }, msg);
      else this.deps.log?.info({ entry }, msg);
    } catch {
      // телеметрия — не критичный путь
    }
  }
}
