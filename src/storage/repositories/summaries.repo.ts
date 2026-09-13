import type { Database } from '../db.js';
import { newId } from '../../utils/ids.js';
import type { ConversationSummary, EmotionalState } from '../../luna/types.js';
import { EMOTION_BASELINE } from '../../luna/types.js';

interface SummaryRow {
  id: string;
  channel_id: string;
  period_start: number;
  period_end: number;
  summary: string;
  created_at: number;
}

export class SummariesRepo {
  constructor(private db: Database) {}

  insert(s: { channelId: string; periodStart: number; periodEnd: number; summary: string }): ConversationSummary {
    const rec: ConversationSummary = { id: newId('sum'), createdAt: Date.now(), ...s };
    this.db.raw
      .prepare(
        `INSERT INTO conversation_summaries (id, channel_id, period_start, period_end, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.channelId, rec.periodStart, rec.periodEnd, rec.summary, rec.createdAt);
    return rec;
  }

  latest(channelId: string, limit = 2): ConversationSummary[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM conversation_summaries WHERE channel_id = ? ORDER BY period_end DESC LIMIT ?`,
      )
      .all(channelId, limit) as unknown as SummaryRow[];
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }

  countForChannel(channelId: string): number {
    const row = this.db.raw
      .prepare('SELECT COUNT(*) as c FROM conversation_summaries WHERE channel_id = ?')
      .get(channelId) as { c: number };
    return row.c;
  }

  /** Полный сброс: удаляет краткие содержания всех каналов. Число удалённых. */
  deleteAll(): number {
    const res = this.db.raw.prepare('DELETE FROM conversation_summaries').run();
    return Number(res.changes);
  }
}

interface EmotionRow {
  id: string;
  mood: number;
  energy: number;
  playfulness: number;
  irritation: number;
  warmth: number;
  social_energy: number;
  updated_at: number;
}

export class EmotionalStatesRepo {
  constructor(private db: Database) {}

  /** Текущее состояние; если записи нет — базовая линия (не сохраняя). */
  get(id = 'current'): EmotionalState {
    const row = this.db.raw.prepare('SELECT * FROM emotional_states WHERE id = ?').get(id) as EmotionRow | undefined;
    if (!row) return { ...EMOTION_BASELINE, updatedAt: Date.now() };
    return {
      mood: row.mood,
      energy: row.energy,
      playfulness: row.playfulness,
      irritation: row.irritation,
      warmth: row.warmth,
      socialEnergy: row.social_energy,
      updatedAt: row.updated_at,
    };
  }

  save(state: EmotionalState, id = 'current'): void {
    this.db.raw
      .prepare(
        `INSERT INTO emotional_states (id, mood, energy, playfulness, irritation, warmth, social_energy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mood = excluded.mood, energy = excluded.energy, playfulness = excluded.playfulness,
           irritation = excluded.irritation, warmth = excluded.warmth,
           social_energy = excluded.social_energy, updated_at = excluded.updated_at`,
      )
      .run(id, state.mood, state.energy, state.playfulness, state.irritation, state.warmth, state.socialEnergy, state.updatedAt);
  }
}
