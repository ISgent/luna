import type { Database } from '../db.js';
import type { TelemetryEntry } from '../../logging/telemetry.js';

export class SettingsRepo {
  constructor(private db: Database) {}

  get(scope: string, key: string): string | null {
    const row = this.db.raw.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(scope, key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(scope: string, key: string, value: string): void {
    this.db.raw
      .prepare(
        `INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(scope, key, value, Date.now());
  }

  getBool(scope: string, key: string, def: boolean): boolean {
    const v = this.get(scope, key);
    if (v === null) return def;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  }

  remove(scope: string, key: string): void {
    this.db.raw.prepare('DELETE FROM settings WHERE scope = ? AND key = ?').run(scope, key);
  }

  listScope(scope: string): Array<{ key: string; value: string }> {
    return this.db.raw.prepare('SELECT key, value FROM settings WHERE scope = ?').all(scope) as Array<{
      key: string;
      value: string;
    }>;
  }
}

export class StatsRepo {
  constructor(private db: Database) {}

  private day(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  incrementMessagesIn(personId: string): void {
    this.bump(personId, 'messages_in');
  }

  incrementMessagesOut(personId: string): void {
    this.bump(personId, 'messages_out');
  }

  addVoiceSeconds(personId: string, seconds: number): void {
    this.db.raw
      .prepare(
        `INSERT INTO interaction_stats (person_id, day, voice_seconds) VALUES (?, ?, ?)
         ON CONFLICT(person_id, day) DO UPDATE SET voice_seconds = voice_seconds + excluded.voice_seconds`,
      )
      .run(personId, this.day(), Math.round(seconds));
  }

  private bump(personId: string, col: 'messages_in' | 'messages_out'): void {
    this.db.raw
      .prepare(
        `INSERT INTO interaction_stats (person_id, day, ${col}) VALUES (?, ?, 1)
         ON CONFLICT(person_id, day) DO UPDATE SET ${col} = ${col} + 1`,
      )
      .run(personId, this.day());
  }

  totals(personId: string): { messagesIn: number; messagesOut: number; voiceSeconds: number; days: number } {
    const row = this.db.raw
      .prepare(
        `SELECT COALESCE(SUM(messages_in),0) AS mi, COALESCE(SUM(messages_out),0) AS mo,
                COALESCE(SUM(voice_seconds),0) AS vs, COUNT(*) AS d
         FROM interaction_stats WHERE person_id = ?`,
      )
      .get(personId) as { mi: number; mo: number; vs: number; d: number };
    return { messagesIn: row.mi, messagesOut: row.mo, voiceSeconds: row.vs, days: row.d };
  }
}

export class TelemetryRepo {
  constructor(private db: Database) {}

  record(entry: TelemetryEntry): void {
    this.db.raw
      .prepare(
        `INSERT OR REPLACE INTO telemetry (request_id, kind, user_id, channel_id, provider, model, spans, metrics, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.requestId,
        entry.kind,
        entry.userId ?? null,
        entry.channelId ?? null,
        entry.provider ?? null,
        entry.model ?? null,
        JSON.stringify(entry.spans),
        JSON.stringify(entry.metrics),
        entry.error ?? null,
        entry.createdAt,
      );
  }

  recent(limit = 20): TelemetryEntry[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM telemetry ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      request_id: string;
      kind: 'text' | 'voice';
      user_id: string | null;
      channel_id: string | null;
      provider: string | null;
      model: string | null;
      spans: string;
      metrics: string;
      error: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      requestId: r.request_id,
      kind: r.kind,
      userId: r.user_id ?? undefined,
      channelId: r.channel_id ?? undefined,
      provider: r.provider ?? undefined,
      model: r.model ?? undefined,
      spans: JSON.parse(r.spans),
      metrics: JSON.parse(r.metrics),
      error: r.error ?? undefined,
      createdAt: r.created_at,
    }));
  }

  clearOlderThan(days: number): void {
    this.db.raw.prepare('DELETE FROM telemetry WHERE created_at < ?').run(Date.now() - days * 86400_000);
  }
}
