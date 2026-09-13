import type { Database } from '../db.js';
import { blobToFloat32, float32ToBlob } from '../db.js';
import { newId } from '../../utils/ids.js';
import type { MemoryKind, MemoryRecord, MemoryStatus } from '../../luna/types.js';

interface MemRow {
  id: string;
  person_id: string | null;
  channel_id: string | null;
  kind: string;
  content: string;
  objective: string;
  subjective: string | null;
  emotion: string | null;
  emotion_intensity: number;
  importance: number;
  confidence: number;
  embedding: Uint8Array | null;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  source_conversation_id: string | null;
  superseded_by: string | null;
  status: string;
  rowid?: number;
}

function mapRow(r: MemRow): MemoryRecord {
  let subjective = null;
  if (r.subjective) {
    try {
      subjective = JSON.parse(r.subjective);
    } catch {
      subjective = null;
    }
  }
  let objectiveFacts: string[] = [];
  try {
    const parsed = JSON.parse(r.objective);
    if (Array.isArray(parsed)) objectiveFacts = parsed.filter((x) => typeof x === 'string');
  } catch {
    objectiveFacts = [];
  }
  return {
    id: r.id,
    personId: r.person_id,
    channelId: r.channel_id,
    kind: r.kind as MemoryKind,
    content: r.content,
    objectiveFacts,
    subjective,
    emotion: r.emotion,
    emotionIntensity: r.emotion_intensity,
    importance: r.importance,
    confidence: r.confidence,
    embedding: blobToFloat32(r.embedding),
    dedupeKey: r.dedupe_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRecalledAt: r.last_recalled_at,
    recallCount: r.recall_count,
    sourceConversationId: r.source_conversation_id,
    supersededBy: r.superseded_by,
    status: r.status as MemoryStatus,
  };
}

export interface MemoryInsert {
  id?: string;
  personId?: string | null;
  channelId?: string | null;
  kind: MemoryKind;
  content: string;
  objectiveFacts?: string[];
  subjective?: MemoryRecord['subjective'];
  emotion?: string | null;
  emotionIntensity?: number;
  importance?: number;
  confidence?: number;
  embedding?: Float32Array | null;
  dedupeKey?: string | null;
  createdAt?: number;
  sourceConversationId?: string | null;
}

export interface KeywordSearchOptions {
  personIds?: Array<string | null>;
  limit?: number;
}

export class MemoriesRepo {
  constructor(private db: Database) {}

  insert(m: MemoryInsert): MemoryRecord {
    const now = m.createdAt ?? Date.now();
    const rec: MemoryRecord = {
      id: m.id ?? newId('mem'),
      personId: m.personId ?? null,
      channelId: m.channelId ?? null,
      kind: m.kind,
      content: m.content,
      objectiveFacts: m.objectiveFacts ?? [],
      subjective: m.subjective ?? null,
      emotion: m.emotion ?? null,
      emotionIntensity: m.emotionIntensity ?? 0,
      importance: clamp01(m.importance ?? 0.3),
      confidence: clamp01(m.confidence ?? 0.9),
      embedding: m.embedding ?? null,
      dedupeKey: m.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      recallCount: 0,
      sourceConversationId: m.sourceConversationId ?? null,
      supersededBy: null,
      status: 'active',
    };
    this.db.raw
      .prepare(
        `INSERT INTO memories
          (id, person_id, channel_id, kind, content, objective, subjective, emotion, emotion_intensity,
           importance, confidence, embedding, dedupe_key, created_at, updated_at, last_recalled_at,
           recall_count, source_conversation_id, superseded_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id, rec.personId, rec.channelId, rec.kind, rec.content,
        JSON.stringify(rec.objectiveFacts),
        rec.subjective ? JSON.stringify(rec.subjective) : null,
        rec.emotion, rec.emotionIntensity, rec.importance, rec.confidence,
        float32ToBlob(rec.embedding), rec.dedupeKey, rec.createdAt, rec.updatedAt,
        rec.lastRecalledAt, rec.recallCount, rec.sourceConversationId, rec.supersededBy, rec.status,
      );
    return rec;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.raw.prepare('SELECT rowid, * FROM memories WHERE id = ?').get(id) as MemRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Обновление содержимого существующей памяти (dedupe/consolidation). */
  updateContent(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'objectiveFacts' | 'subjective' | 'emotion' | 'emotionIntensity' | 'importance' | 'confidence' | 'dedupeKey' | 'embedding' | 'kind'>>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown) => {
      fields.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.content !== undefined) push('content', patch.content);
    if (patch.objectiveFacts !== undefined) push('objective', JSON.stringify(patch.objectiveFacts));
    if (patch.subjective !== undefined) push('subjective', patch.subjective ? JSON.stringify(patch.subjective) : null);
    if (patch.emotion !== undefined) push('emotion', patch.emotion);
    if (patch.emotionIntensity !== undefined) push('emotion_intensity', patch.emotionIntensity);
    if (patch.importance !== undefined) push('importance', clamp01(patch.importance));
    if (patch.confidence !== undefined) push('confidence', clamp01(patch.confidence));
    if (patch.dedupeKey !== undefined) push('dedupe_key', patch.dedupeKey);
    if (patch.embedding !== undefined) push('embedding', float32ToBlob(patch.embedding));
    if (patch.kind !== undefined) push('kind', patch.kind);
    if (fields.length === 0) return;
    values.push(Date.now(), id);
    this.db.raw.prepare(`UPDATE memories SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(values as []));
  }

  /** Кандидаты для dedupe: активные памяти того же человека с тем же ключом. */
  findDedupeCandidates(personId: string | null, dedupeKey: string): MemoryRecord[] {
    if (!dedupeKey) return [];
    const rows = this.db.raw
      .prepare(
        `SELECT rowid, * FROM memories
         WHERE status = 'active' AND dedupe_key = ? AND (person_id IS ? OR person_id = ?)`,
      )
      .all(dedupeKey, personId, personId) as unknown as MemRow[];
    return rows.map(mapRow);
  }

  /** Все активные памяти (для retrieval: семантика считается в JS). */
  listActive(filter: { personIds?: Array<string | null>; kinds?: MemoryKind[]; limit?: number } = {}): MemoryRecord[] {
    const where: string[] = ["status = 'active'"];
    const params: unknown[] = [];
    if (filter.personIds) {
      const conds = filter.personIds.map((p) => {
        if (p === null) return 'person_id IS NULL';
        params.push(p);
        return 'person_id = ?';
      });
      where.push(`(${conds.join(' OR ')})`);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    let sql = `SELECT rowid, * FROM memories WHERE ${where.join(' AND ')} ORDER BY importance DESC, created_at DESC`;
    if (filter.limit) sql += ` LIMIT ${Math.max(1, Math.floor(filter.limit))}`;
    return (this.db.raw.prepare(sql).all(...(params as [])) as unknown as MemRow[]).map(mapRow);
  }

  forPerson(personId: string): MemoryRecord[] {
    return (
      this.db.raw
        .prepare("SELECT rowid, * FROM memories WHERE person_id = ? AND status = 'active' ORDER BY created_at DESC")
        .all(personId) as unknown as MemRow[]
    ).map(mapRow);
  }

  /** Люди, о которых есть хоть одна запись (включая скрытые/слитые). */
  distinctPersonIds(): string[] {
    const rows = this.db.raw
      .prepare('SELECT DISTINCT person_id FROM memories WHERE person_id IS NOT NULL')
      .all() as Array<{ person_id: string }>;
    return rows.map((r) => r.person_id);
  }

  /** Keyword-поиск: FTS5 если доступен, иначе LIKE. */
  keywordSearch(text: string, opts: KeywordSearchOptions = {}): MemoryRecord[] {
    const tokens = tokenizeForSearch(text);
    if (tokens.length === 0) return [];
    const limit = opts.limit ?? 20;
    const personFilter = opts.personIds
      ? `(${opts.personIds
          .map((p) => (p === null ? 'm.person_id IS NULL' : `m.person_id = '${p.replace(/'/g, "''")}'`))
          .join(' OR ')})`
      : null;

    if (this.db.ftsAvailable) {
      const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      const rows = this.db.raw
        .prepare(
          `SELECT m.rowid, m.* FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.status = 'active'
             ${personFilter ? `AND ${personFilter}` : ''}
           ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as unknown as MemRow[];
      return rows.map(mapRow);
    }

    const like = tokens.map(() => 'm.content LIKE ?').join(' OR ');
    const rows = this.db.raw
      .prepare(
        `SELECT m.rowid, m.* FROM memories m
         WHERE m.status = 'active' AND (${like})
           ${personFilter ? `AND ${personFilter}` : ''}
         ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`,
      )
      .all(...tokens.map((t) => `%${t}%`), limit) as unknown as MemRow[];
    return rows.map(mapRow);
  }

  markRecalled(ids: string[], at = Date.now()): void {
    if (ids.length === 0) return;
    const stmt = this.db.raw.prepare(
      'UPDATE memories SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id = ?',
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id);
    });
  }

  markMerged(ids: string[], supersededBy: string): void {
    const stmt = this.db.raw.prepare("UPDATE memories SET status = 'merged', superseded_by = ?, updated_at = ? WHERE id = ?");
    const now = Date.now();
    this.db.transaction(() => {
      for (const id of ids) stmt.run(supersededBy, now, id);
    });
  }

  setStatus(id: string, status: MemoryStatus): void {
    this.db.raw.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  deleteByPerson(personId: string): number {
    const res = this.db.raw.prepare("DELETE FROM memories WHERE person_id = ?").run(personId);
    return Number(res.changes);
  }

  delete(id: string): boolean {
    const res = this.db.raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  /** Полный сброс памяти: удаляет ВСЕ записи (FTS чистится триггером). Число удалённых. */
  deleteAll(): number {
    const res = this.db.raw.prepare('DELETE FROM memories').run();
    return Number(res.changes);
  }

  /** Активные записи: все (без аргумента), одного человека (строка) или общие (null). */
  countActive(personId?: string | null): number {
    const row =
      personId === null
        ? (this.db.raw.prepare("SELECT COUNT(*) as c FROM memories WHERE status='active' AND person_id IS NULL").get() as { c: number })
        : personId
          ? (this.db.raw.prepare("SELECT COUNT(*) as c FROM memories WHERE status='active' AND person_id = ?").get(personId) as { c: number })
          : (this.db.raw.prepare("SELECT COUNT(*) as c FROM memories WHERE status='active'").get() as { c: number });
    return row.c;
  }

  /** Мелкие активные памяти для консолидации (ниже порога важности). */
  listConsolidatable(personId: string, protectImportance: number): MemoryRecord[] {
    return (
      this.db.raw
        .prepare(
          `SELECT rowid, * FROM memories
           WHERE status = 'active' AND person_id = ? AND importance < ? AND kind != 'consolidated'
           ORDER BY created_at ASC`,
        )
        .all(personId, protectImportance) as unknown as MemRow[]
    ).map(mapRow);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Значимые токены для keyword-поиска (слова от 4 символов, lower). */
export function tokenizeForSearch(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 12);
}
