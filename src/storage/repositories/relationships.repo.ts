import type { Database } from '../db.js';
import type { RelationshipState } from '../../luna/types.js';

interface RelRow {
  person_id: string;
  familiarity: number;
  trust: number;
  closeness: number;
  respect: number;
  affection: number;
  shared_xp: number;
  interactions: number;
  summary: string;
  updated_at: number;
}

const map = (r: RelRow): RelationshipState => ({
  personId: r.person_id,
  familiarity: r.familiarity,
  trust: r.trust,
  closeness: r.closeness,
  respect: r.respect,
  affection: r.affection,
  sharedXp: r.shared_xp,
  interactions: r.interactions,
  summary: r.summary,
  updatedAt: r.updated_at,
});

export const DEFAULT_RELATIONSHIP: Omit<RelationshipState, 'personId' | 'updatedAt'> = {
  familiarity: 0.05,
  trust: 0.3,
  closeness: 0.05,
  respect: 0.3,
  affection: 0.1,
  sharedXp: 0,
  interactions: 0,
  summary: '',
};

export class RelationshipsRepo {
  constructor(private db: Database) {}

  get(personId: string): RelationshipState | null {
    const row = this.db.raw.prepare('SELECT * FROM relationships WHERE person_id = ?').get(personId) as
      | RelRow
      | undefined;
    return row ? map(row) : null;
  }

  /** Существующая запись или дефолтная (не сохраняя её). */
  getOrDefault(personId: string): RelationshipState {
    return (
      this.get(personId) ?? { ...DEFAULT_RELATIONSHIP, personId, updatedAt: Date.now() }
    );
  }

  upsert(state: RelationshipState): void {
    this.db.raw
      .prepare(
        `INSERT INTO relationships
           (person_id, familiarity, trust, closeness, respect, affection, shared_xp, interactions, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(person_id) DO UPDATE SET
           familiarity = excluded.familiarity,
           trust = excluded.trust,
           closeness = excluded.closeness,
           respect = excluded.respect,
           affection = excluded.affection,
           shared_xp = excluded.shared_xp,
           interactions = excluded.interactions,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.personId,
        state.familiarity,
        state.trust,
        state.closeness,
        state.respect,
        state.affection,
        state.sharedXp,
        state.interactions,
        state.summary,
        state.updatedAt,
      );
  }

  all(): RelationshipState[] {
    return (this.db.raw.prepare('SELECT * FROM relationships').all() as unknown as RelRow[]).map(map);
  }

  remove(personId: string): void {
    this.db.raw.prepare('DELETE FROM relationships WHERE person_id = ?').run(personId);
  }
}
