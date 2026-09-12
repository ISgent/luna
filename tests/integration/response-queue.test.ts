import { describe, it, expect, afterEach } from 'vitest';
import { TestHarness, FakeSink, sleep } from './harness.js';
import { ResponseQueue, mergeBatch, type QueuedItem } from '../../src/processing/queues/response-queue.js';
import type { IncomingMessage } from '../../src/core/conversation/conversation-manager.js';

let h: TestHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function msg(text: string, channelId = 'ch1'): IncomingMessage {
  return {
    personId: 'owner1',
    personName: 'Gent',
    isOwner: true,
    channelId,
    channelKind: 'text',
    text,
    at: Date.now(),
  };
}

function item(text: string, channelId = 'ch1'): QueuedItem {
  return { msg: msg(text, channelId), sink: new FakeSink(), receivedAt: Date.now() };
}

describe('ResponseQueue — батчинг (debounce)', () => {
  it('три быстрых сообщения → один LLM-вызов со склеенным текстом', async () => {
    h = new TestHarness({ reply: 'Все три видел.' });
    h.enqueue(msg('привет'));
    h.enqueue(msg('ты тут'));
    h.enqueue(msg('есть вопрос'));
    await sleep(400);
    expect(h.llm.calls.filter((c) => c.kind === 'stream')).toHaveLength(1);
    const lastUser = h.lastPrompt()[h.lastPrompt().length - 1]!.content;
    expect(lastUser).toContain('привет');
    expect(lastUser).toContain('ты тут');
    expect(lastUser).toContain('есть вопрос');
  });

  it('сообщения с паузой больше окна — отдельные ответы', async () => {
    h = new TestHarness({ reply: 'ок.' });
    h.enqueue(msg('раз'));
    await sleep(120);
    h.enqueue(msg('два'));
    await sleep(400);
    expect(h.llm.calls.filter((c) => c.kind === 'stream')).toHaveLength(2);
  });
});

describe('ResponseQueue — последовательность на канал', () => {
  it('две пачки в один канал не пересекаются', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runs: string[] = [];
    const q = new ResponseQueue({
      debounceMs: 5,
      regenerateWindowMs: 0, // регенерация выключена
      process: async (batch) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(30);
        runs.push(batch.map((b) => b.msg.text).join('+'));
        concurrent--;
      },
    });
    q.enqueue(item('a'));
    await sleep(20);
    q.enqueue(item('b'));
    await sleep(200);
    expect(runs).toEqual(['a', 'b']);
    expect(maxConcurrent).toBe(1);
  });

  it('разные каналы идут параллельно', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = new ResponseQueue({
      debounceMs: 0,
      regenerateWindowMs: 0,
      process: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(40);
        concurrent--;
      },
    });
    q.enqueue(item('a', 'chA'));
    q.enqueue(item('b', 'chB'));
    await sleep(150);
    expect(maxConcurrent).toBe(2);
  });
});

describe('ResponseQueue — регенерация при дописывании', () => {
  it('до первого видимого ответа: отмена + перезапуск на объединённом вводе', async () => {
    const started: string[][] = [];
    let firstRunAborted = false;
    const q = new ResponseQueue({
      debounceMs: 5,
      regenerateWindowMs: 1500,
      process: async (batch, signal) => {
        started.push(batch.map((b) => b.msg.text));
        if (started.length === 1) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            signal.addEventListener('abort', () => {
              firstRunAborted = true;
              clearTimeout(t);
              resolve();
            });
          });
          if (signal.aborted) return;
        } else {
          await sleep(10);
        }
      },
    });
    const i1 = item('начало мысли');
    const i2 = item('и вот ещё');
    q.enqueue(i1);
    await sleep(30); // первая генерация началась
    q.enqueue(i2);
    await sleep(120);
    expect(firstRunAborted).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[1]).toEqual(['начало мысли', 'и вот ещё']);
    expect((i1.sink as FakeSink).cancelledCount).toBe(1);
    expect((i2.sink as FakeSink).cancelledCount).toBe(0);
  });

  it('после первого видимого ответа регенерации нет — батч ждёт очереди', async () => {
    const started: string[][] = [];
    const q = new ResponseQueue({
      debounceMs: 5,
      regenerateWindowMs: 5000,
      process: async (batch) => {
        started.push(batch.map((b) => b.msg.text));
        await sleep(40);
      },
    });
    const i1 = item('первый');
    q.enqueue(i1);
    await sleep(15);
    q.markFirstEmitted('ch1'); // первый видимый ответ ушёл
    q.enqueue(item('второй'));
    await sleep(200);
    expect(started).toEqual([['первый'], ['второй']]);
    expect((i1.sink as FakeSink).cancelledCount).toBe(0);
  });
});

describe('mergeBatch', () => {
  it('один автор — текст склеивается через перевод строки, sink — последний', () => {
    const a = item('раз');
    const b = item('два');
    const m = mergeBatch([a, b]);
    expect(m.msg.text).toBe('раз\nдва');
    expect(m.sink).toBe(b.sink);
  });

  it('разные авторы — каждая реплика с именем', () => {
    const a = item('привет');
    const b: QueuedItem = { ...item('здорово'), msg: { ...msg('здорово'), personId: 'other', personName: 'Вася' } };
    const m = mergeBatch([a, b]);
    expect(m.msg.text).toBe('Gent: привет\nВася: здорово');
  });
});
