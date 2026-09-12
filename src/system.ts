import type { AppConfig } from './config/index.js';
import { createLogger, type Logger } from './logging/logger.js';
import { Telemetry } from './logging/telemetry.js';
import { Database, createRepositories, type Repositories } from './storage/index.js';
import { createProviders } from './ai/registry.js';
import type { Providers } from './ai/registry.js';
import { RelationshipManager } from './luna/relationships/relationship-manager.js';
import { EmotionManager } from './luna/emotion/emotion-manager.js';
import { MemoryManager } from './luna/memory/memory-manager.js';
import { MemoryRetrieval } from './luna/memory/retrieval.js';
import { MemoryConsolidator } from './luna/memory/consolidator.js';
import { SessionStore } from './core/conversation/session.js';
import { ContextBuilder } from './core/context/context-builder.js';
import { PromptBuilder } from './core/conversation/prompt-builder.js';
import { ConversationManager } from './core/conversation/conversation-manager.js';
import { ToolRegistry } from './core/conversation/tools.js';
import { LunaEventBus } from './core/events/bus.js';
import { LUNA_CORE_PERSONALITY } from './luna/personality/core.js';
import { BackgroundExtractor } from './processing/background/extractor.js';
import { ConversationSummarizer } from './processing/background/summarizer.js';
import { BackgroundPipeline } from './processing/background/pipeline.js';
import { ResponseQueue, mergeBatch } from './processing/queues/response-queue.js';

/**
 * buildSystem — композиционный корень БЕЗ Discord-слоя.
 * Используется прод-запуском (index.ts), smoke-тестом и бенчмарком:
 * вся система собирается одинаково, различаются только провайдеры.
 */

export interface LunaSystem {
  cfg: AppConfig;
  logger: Logger;
  db: Database;
  repos: Repositories;
  providers: Providers;
  bus: LunaEventBus;
  telemetry: Telemetry;
  relationships: RelationshipManager;
  emotions: EmotionManager;
  memory: MemoryManager;
  retrieval: MemoryRetrieval;
  consolidator: MemoryConsolidator;
  sessions: SessionStore;
  context: ContextBuilder;
  prompts: PromptBuilder;
  manager: ConversationManager;
  /** Реестр инструментов модели; голосовые регистрируются в index.ts после создания VoiceManager. */
  tools: ToolRegistry;
  pipeline: BackgroundPipeline;
  queue: ResponseQueue;
  /** Остановить фоновые процессы и закрыть БД. */
  shutdown(): Promise<void>;
}

export interface BuildSystemOverrides {
  dbPath?: string;
  logger?: Logger;
  providers?: Partial<Providers>;
  /** Не стартовать фоновый пайплайн (для бенчмарка горячего пути). */
  withoutBackground?: boolean;
}

export function buildSystem(cfg: AppConfig, overrides: BuildSystemOverrides = {}): LunaSystem {
  const logger =
    overrides.logger ?? createLogger({ level: cfg.logging.level, pretty: cfg.logging.pretty });
  const db = Database.open(overrides.dbPath ?? cfg.db.path, {
    info: (msg, meta) => logger.info(meta ?? {}, msg),
    warn: (msg, meta) => logger.warn(meta ?? {}, msg),
  });
  const repos = createRepositories(db);
  const providers: Providers = { ...createProviders(cfg), ...(overrides.providers ?? {}) };

  const bus = new LunaEventBus();
  const telemetry = new Telemetry({
    sink: { record: (e) => repos.telemetry.record(e) },
    log: logger,
    enabled: cfg.logging.telemetryEnabled,
  });

  const relationships = new RelationshipManager(repos.users, repos.relationships, {
    ownerId: cfg.discord.ownerId,
    seedOwnerRelationship: cfg.seedOwnerRelationship,
  });
  const emotions = new EmotionManager(repos.emotions, { decayHalfLifeMin: cfg.emotion.decayHalfLifeMin });
  const memory = new MemoryManager(repos.memories, providers.embeddings, {
    enabled: cfg.memory.enabled,
    dedupeSimilarity: cfg.memory.dedupeSimilarity,
  });
  const retrieval = new MemoryRetrieval(repos.memories, providers.embeddings, {
    mode: cfg.memory.retrievalMode,
    topK: cfg.memory.topK,
    minScore: cfg.memory.minScore,
    recencyHalfLifeDays: cfg.memory.recencyHalfLifeDays,
    weights: cfg.memory.weights,
  });
  const consolidator = new MemoryConsolidator(repos.memories, providers.llm, {
    backgroundModel: cfg.llm.backgroundModel,
    minCluster: cfg.memory.consolidation.minCluster,
    protectImportance: cfg.memory.consolidation.protectImportance,
  });

  const sessions = new SessionStore(cfg.memory.shortTermSize);
  const context = new ContextBuilder({
    relationships,
    emotions,
    retrieval,
    summaries: repos.summaries,
    settings: repos.settings,
    memoryEnabledGlobally: cfg.memory.enabled,
  });
  const prompts = new PromptBuilder({
    corePersonality: LUNA_CORE_PERSONALITY,
    maxMemoryItems: cfg.memory.topK,
    maxMemoryContentLength: 400,
  });

  const tools = new ToolRegistry(logger);

  const manager = new ConversationManager({
    sessions,
    context,
    prompts,
    llm: providers.llm,
    bus,
    telemetry,
    memory,
    stats: repos.stats,
    logger,
    llmModel: cfg.llm.model,
    summaryTriggerMessages: cfg.memory.summaryTriggerMessages,
    tools,
  });

  const pipeline = new BackgroundPipeline({
    bus,
    extractor: new BackgroundExtractor(providers.llm, { backgroundModel: cfg.llm.backgroundModel }),
    summarizer: new ConversationSummarizer(providers.llm, repos.summaries, { backgroundModel: cfg.llm.backgroundModel }),
    memory,
    relationships,
    emotions,
    settings: repos.settings,
    memoryEnabledGlobally: cfg.memory.enabled,
    logger,
  });
  if (!overrides.withoutBackground) pipeline.start();

  const queue = new ResponseQueue({
    debounceMs: cfg.pipeline.debounceMs,
    regenerateWindowMs: cfg.pipeline.regenerateWindowMs,
    process: async (batch, signal) => {
      const merged = mergeBatch(batch);
      await manager.handle(merged.msg, merged.sink, { tracer: merged.tracer, signal });
    },
  });

  // Периодическая консолидация памяти (unref — не держит процесс)
  let consolidationTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.memory.consolidation.enabled && !overrides.withoutBackground) {
    const intervalMs = Math.max(1, cfg.memory.consolidation.intervalHours) * 3600_000;
    consolidationTimer = setInterval(() => {
      const ids = repos.relationships.all().map((r) => r.personId);
      consolidator
        .runAll(ids)
        .then((results) => {
          const mergedCount = results.reduce((s, r) => s + r.memoriesMerged, 0);
          if (mergedCount > 0) logger.info({ merged: mergedCount }, 'memory consolidation done');
        })
        .catch((e) => logger.error({ err: String(e) }, 'consolidation failed'));
    }, intervalMs);
    consolidationTimer.unref();
  }

  const shutdown = async (): Promise<void> => {
    if (consolidationTimer) clearInterval(consolidationTimer);
    pipeline.stop();
    await pipeline.drain().catch(() => {});
    db.close();
  };

  return {
    cfg, logger, db, repos, providers, bus, telemetry,
    relationships, emotions, memory, retrieval, consolidator,
    sessions, context, prompts, manager, tools, pipeline, queue, shutdown,
  };
}
