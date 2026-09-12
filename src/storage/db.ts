import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Тонкая обёртка над node:sqlite:
 * - WAL для конкурентного чтения
 * - файловые миграции (src/storage/migrations/NNN_*.sql)
 * - опциональный FTS5 (если сборка SQLite его поддерживает)
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface DatabaseLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
}

const silentLogger: DatabaseLogger = { info: () => {}, warn: () => {} };

export class Database {
  readonly raw: DatabaseSync;
  ftsAvailable = false;
  private readonly log: DatabaseLogger;

  private constructor(dbPath: string, logger: DatabaseLogger) {
    this.log = logger;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
  }

  static open(dbPath: string, logger: DatabaseLogger = silentLogger): Database {
    const db = new Database(dbPath, logger);
    db.migrate();
    db.setupFts();
    return db;
  }

  /** Применяет все непосчитанные миграции из каталога, по одной за транзакцию. */
  migrate(): void {
    this.raw.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       );`,
    );
    const applied = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((r) => r.version),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const version = Number(file.slice(0, file.indexOf('_')));
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.transaction(() => {
        this.raw.exec(sql);
        this.raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      });
      this.log.info(`migration applied`, { file });
    }
  }

  /** FTS5 — опционально: keyword-поиск памяти ускорен, но есть LIKE-фолбэк. */
  private setupFts(): void {
    try {
      this.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x);`);
      this.raw.exec(`DROP TABLE IF EXISTS _fts_probe;`);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
      this.log.warn('FTS5 недоступен — keyword-поиск пойдёт через LIKE');
      return;
    }
    try {
      this.raw.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
          USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    } catch (e) {
      this.ftsAvailable = false;
      this.log.warn('не удалось создать FTS-индекс memories', { err: String(e) });
    }
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // уже откатились
      }
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

// ---------- Хелперы конвертации значений node:sqlite ----------

export function toSqlValue(v: boolean | number | string | null | undefined): number | string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function blobToFloat32(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export function float32ToBlob(arr: Float32Array | null): Uint8Array | null {
  if (!arr) return null;
  return new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}
