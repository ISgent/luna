import type { AppConfig } from '../config/index.js';
import type { EmbeddingProvider, LLMProvider, STTProvider, TTSProvider } from './types.js';
import { OpenAICompatibleLLM } from './llm/openai-compatible.js';
import { DashScopeTTS } from './tts/dashscope.js';
import { OpenAITTS } from './tts/openai.js';
import { DashScopeSTT } from './stt/dashscope.js';
import { OpenAISTT } from './stt/openai.js';
import { OpenAIEmbeddings } from './embeddings/openai-compatible.js';
import { MockEmbeddingProvider, MockLLMProvider, MockSTTProvider, MockTTSProvider } from './mock.js';

export interface Providers {
  llm: LLMProvider;
  tts: TTSProvider;
  stt: STTProvider;
  embeddings: EmbeddingProvider;
}

/**
 * Сборка провайдеров из конфигурации — единственное место,
 * где конкретные реализации привязаны к config.
 * Остальная система знает только интерфейсы (LLMProvider и т.д.).
 */
export function createProviders(cfg: AppConfig): Providers {
  const llm: LLMProvider =
    cfg.llm.provider === 'mock'
      ? new MockLLMProvider({ reply: 'mock-ответ Luna' })
      : new OpenAICompatibleLLM({
          name: 'main-llm',
          baseUrl: cfg.llm.baseUrl,
          apiKey: cfg.llm.apiKey,
          model: cfg.llm.model,
          temperature: cfg.llm.temperature,
          maxTokens: cfg.llm.maxTokens,
          timeoutMs: cfg.llm.timeoutMs,
          maxRetries: cfg.llm.maxRetries,
        });

  const tts: TTSProvider = !cfg.tts.enabled
    ? new MockTTSProvider()
    : cfg.tts.provider === 'mock'
      ? new MockTTSProvider()
      : cfg.tts.provider === 'dashscope'
        ? new DashScopeTTS({
            baseUrl: cfg.tts.baseUrl,
            apiKey: cfg.tts.apiKey,
            model: cfg.tts.model,
            voice: cfg.tts.voice,
            timeoutMs: cfg.tts.timeoutMs,
          })
        : new OpenAITTS({
            baseUrl: cfg.tts.baseUrl,
            apiKey: cfg.tts.apiKey,
            model: cfg.tts.model,
            voice: cfg.tts.voice,
            timeoutMs: cfg.tts.timeoutMs,
          });

  const stt: STTProvider =
    cfg.stt.provider === 'mock'
      ? new MockSTTProvider()
      : cfg.stt.provider === 'dashscope'
        ? new DashScopeSTT({
            baseUrl: cfg.stt.baseUrl,
            apiKey: cfg.stt.apiKey,
            model: cfg.stt.model,
            language: cfg.stt.language,
            timeoutMs: cfg.stt.timeoutMs,
          })
        : new OpenAISTT({
            baseUrl: cfg.stt.baseUrl,
            apiKey: cfg.stt.apiKey,
            model: cfg.stt.model,
            language: cfg.stt.language,
            timeoutMs: cfg.stt.timeoutMs,
          });

  const embeddings: EmbeddingProvider =
    cfg.llm.provider === 'mock' || !cfg.embeddings.apiKey
      ? new MockEmbeddingProvider(cfg.embeddings.dimensions)
      : new OpenAIEmbeddings({
          baseUrl: cfg.embeddings.baseUrl,
          apiKey: cfg.embeddings.apiKey,
          model: cfg.embeddings.model,
          dimensions: cfg.embeddings.dimensions,
          timeoutMs: cfg.embeddings.timeoutMs,
        });

  return { llm, tts, stt, embeddings };
}
