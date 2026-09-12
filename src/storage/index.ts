export { Database } from './db.js';
export { UsersRepo } from './repositories/users.repo.js';
export { RelationshipsRepo, DEFAULT_RELATIONSHIP } from './repositories/relationships.repo.js';
export { MemoriesRepo, tokenizeForSearch } from './repositories/memories.repo.js';
export { SummariesRepo, EmotionalStatesRepo } from './repositories/summaries.repo.js';
export { SettingsRepo, StatsRepo, TelemetryRepo } from './repositories/misc.repo.js';

import type { Database } from './db.js';
import { UsersRepo } from './repositories/users.repo.js';
import { RelationshipsRepo } from './repositories/relationships.repo.js';
import { MemoriesRepo } from './repositories/memories.repo.js';
import { SummariesRepo, EmotionalStatesRepo } from './repositories/summaries.repo.js';
import { SettingsRepo, StatsRepo, TelemetryRepo } from './repositories/misc.repo.js';

/** Единая точка доступа ко всем репозиториям. */
export interface Repositories {
  db: Database;
  users: UsersRepo;
  relationships: RelationshipsRepo;
  memories: MemoriesRepo;
  summaries: SummariesRepo;
  emotions: EmotionalStatesRepo;
  settings: SettingsRepo;
  stats: StatsRepo;
  telemetry: TelemetryRepo;
}

export function createRepositories(db: Database): Repositories {
  return {
    db,
    users: new UsersRepo(db),
    relationships: new RelationshipsRepo(db),
    memories: new MemoriesRepo(db),
    summaries: new SummariesRepo(db),
    emotions: new EmotionalStatesRepo(db),
    settings: new SettingsRepo(db),
    stats: new StatsRepo(db),
    telemetry: new TelemetryRepo(db),
  };
}
