/**
 * Сброс памяти Luna к заводскому состоянию.
 *
 * Что стирается (всё, что Luna «помнит»):
 *   - записи долговременной памяти (таблица memories, FTS чистится триггером);
 *   - краткие содержания каналов (conversation_summaries);
 *   - отношения со всеми людьми (relationships) — владелец при этом снова
 *     получает свой заводской preseed «старый знакомый» (OWNER_SEED);
 *   - текущее эмоциональное состояние — возвращается на EMOTION_BASELINE.
 *
 * Что НЕ трогается: пользователи (users), настройки озвучки/памяти (settings),
 * счётчики статистики (interaction_stats) и телеметрия латентности.
 *
 * Краткосрочная память диалога живёт в процессе бота, поэтому сброс делается
 * при остановленном боте (панель сама останавливает и запускает его снова).
 *
 * Запуск из панели: смотритель вызывает `node dist/luna/factory-reset.js`.
 * Вручную: `node dist/luna/factory-reset.js` (или `npx tsx src/luna/factory-reset.ts`).
 */
import { pathToFileURL } from 'node:url';
import { Database, createRepositories, type Repositories } from '../storage/index.js';
import { EMOTION_BASELINE } from './types.js';
import { RelationshipManager } from './relationships/relationship-manager.js';

export interface FactoryResetOptions {
  /** Владелец — после сброса снова «старый знакомый» (заводское состояние). */
  ownerId?: string;
  seedOwnerRelationship?: boolean;
}

export interface FactoryResetResult {
  memories: number;
  summaries: number;
  relationships: number;
  emotions: 'baseline';
  ownerSeeded: boolean;
}

export function factoryReset(repos: Repositories, opts: FactoryResetOptions = {}): FactoryResetResult {
  const counts = { memories: 0, summaries: 0, relationships: 0 };

  // одной транзакцией: либо сброшено всё, либо ничего
  repos.db.transaction(() => {
    counts.memories = repos.memories.deleteAll();
    counts.summaries = repos.summaries.deleteAll();
    counts.relationships = repos.relationships.deleteAll();
    repos.emotions.save({ ...EMOTION_BASELINE, updatedAt: Date.now() });
  });

  let ownerSeeded = false;
  if (opts.ownerId && opts.seedOwnerRelationship !== false) {
    const relationships = new RelationshipManager(repos.users, repos.relationships, {
      ownerId: opts.ownerId,
      seedOwnerRelationship: opts.seedOwnerRelationship,
    });
    relationships.ensure({ id: opts.ownerId, isOwner: true });
    ownerSeeded = true;
  }

  return { ...counts, emotions: 'baseline', ownerSeeded };
}

/** Маркер строки результата — смотритель ищет его в stdout, отфильтровывая предупреждения Node. */
export const RESULT_MARKER = 'FACTORY_RESET_RESULT=';

async function main(): Promise<void> {
  const { loadConfig } = await import('../config/index.js');
  const cfg = loadConfig();
  const db = Database.open(cfg.db.path);
  try {
    const result = factoryReset(createRepositories(db), {
      ownerId: cfg.discord.ownerId,
      seedOwnerRelationship: cfg.seedOwnerRelationship,
    });
    console.log(`${RESULT_MARKER}${JSON.stringify({ ok: true, dbPath: cfg.db.path, ...result })}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`${RESULT_MARKER}${JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) })}`);
    process.exitCode = 1;
  });
}
