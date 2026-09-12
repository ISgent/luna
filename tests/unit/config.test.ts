import { describe, it, expect } from 'vitest';
import { loadConfig, assertBotRuntime, ConfigError } from '../../src/config/index.js';

const minimalEnv = {
  DISCORD_TOKEN: 'tok',
  LLM_API_KEY: 'key',
  OWNER_ID: '1442911842119979302',
};

describe('loadConfig', () => {
  it('применяет дефолты', () => {
    const cfg = loadConfig({ env: minimalEnv });
    expect(cfg.llm.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(cfg.llm.model).toBe('qwen-flash');
    expect(cfg.llm.backgroundModel).toBe('qwen-plus');
    expect(cfg.memory.retrievalMode).toBe('hybrid');
    expect(cfg.tts.voice).toBe('Cherry');
    expect(cfg.tts.enabled).toBe(true);
    expect(cfg.pipeline.debounceMs).toBe(600);
  });

  it('наследует ключи и URL от LLM_*', () => {
    const cfg = loadConfig({ env: { ...minimalEnv, LLM_BASE_URL: 'https://example.com/v1/' } });
    expect(cfg.embeddings.apiKey).toBe('key');
    expect(cfg.embeddings.baseUrl).toBe('https://example.com/v1');
    expect(cfg.stt.apiKey).toBe('key');
    expect(cfg.tts.apiKey).toBe('key');
  });

  it('явные значения переопределяют наследование', () => {
    const cfg = loadConfig({
      env: { ...minimalEnv, STT_API_KEY: 'stt-key', EMBEDDING_BASE_URL: 'https://emb.example/v1' },
    });
    expect(cfg.stt.apiKey).toBe('stt-key');
    expect(cfg.embeddings.baseUrl).toBe('https://emb.example/v1');
  });

  it('парсит bool/number из строк', () => {
    const cfg = loadConfig({
      env: { ...minimalEnv, TTS_ENABLED: 'false', DEBOUNCE_MS: '0', LOG_PRETTY: '1' },
    });
    expect(cfg.tts.enabled).toBe(false);
    expect(cfg.pipeline.debounceMs).toBe(0);
    expect(cfg.logging.pretty).toBe(true);
  });

  it('бросает ConfigError на мусоре', () => {
    expect(() => loadConfig({ env: { ...minimalEnv, TTS_ENABLED: 'абырвалг' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { ...minimalEnv, DEBOUNCE_MS: 'много' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { ...minimalEnv, RETRIEVAL_MODE: 'telepathy' } })).toThrow(ConfigError);
  });

  it('пустые строки = не задано (дефолт)', () => {
    const cfg = loadConfig({ env: { ...minimalEnv, OWNER_ID: '', LLM_TEMPERATURE: '' } });
    expect(cfg.discord.ownerId).toBeUndefined();
    expect(cfg.llm.temperature).toBe(0.9);
  });
});

describe('assertBotRuntime', () => {
  it('требует токен и ключ LLM', () => {
    const cfg = loadConfig({ env: {} });
    expect(() => assertBotRuntime(cfg)).toThrow(/DISCORD_TOKEN/);
    expect(() => assertBotRuntime(cfg)).toThrow(/LLM_API_KEY/);
  });

  it('с токеном и ключом проходит', () => {
    const cfg = loadConfig({ env: minimalEnv });
    expect(() => assertBotRuntime(cfg)).not.toThrow();
  });

  it('mock-провайдеру ключ не нужен', () => {
    const cfg = loadConfig({ env: { DISCORD_TOKEN: 'tok', LLM_PROVIDER: 'mock' } });
    expect(() => assertBotRuntime(cfg)).not.toThrow();
  });

  it('нечисловой OWNER_ID — внятная ошибка (snowflake обязателен)', () => {
    const cfg = loadConfig({ env: { ...minimalEnv, OWNER_ID: 'gentisded' } });
    expect(() => assertBotRuntime(cfg)).toThrow(/OWNER_ID/);
    expect(() => assertBotRuntime(cfg)).toThrow(/snowflake/);
  });

  it('числовой OWNER_ID проходит', () => {
    const cfg = loadConfig({ env: { ...minimalEnv, OWNER_ID: '1442911842119979302' } });
    expect(() => assertBotRuntime(cfg)).not.toThrow();
  });
});
