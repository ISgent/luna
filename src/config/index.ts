import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { type AppConfig, type Env, buildConfig, envSchema, ConfigError } from './schema.js';

export type { AppConfig, Env } from './schema.js';
export { buildConfig, envSchema, ConfigError } from './schema.js';

export interface LoadConfigOptions {
  /** Путь к .env. По умолчанию <cwd>/.env. Можно передать несколько (первый существующий выиграет). */
  envPaths?: string[];
  /** Явный env-объект (для тестов) — если задан, файлы НЕ читаются. */
  env?: Record<string, string | undefined>;
}

/**
 * Загружает и валидирует конфигурацию.
 * При ошибке валидации бросает ConfigError со списком проблем.
 */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  let raw: Record<string, string | undefined>;

  if (opts.env) {
    raw = opts.env;
  } else {
    const candidates = opts.envPaths ?? [
      path.resolve(process.cwd(), '.env'),
      path.resolve(os.homedir(), '.qwen', '.env'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        loadDotenv({ path: p, override: false });
        break;
      }
    }
    raw = process.env as Record<string, string | undefined>;
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(env)'}: ${i.message}`,
    );
    throw new ConfigError(issues);
  }
  return buildConfig(parsed.data as Env);
}

/**
 * Проверка конфига перед запуском бота (не перед тестами/скриптами).
 * Бросает понятную ошибку, если чего-то не хватает для живой работы.
 */
export function assertBotRuntime(cfg: AppConfig): void {
  const missing: string[] = [];
  if (!cfg.discord.token) missing.push('DISCORD_TOKEN');
  if (cfg.llm.provider !== 'mock' && !cfg.llm.apiKey) missing.push('LLM_API_KEY');
  if (missing.length > 0) {
    throw new ConfigError([`для запуска бота не хватает: ${missing.join(', ')} (см. .env.example)`]);
  }
  // OWNER_ID — числовой snowflake, иначе «старый знакомый» молча не сработает
  if (cfg.discord.ownerId && !/^\d{15,25}$/.test(cfg.discord.ownerId)) {
    throw new ConfigError([
      `OWNER_ID="${cfg.discord.ownerId}" не похож на Discord ID (нужен числовой snowflake). ` +
        `Включите режим разработчика в Discord → ПКМ по себе → «Копировать ID пользователя».`,
    ]);
  }
  if (cfg.discord.guildId && !/^\d{15,25}$/.test(cfg.discord.guildId)) {
    throw new ConfigError([`GUILD_ID="${cfg.discord.guildId}" не похож на числовой id сервера`]);
  }
}
