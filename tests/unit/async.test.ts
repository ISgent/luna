import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  TimeoutError,
  retryAsync,
  CircuitBreaker,
  BreakerOpenError,
  sleep,
} from '../../src/utils/async.js';

describe('withTimeout', () => {
  it('быстрая функция успевает', async () => {
    const v = await withTimeout(1000, async () => 42);
    expect(v).toBe(42);
  });

  it('медленная функция падает с TimeoutError', async () => {
    await expect(
      withTimeout(30, async () => {
        await sleep(500);
        return 1;
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('внешний signal отменяет', async () => {
    const ac = new AbortController();
    const p = withTimeout(
      5000,
      async (signal) => {
        await sleep(4000, signal);
        return 1;
      },
      ac.signal,
    );
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow();
  });
});

describe('retryAsync', () => {
  it('повторяет до успеха', async () => {
    let calls = 0;
    const v = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 1, jitter: false },
    );
    expect(v).toBe('ok');
    expect(calls).toBe(3);
  });

  it('не более attempts попыток', async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new Error('always');
        },
        { attempts: 3, baseDelayMs: 1, jitter: false },
      ),
    ).rejects.toThrow('always');
    expect(calls).toBe(3);
  });

  it('shouldRetry=false останавливает сразу', async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { attempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('backoff растёт', async () => {
    const delays: number[] = [];
    await expect(
      retryAsync(async () => { throw new Error('x'); }, {
        attempts: 4,
        baseDelayMs: 10,
        factor: 2,
        jitter: false,
        onRetry: (_e, _a, d) => delays.push(d),
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([10, 20, 40]);
  });

  it('abort во время паузы между попытками прекращает retry', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = retryAsync(
      async () => {
        calls++;
        throw new Error('x');
      },
      { attempts: 10, baseDelayMs: 300, jitter: false, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  it('открывается после порога ошибок и пропускает после cooldown', async () => {
    let t = 0;
    const br = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      cooldownMs: 1000,
      now: () => t,
    });
    const fail = () => br.call(async () => { throw new Error('boom'); });
    await expect(fail()).rejects.toThrow('boom');
    expect(br.state).toBe('closed');
    await expect(fail()).rejects.toThrow('boom');
    expect(br.state).toBe('open');
    await expect(br.call(async () => 1)).rejects.toBeInstanceOf(BreakerOpenError);

    t += 1001;
    expect(br.state).toBe('half-open');
    // half-open пропускает пробный вызов
    const v = await br.call(async () => 'alive');
    expect(v).toBe('alive');
    expect(br.state).toBe('closed');
  });

  it('ошибка в half-open снова открывает', async () => {
    let t = 0;
    const br = new CircuitBreaker({ name: 'x', failureThreshold: 1, cooldownMs: 500, now: () => t });
    await expect(br.call(async () => { throw new Error('e'); })).rejects.toThrow();
    expect(br.state).toBe('open');
    t += 501;
    await expect(br.call(async () => { throw new Error('e2'); })).rejects.toThrow('e2');
    expect(br.state).toBe('open');
  });

  it('отмена пользователя не считается отказом провайдера', async () => {
    const br = new CircuitBreaker({ name: 'x', failureThreshold: 1 });
    const err = new Error('aborted');
    err.name = 'AbortError';
    await expect(br.call(async () => { throw err; })).rejects.toThrow();
    expect(br.state).toBe('closed');
  });
});

describe('sleep', () => {
  it('спит примерно заданное время', async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('прерывается по signal', async () => {
    const ac = new AbortController();
    const p = sleep(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
