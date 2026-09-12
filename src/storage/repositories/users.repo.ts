import type { Database } from '../db.js';
import { toSqlValue } from '../db.js';
import type { UserRecord } from '../../luna/types.js';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  is_owner: number;
  first_seen_at: number;
  last_seen_at: number;
}

const map = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  isOwner: r.is_owner === 1,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
});

export class UsersRepo {
  constructor(private db: Database) {}

  upsert(user: { id: string; username?: string; displayName?: string; isOwner?: boolean }): UserRecord {
    const now = Date.now();
    const existing = this.get(user.id);
    if (existing) {
      this.db.raw
        .prepare(
          `UPDATE users SET username = COALESCE(?, username), display_name = COALESCE(?, display_name),
           is_owner = MAX(is_owner, ?), last_seen_at = ? WHERE id = ?`,
        )
        .run(user.username ?? null, user.displayName ?? null, toSqlValue(user.isOwner ?? false), now, user.id);
    } else {
      this.db.raw
        .prepare(
          `INSERT INTO users (id, username, display_name, is_owner, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(user.id, user.username ?? '', user.displayName ?? '', toSqlValue(user.isOwner ?? false), now, now);
    }
    return this.get(user.id)!;
  }

  get(id: string): UserRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? map(row) : null;
  }

  touch(id: string): void {
    this.db.raw.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  all(): UserRecord[] {
    return (this.db.raw.prepare('SELECT * FROM users ORDER BY last_seen_at DESC').all() as unknown as UserRow[]).map(map);
  }
}
