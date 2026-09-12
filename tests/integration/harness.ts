/**
 * Общий harness: собирает ВСЮ систему in-process на моках
 * (настоящие SQLite, менеджеры, шина; моки — только AI-провайдеры).
 * Используется в интеграционных тестах и сценариях личности (ТЗ §44).
 */
import { Database, createRepositories, type Repositories } from '../../src/storage/index.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { Telemetry, RequestTracer, type TelemetryEntry } from '../../src/logging/telemetry.js';
import { MockLLMProvider, MockEmbeddingProvider } from '../../src/ai/mock.js';
import { RelationshipManager } from '../../src/luna/relationships/relationship-manager.js';
import { EmotionManager } from '../../src/luna/emotion/emotion-manager.js';
import { MemoryManager } from '../../src/luna/memory/memory-manager.js';
import { MemoryRetrieval } from '../../src/luna/memory/retrieval.js';
import { MemoryConsolidator } from '../../src/luna/memory/consolidator.js';
import { SessionStore } from '../../src/core/conversation/session.js';
import { ContextBuilder } from '../../src/core/context/context-builder.js';
import { PromptBuilder } from '../../src/core/conversation/prompt-builder.js';
import { ConversationManager, type IncomingMessage, type ReplySink } from '../../src/core/conversation/conversation-manager.js';
import { LunaEventBus } from '../../src/core/events/bus.js';
import { BackgroundExtractor, extractionSchema } from '../../src/processing/background/extractor.js';
import { ConversationSummarizer } from '../../src/processing/background/summarizer.js';
import { BackgroundPipeline } from '../../src/processing/background/pipeline.js';
import { ResponseQueue, mergeBatch, type QueuedItem } from '../../src/processing/queues/response-queue.js';
import { ToolRegistry } from '../../src/core/conversation/tools.js';
import { LUNA_CORE_PERSONALITY } from '../../src/luna/personality/core.js';
import type { ChatMessage, ToolCall } from '../../src/ai/types.js';
import type { z } from 'zod';

export type ExtractionJSON = z.infer<typeof extractionSchema>;

export interface HarnessOptions {
  reply?: string | ((messages: Array<{ role: string; content: string }>) => string);
  structured?: unknown;
  chunkDelayMs?: number;
  chunkSize?: number;
  shortTermSize?: number;
  summaryTriggerMessages?: number;
  memoryEnabled?: boolean;
  ownerId?: string;
  failStream?: boolean;
  /** Сколько первых LLM-вызовов должны упасть (проверка retry). */
  failTimes?: number;
  /** Tool-calling сценарий: вернуть вызовы вместо текста (первый заход). */
  toolScript?: (messages: never) => ToolCall[] | null;
  /** Текст ответа после выполнения инструментов. */
  replyAfterTools?: string;
}

export class FakeSink implements ReplySink {
  firstSentences: string[] = [];
  sentences: Array<{ text: string; index: number }> = [];
  progressCount = 0;
  lastProgress = '';
  completed: string | null = null;
  errors: unknown[] = [];
  cancelledCount = 0;
  /** вызывается, чтобы ResponseQueue узнал о первом видимом ответе */
  onFirstEmitted?: () => void;

  async onFirstSentence(s: string): Promise<void> {
    this.firstSentences.push(s);
    this.onFirstEmitted?.();
  }
  async onSentence(s: string, index: number): Promise<void> {
    this.sentences.push({ text: s, index });
  }
  async onProgress(full: string): Promise<void> {
    this.progressCount++;
    this.lastProgress = full;
  }
  async onComplete(full: string): Promise<void> {
    this.completed = full;
  }
  async onCancelled(): Promise<void> {
    this.cancelledCount++;
  }
  async onError(e: unknown): Promise<void> {
    this.errors.push(e);
  }
}

export class TestHarness {
  readonly db: Database;
  readonly repos: Repositories;
  readonly llm: MockLLMProvider;
  readonly embeddings: MockEmbeddingProvider;
  readonly relationships: RelationshipManager;
  readonly emotions: EmotionManager;
  readonly memory: MemoryManager;
  readonly retrieval: MemoryRetrieval;
  readonly consolidator: MemoryConsolidator;
  readonly sessions: SessionStore;
  readonly context: ContextBuilder;
  readonly prompts: PromptBuilder;
  readonly bus: LunaEventBus;
  readonly telemetryEntries: TelemetryEntry[] = [];
  readonly telemetry: Telemetry;
  readonly tools: ToolRegistry;
  readonly manager: ConversationManager;
  readonly pipeline: BackgroundPipeline;
  readonly summarizer: ConversationSummarizer;
  readonly queue: ResponseQueue;
  readonly logger = createSilentLogger();

  constructor(opts: HarnessOptions = {}) {
    this.db = Database.open(':memory:');
    this.repos = createRepositories(this.db);
    this.llm = new MockLLMProvider({
      reply: opts.failStream
        ? () => {
            throw new Error('stream boom');
          }
        : (opts.reply ?? 'Ну привет. Чего хотел?'),
      structured: opts.structured,
      chunkDelayMs: opts.chunkDelayMs,
      chunkSize: opts.chunkSize,
      failTimes: opts.failTimes,
      toolScript: opts.toolScript as ((messages: ChatMessage[]) => ToolCall[] | null) | undefined,
      replyAfterTools: opts.replyAfterTools,
    });
    this.embeddings = new MockEmbeddingProvider(128);
    const ownerId = opts.ownerId ?? 'owner1';
    this.relationships = new RelationshipManager(this.repos.users, this.repos.relationships, { ownerId });
    this.emotions = new EmotionManager(this.repos.emotions, { decayHalfLifeMin: 90 });
    this.memory = new MemoryManager(this.repos.memories, this.embeddings, {
      enabled: opts.memoryEnabled ?? true,
      dedupeSimilarity: 0.9,
    });
    this.retrieval = new MemoryRetrieval(this.repos.memories, this.embeddings, {
      mode: 'hybrid',
      topK: 8,
      minScore: 0.05,
      recencyHalfLifeDays: 14,
      weights: { semantic: 1, recency: 0.5, importance: 0.6, emotion: 0.35, recall: 0.25, personBoost: 1.25 },
    });
    this.consolidator = new MemoryConsolidator(this.repos.memories, this.llm, {
      backgroundModel: 'bg',
      minCluster: 6,
      protectImportance: 0.7,
    });
    this.sessions = new SessionStore(opts.shortTermSize ?? 24);
    this.context = new ContextBuilder({
      relationships: this.relationships,
      emotions: this.emotions,
      retrieval: this.retrieval,
      summaries: this.repos.summaries,
      settings: this.repos.settings,
      memoryEnabledGlobally: opts.memoryEnabled ?? true,
    });
    this.prompts = new PromptBuilder({
      corePersonality: LUNA_CORE_PERSONALITY,
      maxMemoryItems: 8,
      maxMemoryContentLength: 300,
    });
    this.bus = new LunaEventBus();
    this.telemetry = new Telemetry({
      sink: { record: (e) => this.telemetryEntries.push(e) },
      log: this.logger,
      enabled: true,
    });
    this.tools = new ToolRegistry();
    this.manager = new ConversationManager({
      sessions: this.sessions,
      context: this.context,
      prompts: this.prompts,
      llm: this.llm,
      bus: this.bus,
      telemetry: this.telemetry,
      memory: this.memory,
      stats: this.repos.stats,
      logger: this.logger,
      llmModel: 'mock-model',
      summaryTriggerMessages: opts.summaryTriggerMessages ?? 60,
      tools: this.tools,
    });
    const extractor = new BackgroundExtractor(this.llm, { backgroundModel: 'bg' });
    this.summarizer = new ConversationSummarizer(this.llm, this.repos.summaries, { backgroundModel: 'bg' });
    this.pipeline = new BackgroundPipeline({
      bus: this.bus,
      extractor,
      summarizer: this.summarizer,
      memory: this.memory,
      relationships: this.relationships,
      emotions: this.emotions,
      settings: this.repos.settings,
      memoryEnabledGlobally: opts.memoryEnabled ?? true,
      logger: this.logger,
    });
    this.pipeline.start();

    this.queue = new ResponseQueue({
      debounceMs: 20,
      regenerateWindowMs: 1500,
      process: async (batch, signal) => {
        const merged = mergeBatch(batch);
        await this.manager.handle(merged.msg, merged.sink, { tracer: merged.tracer, signal });
      },
    });
  }

  makeMessage(p: Partial<IncomingMessage> & { text: string }): IncomingMessage {
    return {
      personId: p.personId ?? 'owner1',
      personName: p.personName ?? 'Gent',
      isOwner: p.isOwner ?? (p.personId === undefined || p.personId === 'owner1'),
      channelId: p.channelId ?? 'ch1',
      channelKind: p.channelKind ?? 'text',
      at: p.at ?? Date.now(),
      ...p,
    };
  }

  async send(msg: IncomingMessage, sink?: FakeSink): Promise<FakeSink> {
    const s = sink ?? new FakeSink();
    await this.manager.handle(msg, s);
    return s;
  }

  enqueue(msg: IncomingMessage, sink?: FakeSink): QueuedItem {
    const s = sink ?? new FakeSink();
    s.onFirstEmitted = () => this.queue.markFirstEmitted(msg.channelId);
    const item: QueuedItem = { msg, sink: s, receivedAt: Date.now() };
    this.queue.enqueue(item);
    return item;
  }

  /** Последний STREAM-вызов (фоновые structured-вызовы не в счёт). */
  private lastStreamCall() {
    return this.llm.calls.findLast((c) => c.kind === 'stream');
  }

  /** Динамический системный блок последнего разговорного LLM-вызова. */
  lastDynamicBlock(): string {
    const call = this.lastStreamCall();
    if (!call) return '';
    return call.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  }

  lastPrompt(): Array<{ role: string; content: string }> {
    return this.lastStreamCall()?.messages ?? [];
  }

  newTracer(kind: 'text' | 'voice' = 'text'): RequestTracer {
    return new RequestTracer({ kind });
  }

  async close(): Promise<void> {
    this.pipeline.stop();
    this.db.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
