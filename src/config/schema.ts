import { z } from 'zod';

/**
 * Zod-схема переменных окружения.
 * Все значения — строки (env), преобразование и дефолты здесь.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const lo = v.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(lo)) return true;
      if (['0', 'false', 'no', 'off'].includes(lo)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ожидалось true/false, получено "${v}"` });
      return z.NEVER;
    });

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ожидалось число, получено "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

/** Пустая строка в env = «не задано». */
const optStr = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()) as z.ZodEffects<
    z.ZodOptional<z.ZodString>,
    string | undefined,
    unknown
  >;

export const envSchema = z.object({
  // Discord
  DISCORD_TOKEN: optStr(),
  OWNER_ID: optStr(),
  GUILD_ID: optStr(),

  // Общий ключ DashScope — фолбэк для LLM/TTS/STT/EMBEDDING, если их ключи не заданы
  DASHSCOPE_API_KEY: optStr(),

  // LLM
  LLM_PROVIDER: z.enum(['openai-compatible', 'mock']).default('openai-compatible'),
  LLM_API_KEY: optStr(),
  LLM_BASE_URL: str('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_MODEL: str('qwen-flash'),
  LLM_BACKGROUND_MODEL: str('qwen-plus'),
  LLM_TEMPERATURE: num(0.9),
  LLM_MAX_TOKENS: num(700),
  LLM_TIMEOUT_MS: num(20000),
  LLM_MAX_RETRIES: num(2),

  // Embeddings
  EMBEDDING_API_KEY: optStr(),
  EMBEDDING_BASE_URL: optStr(),
  EMBEDDING_MODEL: str('text-embedding-v4'),
  EMBEDDING_DIMENSIONS: num(1024),
  EMBEDDING_TIMEOUT_MS: num(8000),

  // TTS
  TTS_PROVIDER: z.enum(['dashscope', 'openai', 'mock']).default('dashscope'),
  TTS_API_KEY: optStr(),
  TTS_BASE_URL: str('https://dashscope.aliyuncs.com/api/v1'),
  TTS_MODEL: str('qwen3-tts-flash'),
  TTS_VOICE: str('Cherry'),
  TTS_ENABLED: bool(true),
  TTS_TIMEOUT_MS: num(15000),

  // STT
  STT_PROVIDER: z.enum(['dashscope', 'openai', 'mock']).default('dashscope'),
  STT_API_KEY: optStr(),
  STT_BASE_URL: str('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  STT_MODEL: str('qwen3-asr-flash'),
  STT_LANGUAGE: str('ru'),
  STT_TIMEOUT_MS: num(15000),

  // Voice
  VOICE_ENABLED: bool(true),
  VOICE_BARGE_IN: bool(true),
  VOICE_AUTO_JOIN: bool(false),
  VAD_START_RMS: num(220),
  VAD_END_SILENCE_MS: num(700),
  VAD_MIN_SPEECH_MS: num(250),
  VAD_MAX_UTTERANCE_MS: num(20000),

  // DB
  DATABASE_PATH: str('./data/luna.db'),

  // Memory
  MEMORY_ENABLED: bool(true),
  SHORT_TERM_SIZE: num(24),
  RETRIEVAL_MODE: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  RETRIEVAL_TOP_K: num(8),
  RETRIEVAL_MIN_SCORE: num(0.1),
  MEMORY_W_SEMANTIC: num(1.0),
  MEMORY_W_RECENCY: num(0.5),
  MEMORY_W_IMPORTANCE: num(0.6),
  MEMORY_W_EMOTION: num(0.35),
  MEMORY_W_RECALL: num(0.25),
  MEMORY_W_PERSON_BOOST: num(1.25),
  MEMORY_RECENCY_HALFLIFE_DAYS: num(14),
  DEDUPE_SIMILARITY: num(0.9),
  CONSOLIDATION_ENABLED: bool(true),
  CONSOLIDATION_INTERVAL_HOURS: num(12),
  CONSOLIDATION_MIN_CLUSTER: num(6),
  CONSOLIDATION_PROTECT_IMPORTANCE: num(0.7),
  SUMMARY_TRIGGER_MESSAGES: num(60),

  // Emotion
  EMOTION_DECAY_HALFLIFE_MIN: num(90),

  // Pipeline
  DEBOUNCE_MS: num(600),
  REGENERATE_WINDOW_MS: num(1500),
  MESSAGE_EDIT_INTERVAL_MS: num(900),
  MESSAGE_CHUNK_LIMIT: num(1800),

  // Logging
  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(false),
  TELEMETRY_ENABLED: bool(true),

  // Misc
  SEED_OWNER_RELATIONSHIP: bool(true),
});

export type Env = z.infer<typeof envSchema>;

// ---------- Тип итогового конфига ----------

export interface AppConfig {
  discord: { token?: string; ownerId?: string; guildId?: string };
  llm: {
    provider: 'openai-compatible' | 'mock';
    apiKey?: string;
    baseUrl: string;
    model: string;
    backgroundModel: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    maxRetries: number;
  };
  embeddings: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    dimensions: number;
    timeoutMs: number;
  };
  tts: {
    provider: 'dashscope' | 'openai' | 'mock';
    apiKey?: string;
    baseUrl: string;
    model: string;
    voice: string;
    enabled: boolean;
    timeoutMs: number;
  };
  stt: {
    provider: 'dashscope' | 'openai' | 'mock';
    apiKey?: string;
    baseUrl: string;
    model: string;
    language: string;
    timeoutMs: number;
  };
  voice: {
    enabled: boolean;
    bargeIn: boolean;
    autoJoin: boolean;
    vad: { startRms: number; endSilenceMs: number; minSpeechMs: number; maxUtteranceMs: number };
  };
  db: { path: string };
  memory: {
    enabled: boolean;
    shortTermSize: number;
    retrievalMode: 'hybrid' | 'keyword' | 'semantic';
    topK: number;
    minScore: number;
    weights: {
      semantic: number;
      recency: number;
      importance: number;
      emotion: number;
      recall: number;
      personBoost: number;
    };
    recencyHalfLifeDays: number;
    dedupeSimilarity: number;
    consolidation: {
      enabled: boolean;
      intervalHours: number;
      minCluster: number;
      protectImportance: number;
    };
    summaryTriggerMessages: number;
  };
  emotion: { decayHalfLifeMin: number };
  pipeline: {
    debounceMs: number;
    regenerateWindowMs: number;
    messageEditIntervalMs: number;
    messageChunkLimit: number;
  };
  logging: { level: string; pretty: boolean; telemetryEnabled: boolean };
  seedOwnerRelationship: boolean;
}

/**
 * Собирает AppConfig из валидированного env.
 * Ключи/URL embeddings, tts, stt наследуются от LLM_*, если не заданы явно.
 */
export function buildConfig(env: Env): AppConfig {
  return {
    discord: { token: env.DISCORD_TOKEN, ownerId: env.OWNER_ID, guildId: env.GUILD_ID },
    llm: {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY || env.DASHSCOPE_API_KEY,
      baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
      model: env.LLM_MODEL,
      backgroundModel: env.LLM_BACKGROUND_MODEL,
      temperature: env.LLM_TEMPERATURE,
      maxTokens: env.LLM_MAX_TOKENS,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    },
    embeddings: {
      apiKey: env.EMBEDDING_API_KEY || env.LLM_API_KEY || env.DASHSCOPE_API_KEY,
      baseUrl: (env.EMBEDDING_BASE_URL || env.LLM_BASE_URL).replace(/\/+$/, ''),
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    },
    tts: {
      provider: env.TTS_PROVIDER,
      apiKey: env.TTS_API_KEY || env.LLM_API_KEY || env.DASHSCOPE_API_KEY,
      baseUrl: env.TTS_BASE_URL.replace(/\/+$/, ''),
      model: env.TTS_MODEL,
      voice: env.TTS_VOICE,
      enabled: env.TTS_ENABLED,
      timeoutMs: env.TTS_TIMEOUT_MS,
    },
    stt: {
      provider: env.STT_PROVIDER,
      apiKey: env.STT_API_KEY || env.LLM_API_KEY || env.DASHSCOPE_API_KEY,
      baseUrl: env.STT_BASE_URL.replace(/\/+$/, ''),
      model: env.STT_MODEL,
      language: env.STT_LANGUAGE,
      timeoutMs: env.STT_TIMEOUT_MS,
    },
    voice: {
      enabled: env.VOICE_ENABLED,
      bargeIn: env.VOICE_BARGE_IN,
      autoJoin: env.VOICE_AUTO_JOIN,
      vad: {
        startRms: env.VAD_START_RMS,
        endSilenceMs: env.VAD_END_SILENCE_MS,
        minSpeechMs: env.VAD_MIN_SPEECH_MS,
        maxUtteranceMs: env.VAD_MAX_UTTERANCE_MS,
      },
    },
    db: { path: env.DATABASE_PATH },
    memory: {
      enabled: env.MEMORY_ENABLED,
      shortTermSize: env.SHORT_TERM_SIZE,
      retrievalMode: env.RETRIEVAL_MODE,
      topK: env.RETRIEVAL_TOP_K,
      minScore: env.RETRIEVAL_MIN_SCORE,
      weights: {
        semantic: env.MEMORY_W_SEMANTIC,
        recency: env.MEMORY_W_RECENCY,
        importance: env.MEMORY_W_IMPORTANCE,
        emotion: env.MEMORY_W_EMOTION,
        recall: env.MEMORY_W_RECALL,
        personBoost: env.MEMORY_W_PERSON_BOOST,
      },
      recencyHalfLifeDays: env.MEMORY_RECENCY_HALFLIFE_DAYS,
      dedupeSimilarity: env.DEDUPE_SIMILARITY,
      consolidation: {
        enabled: env.CONSOLIDATION_ENABLED,
        intervalHours: env.CONSOLIDATION_INTERVAL_HOURS,
        minCluster: env.CONSOLIDATION_MIN_CLUSTER,
        protectImportance: env.CONSOLIDATION_PROTECT_IMPORTANCE,
      },
      summaryTriggerMessages: env.SUMMARY_TRIGGER_MESSAGES,
    },
    emotion: { decayHalfLifeMin: env.EMOTION_DECAY_HALFLIFE_MIN },
    pipeline: {
      debounceMs: env.DEBOUNCE_MS,
      regenerateWindowMs: env.REGENERATE_WINDOW_MS,
      messageEditIntervalMs: env.MESSAGE_EDIT_INTERVAL_MS,
      messageChunkLimit: env.MESSAGE_CHUNK_LIMIT,
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
      telemetryEnabled: env.TELEMETRY_ENABLED,
    },
    seedOwnerRelationship: env.SEED_OWNER_RELATIONSHIP,
  };
}

export class ConfigError extends Error {
  constructor(
    public issues: string[],
  ) {
    super(`Некорректная конфигурация:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}
