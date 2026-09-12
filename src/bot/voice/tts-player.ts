import type { TTSProvider } from '../../ai/types.js';
import type { ReplySink } from '../../core/conversation/conversation-manager.js';
import type { RequestTracer } from '../../logging/telemetry.js';
import type { Logger } from '../../logging/logger.js';
import { TextPreprocessor } from '../../utils/text.js';
import { toDiscordPCM } from '../../utils/audio.js';

/**
 * TtsPlayer — очередь озвучки на гильдию.
 *
 * Потоковая озвучка БЕЗ стримингового TTS-провайдера: предложения из
 * LLM-стрима синтезируются по мере поступления и играются последовательно —
 * Luna начинает говорить, когда модель ещё договаривает конец (ТЗ §19, §22).
 *
 * Никаких наложений: один поток воспроизведения, очередь FIFO.
 * barge-in (ТЗ §39): stop() очищает очередь и глушит текущее.
 */

export interface AudioOutput {
  /** Проиграть s16le 48кГц стерео до конца. */
  play(pcmDiscord: Int16Array): Promise<void>;
  /** Немедленно остановить текущее и очистить внутреннее состояние. */
  stopAll(): void;
}

export interface TtsPlayerOptions {
  voice?: string;
  logger?: Logger;
  tracer?: RequestTracer;
  onFirstAudio?: () => void;
}

export class TtsPlayer {
  private queue: string[] = [];
  private pumping = false;
  private stopped = false;
  private firstMarked = false;
  private readonly preprocessor = new TextPreprocessor();

  constructor(
    private tts: TTSProvider,
    private output: AudioOutput,
    private opts: TtsPlayerOptions = {},
  ) {}

  enqueue(sentence: string): void {
    if (this.stopped) return;
    const cleaned = this.preprocessor.forSpeech(sentence);
    if (!cleaned) return;
    this.queue.push(cleaned);
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.output.stopAll();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const sentence = this.queue.shift()!;
        try {
          if (!this.firstMarked) {
            this.opts.tracer?.mark('tts_start');
          }
          const pcm = await this.tts.synthesize({ text: sentence, voice: this.opts.voice });
          if (this.stopped) break;
          if (!this.firstMarked) {
            this.firstMarked = true;
            this.opts.tracer?.mark('first_audio');
            this.opts.onFirstAudio?.();
          }
          if (pcm.data.length === 0) continue;
          await this.output.play(toDiscordPCM(pcm));
        } catch (e) {
          // TTS упал — текст уже доставлен текстовым sink'ом; голос просто молчит (ТЗ §37)
          this.opts.logger?.warn({ err: String(e) }, 'tts sentence failed, skipping');
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * VoiceSink — ReplySink для голосового канала: каждое предложение в TTS-очередь.
 * Текст ответа параллельно может уходить в текстовый канал (если задан).
 */
export interface VoiceSinkDeps {
  player: TtsPlayer;
  tracer?: RequestTracer;
  textFallback?: ReplySink | null;
  logger?: Logger;
}

export class VoiceSink implements ReplySink {
  constructor(private deps: VoiceSinkDeps) {}

  async onFirstSentence(sentence: string): Promise<void> {
    this.deps.tracer?.mark('first_visible_output');
    this.deps.player.enqueue(sentence);
  }

  async onSentence(sentence: string, _index?: number): Promise<void> {
    this.deps.player.enqueue(sentence);
  }

  async onProgress(_fullText: string): Promise<void> {
    // голосу не нужны промежуточные редакции
  }

  async onComplete(fullText: string): Promise<void> {
    if (this.deps.textFallback && fullText.trim()) {
      // текстовая копия в канал — удобно, если кто-то без звука
      try {
        await this.deps.textFallback.onComplete(fullText);
      } catch (e) {
        this.deps.logger?.warn({ err: String(e) }, 'voice text fallback failed');
      }
    }
  }

  async onCancelled(): Promise<void> {
    this.deps.player.stop();
  }

  async onError(error: unknown): Promise<void> {
    this.deps.logger?.warn({ err: String(error) }, 'voice response failed');
    if (this.deps.textFallback) await this.deps.textFallback.onError(error).catch(() => {});
  }
}
