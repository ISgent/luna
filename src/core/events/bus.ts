import { EventEmitter } from 'node:events';
import type { RequestTracer } from '../../logging/telemetry.js';
import type { SessionMessage } from '../conversation/session.js';

/**
 * Внутренняя шина событий. Главный смысл: ответ пользователю и фоновая
 * обработка (память/отношения/эмоции/summary) РАЗДЕЛЕНЫ. Горячий путь
 * только публикует событие — и продолжает жить, даже если подписчиков нет
 * или они упали.
 */

export interface ResponseCompletedEvent {
  requestId: string;
  conversationId: string;
  personId: string;
  personName: string;
  isOwner: boolean;
  channelId: string;
  channelKind: 'text' | 'voice' | 'dm';
  userMessage: string;
  lunaReply: string;
  tracer: RequestTracer;
}

export interface SummaryNeededEvent {
  channelId: string;
  messages: SessionMessage[];
}

export class LunaEventBus {
  private ee = new EventEmitter();

  constructor() {
    // фоновых подписчиков может быть много, лимит по умолчанию мешал бы
    this.ee.setMaxListeners(50);
  }

  onResponseCompleted(fn: (e: ResponseCompletedEvent) => void): () => void {
    this.ee.on('response_completed', fn);
    return () => this.ee.off('response_completed', fn);
  }

  emitResponseCompleted(e: ResponseCompletedEvent): void {
    this.ee.emit('response_completed', e);
  }

  onSummaryNeeded(fn: (e: SummaryNeededEvent) => void): () => void {
    this.ee.on('summary_needed', fn);
    return () => this.ee.off('summary_needed', fn);
  }

  emitSummaryNeeded(e: SummaryNeededEvent): void {
    this.ee.emit('summary_needed', e);
  }
}
