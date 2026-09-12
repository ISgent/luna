import type { RequestTracer } from '../../logging/telemetry.js';
import type { ReplySink } from '../../core/conversation/conversation-manager.js';
import { splitForMessage } from '../../utils/text.js';
import type { Logger } from '../../logging/logger.js';

/**
 * DiscordTextSink — стриминговый вывод ответа в текстовый канал.
 *
 * Стратегия (ТЗ §19): первое законченное предложение → СРАЗУ отдельное
 * сообщение; остальной стрим доезжает через throttled-редактирования
 * (rate limit Discord: 5 edit/5s — интервал из конфига); длинный ответ —
 * финальный edit + дополнительные сообщения.
 *
 * Написан против узкого интерфейса канала — тестируется без discord.js.
 */

export interface EditableMessage {
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface OutputChannel {
  send(content: string): Promise<EditableMessage>;
  sendTyping(): void;
}

export interface TextSinkOptions {
  channel: OutputChannel;
  editIntervalMs: number;
  chunkLimit: number;
  tracer?: RequestTracer;
  /** Вызывается, когда первый текст реально ушёл в канал (для ResponseQueue). */
  onFirstVisible?: () => void;
  logger?: Logger;
  fallbackLines?: string[];
}

const DEFAULT_FALLBACKS = [
  'ой, я зависла на секунду… повторишь?',
  'что-то меня коротнуло. скажи ещё раз?',
  'так, я потеряла мысль. что ты говорил?',
];

export class DiscordTextSink implements ReplySink {
  private message: EditableMessage | null = null;
  private lastEditedText = '';
  private lastEditAt = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private latestFull = '';
  private finished = false;
  private readonly fallbacks: string[];

  constructor(private opts: TextSinkOptions) {
    this.fallbacks = opts.fallbackLines ?? DEFAULT_FALLBACKS;
  }

  async onFirstSentence(sentence: string): Promise<void> {
    if (this.finished || this.message) return;
    this.latestFull = sentence;
    try {
      this.message = await this.opts.channel.send(sentence);
      this.lastEditedText = sentence;
      this.lastEditAt = Date.now();
      this.opts.tracer?.mark('first_visible_output');
      this.opts.onFirstVisible?.();
    } catch (e) {
      this.opts.logger?.warn({ err: String(e) }, 'failed to send first sentence');
    }
  }

  async onSentence(_sentence: string, _index: number): Promise<void> {
    // текстовый sink накапливает через onProgress
  }

  async onProgress(fullText: string): Promise<void> {
    if (this.finished || !this.message) return;
    this.latestFull = fullText;
    const elapsed = Date.now() - this.lastEditAt;
    if (elapsed >= this.opts.editIntervalMs) {
      await this.doEdit(fullText);
    } else if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        void this.doEdit(this.latestFull);
      }, this.opts.editIntervalMs - elapsed);
    }
  }

  private async doEdit(text: string): Promise<void> {
    if (!this.message || this.finished) return;
    const clipped = text.length > this.opts.chunkLimit ? text.slice(0, this.opts.chunkLimit) : text;
    if (clipped === this.lastEditedText) return;
    this.lastEditAt = Date.now();
    this.lastEditedText = clipped;
    try {
      await this.message.edit(clipped);
    } catch (e) {
      this.opts.logger?.warn({ err: String(e) }, 'edit failed');
    }
  }

  async onComplete(fullText: string): Promise<void> {
    this.finished = true;
    this.clearTimer();
    const finalText = fullText.trim();
    if (!finalText) return;

    if (!this.message) {
      // первое предложение не успело отправиться (короткий ответ без терминаторов)
      await this.onFirstSentence(finalText.length > this.opts.chunkLimit ? splitForMessage(finalText, this.opts.chunkLimit)[0]! : finalText);
    }

    const chunks = splitForMessage(finalText, this.opts.chunkLimit);
    if (this.message) {
      try {
        await this.message.edit(chunks[0]!);
      } catch (e) {
        this.opts.logger?.warn({ err: String(e) }, 'final edit failed');
      }
      for (const extra of chunks.slice(1)) {
        try {
          await this.opts.channel.send(extra);
        } catch (e) {
          this.opts.logger?.warn({ err: String(e) }, 'failed to send continuation');
        }
      }
    }
  }

  async onCancelled(): Promise<void> {
    this.finished = true;
    this.clearTimer();
    if (this.message) {
      try {
        await this.message.delete();
      } catch {
        // уже удалено — не важно
      }
      this.message = null;
    }
  }

  async onError(_error: unknown): Promise<void> {
    this.finished = true;
    this.clearTimer();
    // TTS/LLM упал — человеческая фраза вместо технического мусора (ТЗ §37)
    if (!this.message) {
      const line = this.fallbacks[Math.floor(Math.random() * this.fallbacks.length)]!;
      try {
        await this.opts.channel.send(line);
      } catch {
        // канал недоступен — уже некому отвечать
      }
    }
  }

  private clearTimer(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }
}
