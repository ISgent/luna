import { describe, it, expect, vi } from 'vitest';
import { RequestTracer, Telemetry, computeMetrics, type TelemetryEntry } from '../../src/logging/telemetry.js';

describe('RequestTracer', () => {
  it('считает производные метрики из точек', () => {
    const tr = new RequestTracer({ kind: 'text', userId: 'u1', channelId: 'c1' });
    tr.set('message_received', 1000);
    tr.set('retrieval_start', 1005);
    tr.set('retrieval_end', 1205);
    tr.set('context_ready', 1210);
    tr.set('llm_request_start', 1215);
    tr.set('first_token', 1815);
    tr.set('first_visible_output', 1900);
    tr.set('llm_complete', 3215);
    tr.set('response_complete', 3300);

    const m = tr.metrics;
    expect(m.memoryRetrievalMs).toBe(200);
    expect(m.contextBuildMs).toBe(210);
    expect(m.ttftMs).toBe(600);
    expect(m.firstVisibleMs).toBe(900);
    expect(m.llmTotalMs).toBe(2000);
    expect(m.totalMs).toBe(2300);
    expect(m.ttsFirstAudioMs).toBeUndefined();
  });

  it('первая точка побеждает (mark не перезаписывает)', () => {
    const tr = new RequestTracer({ kind: 'voice' });
    tr.mark('first_token', 100);
    tr.mark('first_token', 999);
    expect(tr.toEntry().spans.first_token).toBe(100);
  });

  it('computeMetrics с неполными данными не падает', () => {
    const m = computeMetrics({ message_received: 1, first_token: 5 });
    expect(m.ttftMs).toBeUndefined();
    expect(m.totalMs).toBeUndefined();
  });
});

describe('Telemetry', () => {
  it('пишет запись в sink и строку в лог', () => {
    const entries: TelemetryEntry[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const t = new Telemetry({ sink: { record: (e) => entries.push(e) }, log });

    const tr = new RequestTracer({ kind: 'text', userId: 'u', channelId: 'c' });
    tr.model = 'qwen-flash';
    tr.set('message_received', 0);
    tr.set('llm_request_start', 10);
    tr.set('first_token', 300);
    tr.set('response_complete', 900);
    t.finish(tr);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.metrics.ttftMs).toBe(290);
    expect(entries[0]!.model).toBe('qwen-flash');
    expect(log.info).toHaveBeenCalledOnce();
    const line = log.info.mock.calls[0]![1] as string;
    expect(line).toContain('ttft=290ms');
    expect(line).toContain('total=900ms');
  });

  it('ошибка уходит в warn и в entry.error', () => {
    const entries: TelemetryEntry[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const t = new Telemetry({ sink: { record: (e) => entries.push(e) }, log });
    const tr = new RequestTracer({ kind: 'text' });
    tr.error = 'LLM timeout';
    tr.mark('message_received');
    t.finish(tr);
    expect(entries[0]!.error).toBe('LLM timeout');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('enabled=false — полная тишина', () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const sink = { record: vi.fn() };
    const t = new Telemetry({ sink, log, enabled: false });
    const tr = new RequestTracer({ kind: 'text' });
    t.finish(tr);
    expect(sink.record).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('падающий sink не роняет finish', () => {
    const t = new Telemetry({
      sink: {
        record() {
          throw new Error('db down');
        },
      },
    });
    const tr = new RequestTracer({ kind: 'text' });
    expect(() => t.finish(tr)).not.toThrow();
  });
});
