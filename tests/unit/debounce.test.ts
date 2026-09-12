import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchDebouncer } from '../../src/utils/debounce.js';

describe('BatchDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('windowMs=0 флашит немедленно', () => {
    const batches: number[][] = [];
    const d = new BatchDebouncer<number>({ windowMs: 0, onFlush: (b) => batches.push(b) });
    d.push(1);
    d.push(2);
    expect(batches).toEqual([[1], [2]]);
  });

  it('пачка сообщений в окне собирается в один flush', () => {
    const batches: string[][] = [];
    const d = new BatchDebouncer<string>({ windowMs: 100, onFlush: (b) => batches.push(b) });
    d.push('привет');
    vi.advanceTimersByTime(60);
    d.push('ты тут');
    vi.advanceTimersByTime(60);
    d.push('?');
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(101);
    expect(batches).toEqual([['привет', 'ты тут', '?']]);
  });

  it('maxWaitMs не даёт батчить вечно', () => {
    const batches: number[][] = [];
    const d = new BatchDebouncer<number>({
      windowMs: 100,
      maxWaitMs: 250,
      onFlush: (b) => batches.push(b),
    });
    for (let i = 0; i < 10; i++) {
      d.push(i);
      vi.advanceTimersByTime(50);
    }
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]!.length).toBeGreaterThan(1);
  });

  it('flushNow и cancel', () => {
    const batches: number[][] = [];
    const d = new BatchDebouncer<number>({ windowMs: 1000, onFlush: (b) => batches.push(b) });
    d.push(1);
    d.flushNow();
    expect(batches).toEqual([[1]]);
    d.push(2);
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(batches).toEqual([[1]]);
    expect(d.pending).toEqual([]);
  });
});
