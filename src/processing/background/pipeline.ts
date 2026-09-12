import type { LunaEventBus, ResponseCompletedEvent, SummaryNeededEvent } from '../../core/events/bus.js';
import type { MemoryManager } from '../../luna/memory/memory-manager.js';
import type { RelationshipManager } from '../../luna/relationships/relationship-manager.js';
import type { EmotionManager } from '../../luna/emotion/emotion-manager.js';
import type { BackgroundExtractor } from './extractor.js';
import type { ConversationSummarizer } from './summarizer.js';
import type { SettingsRepo } from '../../storage/index.js';
import { KeyedSerialQueue } from '../../utils/queue.js';
import type { Logger } from '../../logging/logger.js';

/**
 * BackgroundPipeline (ТЗ §16): подписан на события шины и выполняет
 * ВСЮ необязательную работу ПОСЛЕ того, как пользователь получил ответ.
 *
 * Гарантии:
 * - ответ пользователя НИКОГДА не зависит от успеха/провала фона;
 * - ОДИН structured-вызов на обмен (не пять);
 * - последовательность на человека (нет гонок записи), параллельность между людьми;
 * - память отключена (глобально или пользователем) → персональные данные не извлекаются.
 */

export interface BackgroundPipelineDeps {
  bus: LunaEventBus;
  extractor: BackgroundExtractor;
  summarizer: ConversationSummarizer;
  memory: MemoryManager;
  relationships: RelationshipManager;
  emotions: EmotionManager;
  settings: SettingsRepo;
  memoryEnabledGlobally: boolean;
  logger: Logger;
}

export class BackgroundPipeline {
  private readonly queue = new KeyedSerialQueue();
  private unsub: Array<() => void> = [];

  constructor(private deps: BackgroundPipelineDeps) {}

  start(): void {
    this.unsub.push(this.deps.bus.onResponseCompleted((e) => this.onResponse(e)));
    this.unsub.push(this.deps.bus.onSummaryNeeded((e) => this.onSummary(e)));
  }

  stop(): void {
    for (const off of this.unsub) off();
    this.unsub = [];
  }

  private memoryAllowed(personId: string): boolean {
    return (
      this.deps.memoryEnabledGlobally &&
      this.deps.settings.getBool(`user:${personId}`, 'memory_enabled', true)
    );
  }

  private onResponse(e: ResponseCompletedEvent): void {
    const started = Date.now();
    this.queue.run(`bg:${e.personId}`, async () => {
      try {
        if (!this.memoryAllowed(e.personId)) return;

        e.tracer?.mark('background_start', started);
        const relationship = this.deps.relationships.get(e.personId);
        const extraction = await this.deps.extractor.extract({
          personName: e.personName,
          isOwner: e.isOwner,
          userMessage: e.userMessage,
          lunaReply: e.lunaReply,
          relationshipDescription: this.deps.relationships.describeForPrompt(relationship),
          emotionDescription: this.deps.emotions.describe(),
        });
        if (!extraction) {
          this.deps.logger.warn({ requestId: e.requestId }, 'background extraction returned nothing');
          e.tracer?.mark('background_end');
          return;
        }

        // 1. Памяти (с дедупликацией внутри MemoryManager)
        for (const cand of extraction.memories ?? []) {
          try {
            await this.deps.memory.store({
              kind: cand.kind,
              content: cand.content,
              objectiveFacts: cand.objectiveFacts,
              subjective: cand.subjective ?? null,
              emotion: cand.emotion ?? null,
              emotionIntensity: cand.emotionIntensity,
              importance: cand.importance,
              confidence: cand.confidence,
              personId: e.personId,
              dedupeKey: cand.dedupeKey ?? null,
            }, { channelId: e.channelId, sourceConversationId: e.conversationId });
          } catch (err) {
            this.deps.logger.warn({ err: String(err), requestId: e.requestId }, 'memory store failed');
          }
        }

        // 2. Отношения (плавные дельты — ограничение внутри менеджера)
        if (extraction.relationshipDelta) {
          this.deps.relationships.applyDeltas(e.personId, {
            trust: extraction.relationshipDelta.trust,
            closeness: extraction.relationshipDelta.closeness,
            affection: extraction.relationshipDelta.affection,
            respect: extraction.relationshipDelta.respect,
            sharedXpAdd: extraction.relationshipDelta.sharedXpAdd,
            summary: extraction.relationshipDelta.summary,
          });
        }

        // 3. Текущее эмоциональное состояние
        if (extraction.emotionDeltas) {
          this.deps.emotions.applyDeltas(extraction.emotionDeltas);
        }

        e.tracer?.mark('background_end');
        this.deps.logger.info(
          {
            requestId: e.requestId,
            memories: (extraction.memories ?? []).length,
            backgroundMs: Date.now() - started,
          },
          'background pipeline done',
        );
      } catch (err) {
        // фон упал — ответ пользователя уже отправлен, просто логируем
        this.deps.logger.error({ err: String(err), requestId: e.requestId }, 'background pipeline failed');
      }
    });
  }

  private onSummary(e: SummaryNeededEvent): void {
    this.queue.run(`summary:${e.channelId}`, async () => {
      try {
        await this.deps.summarizer.summarizeChannel(e.channelId, e.messages);
      } catch (err) {
        this.deps.logger.error({ err: String(err), channelId: e.channelId }, 'summarization failed');
      }
    });
  }

  /** Дождаться завершения всех фоновых задач (для тестов и graceful shutdown). */
  async drain(): Promise<void> {
    await this.queue.waitIdle();
  }
}
