import { describe, it, expect } from 'vitest';
import { KeyedSerialQueue, CancelledError } from '../../src/utils/queue.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedSerialQueue', () => {
  it('задачи одного ключа идут последовательно', async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const p1 = q.run('a', async () => { await delay(30); order.push('1'); }).promise;
    const p2 = q.run('a', async () => { order.push('2'); }).promise;
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1', '2']);
  });

  it('разные ключи работают параллельно', async () => {
    const q = new KeyedSerialQueue();
    const t0 = Date.now();
    await Promise.all([
      q.run('a', async () => { await delay(50); }).promise,
      q.run('b', async () => { await delay(50); }).promise,
    ]);
    expect(Date.now() - t0).toBeLessThan(120);
  });

  it('cancelKey прерывает текущую и снимает ожидающие', async () => {
    const q = new KeyedSerialQueue();
    let sawAbort = false;
    const running = q.run('ch', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new CancelledError()));
        setTimeout(resolve, 500);
      });
    });
    const pending = q.run('ch', async () => 'never');
    await delay(10);
    q.cancelKey('ch');
    await expect(running.promise).rejects.toBeInstanceOf(CancelledError);
    await expect(pending.promise).rejects.toBeInstanceOf(CancelledError);
    sawAbort = true;
    expect(sawAbort).toBe(true);
  });

  it('отменённая ожидающая задача не запускается', async () => {
    const q = new KeyedSerialQueue();
    let secondRan = false;
    const first = q.run('k', async () => { await delay(30); });
    const second = q.run('k', async () => { secondRan = true; });
    second.cancel();
    await expect(second.promise).rejects.toBeInstanceOf(CancelledError);
    await first.promise;
    await delay(10);
    expect(secondRan).toBe(false);
  });

  it('очередь продолжает работать после отмены', async () => {
    const q = new KeyedSerialQueue();
    const blocker = q.run('k', async () => { await delay(20); });
    const victim = q.run('k', async () => 'x');
    victim.cancel();
    q.cancelKey('k');
    await Promise.allSettled([blocker.promise, victim.promise]);
    const after = await q.run('k', async () => 'ok').promise;
    expect(after).toBe('ok');
  });

  it('isBusy/pendingCount отражают состояние', async () => {
    const q = new KeyedSerialQueue();
    expect(q.isBusy('z')).toBe(false);
    const h1 = q.run('z', async () => { await delay(40); });
    const h2 = q.run('z', async () => {});
    await delay(5);
    expect(q.isBusy('z')).toBe(true);
    expect(q.pendingCount('z')).toBe(1);
    await Promise.all([h1.promise, h2.promise]);
    expect(q.isBusy('z')).toBe(false);
  });
});
