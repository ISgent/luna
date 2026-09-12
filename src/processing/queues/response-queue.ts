import { BatchDebouncer } from '../../utils/debounce.js';
import { KeyedSerialQueue, CancelledError } from '../../utils/queue.js';
import { isAbortError } from '../../utils/async.js';
import type { RequestTracer } from '../../logging/telemetry.js';
import type { IncomingMessage, ReplySink } from '../../core/conversation/conversation-manager.js';

/**
 * ResponseQueue (ТЗ §39): управление конкурирующими сообщениями на канал.
 *
 * - DEBOUNCE: сообщения, присланные пачкой за короткое окно, объединяются
 *   в один запрос (это НЕ искусственная задержка — окно открывается только
 *   когда человек реально строчит подряд).
 * - SERIAL: на один канал не бывает двух одновременных LLM-генераций.
 * - REGENERATE: если генерация началась, но первый видимый ответ ещё НЕ
 *   отправлен и прошло < regenerateWindowMs, а пользователь дописал ещё —
 *   текущая генерация отменяется и запускается заново на объединённом вводе.
 * - CANCEL: отменённый sink получает onCancelled() и подчищает UI.
 */

export interface QueuedItem {
  msg: IncomingMessage;
  sink: ReplySink;
  tracer?: RequestTracer;
  receivedAt: number;
}

export interface ResponseQueueDeps {
  debounceMs: number;
  debounceMaxWaitMs?: number;
  regenerateWindowMs: number;
  /** Обработка батча: обычно ConversationManager.handle с объединённым сообщением. */
  process: (batch: QueuedItem[], signal: AbortSignal) => Promise<void>;
  onRegenerated?: (batch: QueuedItem[]) => void;
}

interface ChannelState {
  debouncer: BatchDebouncer<QueuedItem>;
  running?: {
    startedAt: number;
    firstEmitted: boolean;
    cancel: () => void;
    items: QueuedItem[];
  };
}

export class ResponseQueue {
  private readonly serial = new KeyedSerialQueue();
  private readonly channels = new Map<string, ChannelState>();

  constructor(private deps: ResponseQueueDeps) {}

  private state(channelId: string): ChannelState {
    let st = this.channels.get(channelId);
    if (!st) {
      st = {
        debouncer: new BatchDebouncer<QueuedItem>({
          windowMs: this.deps.debounceMs,
          maxWaitMs: this.deps.debounceMaxWaitMs ?? 3000,
          onFlush: (batch) => this.onBatch(channelId, batch),
        }),
      };
      this.channels.set(channelId, st);
    }
    return st;
  }

  enqueue(item: QueuedItem): void {
    this.state(item.msg.channelId).debouncer.push(item);
  }

  /** Sink сообщает, что первый видимый ответ ушёл — регенерация больше невозможна. */
  markFirstEmitted(channelId: string): void {
    const st = this.channels.get(channelId);
    if (st?.running) st.running.firstEmitted = true;
  }

  private onBatch(channelId: string, batch: QueuedItem[]): void {
    const st = this.state(channelId);
    const run = st.running;
    const canRegenerate =
      run &&
      !run.firstEmitted &&
      Date.now() - run.startedAt < this.deps.regenerateWindowMs;

    if (canRegenerate && run) {
      // отменяем текущую генерацию и перезапускаем на объединённом вводе
      run.cancel();
      for (const item of run.items) void item.sink.onCancelled?.().catch(() => {});
      const merged = [...run.items, ...batch];
      this.deps.onRegenerated?.(merged);
      this.start(channelId, st, merged);
      return;
    }

    this.start(channelId, st, batch);
  }

  private start(channelId: string, st: ChannelState, items: QueuedItem[]): void {
    // cancel проставляется лениво: serial.run запускает задачу синхронно,
    // до присваивания handle (иначе TDZ)
    const cancelRef: { cancel: () => void } = { cancel: () => {} };
    const handle = this.serial.run(channelId, async (signal) => {
      st.running = {
        startedAt: Date.now(),
        firstEmitted: false,
        cancel: () => cancelRef.cancel(),
        items,
      };
      try {
        await this.deps.process(items, signal);
      } finally {
        st.running = undefined;
      }
    });
    cancelRef.cancel = handle.cancel;
    handle.promise.catch((e) => {
      if (!isAbortError(e) && !(e instanceof CancelledError)) {
        // процессор батча сам обрабатывает ошибки sinks; сюда долетает только неожиданный крах
        for (const item of items) void item.sink.onError(e).catch(() => {});
      }
    });
  }

  /** Полная отмена очереди канала (например, /reset или удаление канала). */
  cancelChannel(channelId: string): void {
    const st = this.channels.get(channelId);
    st?.debouncer.cancel();
    this.serial.cancelKey(channelId);
  }

  isBusy(channelId: string): boolean {
    return this.serial.isBusy(channelId);
  }
}

/**
 * Объединяет батч сообщений в один QueuedItem.
 * Разные авторы → каждая реплика с именем.
 * Sink берётся у ПОСЛЕДНЕГО элемента: предыдущие могли уже получить onCancelled.
 */
export function mergeBatch(batch: QueuedItem[]): QueuedItem {
  if (batch.length === 1) return batch[0]!;
  const last = batch[batch.length - 1]!;
  const sameAuthor = batch.every((b) => b.msg.personId === batch[0]!.msg.personId);
  const text = sameAuthor
    ? batch.map((b) => b.msg.text).join('\n')
    : batch.map((b) => `${b.msg.personName}: ${b.msg.text}`).join('\n');
  return {
    ...last,
    msg: {
      ...last.msg,
      text,
      at: last.msg.at,
    },
  };
}
