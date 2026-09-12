import type { SummariesRepo, SettingsRepo } from '../../storage/index.js';
import type { EmotionalState, RelationshipState, RetrievedMemory } from '../../luna/types.js';
import type { RelationshipManager } from '../../luna/relationships/relationship-manager.js';
import type { EmotionManager } from '../../luna/emotion/emotion-manager.js';
import type { MemoryRetrieval } from '../../luna/memory/retrieval.js';
import type { RequestTracer } from '../../logging/telemetry.js';
import type { SessionMessage } from '../conversation/session.js';

/**
 * ContextBuilder собирает минимальный, но достаточный контекст для ответа
 * (ТЗ §25). На горячем пути: локальные чтения SQLite + НЕ БОЛЕЕ одного
 * embeddings-вызова (внутри retrieval). Всё, что упало, деградирует,
 * но не блокирует ответ.
 */

export interface LunaContext {
  person: { id: string; displayName: string; isOwner: boolean };
  channel: { id: string; kind: 'text' | 'voice' | 'dm'; isGroup: boolean };
  relationship: RelationshipState;
  relationshipDescription: string;
  emotion: EmotionalState;
  emotionDescription: string;
  memories: RetrievedMemory[];
  summary: string | null;
  recent: SessionMessage[];
  userMessage: string;
  memoryEnabled: boolean;
  now: Date;
}

export interface ContextInput {
  person: { id: string; displayName: string; isOwner: boolean };
  channel: { id: string; kind: 'text' | 'voice' | 'dm'; isGroup: boolean };
  recent: SessionMessage[];
  userMessage: string;
  tracer?: RequestTracer;
  signal?: AbortSignal;
}

export interface ContextBuilderDeps {
  relationships: RelationshipManager;
  emotions: EmotionManager;
  retrieval: MemoryRetrieval;
  summaries: SummariesRepo;
  settings: SettingsRepo;
  memoryEnabledGlobally: boolean;
}

export class ContextBuilder {
  constructor(private deps: ContextBuilderDeps) {}

  async build(input: ContextInput): Promise<LunaContext> {
    const now = Date.now();

    // Локальные чтения — мгновенно, без внешних вызовов.
    // ensureAndCount: заодно фиксирует взаимодействие (+1 к счётчику, familiarity).
    const relationship = this.deps.relationships.ensureAndCount({
      id: input.person.id,
      displayName: input.person.displayName,
      isOwner: input.person.isOwner,
    });
    const relationshipDescription = this.deps.relationships.describeForPrompt(relationship);
    const emotion = this.deps.emotions.current();
    const emotionDescription = this.deps.emotions.describe(emotion);

    const memoryEnabled =
      this.deps.memoryEnabledGlobally &&
      this.deps.settings.getBool(`user:${input.person.id}`, 'memory_enabled', true);

    // Retrieval — единственный потенциально внешний вызов на горячем пути
    input.tracer?.mark('retrieval_start');
    let memories: RetrievedMemory[] = [];
    if (memoryEnabled && input.userMessage.trim().length > 0) {
      try {
        memories = await this.deps.retrieval.retrieve({
          query: input.userMessage,
          personId: input.person.id,
          signal: input.signal,
          now,
        });
      } catch {
        memories = []; // ответ не блокируется
      }
    }
    input.tracer?.mark('retrieval_end');

    const latest = this.deps.summaries.latest(input.channel.id, 1);
    const summary = latest.length > 0 ? latest[0]!.summary : null;

    return {
      person: input.person,
      channel: input.channel,
      relationship,
      relationshipDescription,
      emotion,
      emotionDescription,
      memories,
      summary,
      recent: [...input.recent],
      userMessage: input.userMessage,
      memoryEnabled,
      now: new Date(now),
    };
  }
}
