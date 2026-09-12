import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, createRepositories, type Repositories } from '../../src/storage/index.js';

let db: Database;
let repos: Repositories;

beforeEach(() => {
  db = Database.open(':memory:');
  repos = createRepositories(db);
});

afterEach(() => {
  db.close();
});

describe('Database', () => {
  it('миграции создают таблицы', () => {
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const t of [
      'users', 'relationships', 'memories', 'conversation_summaries',
      'emotional_states', 'settings', 'interaction_stats', 'telemetry', 'schema_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('повторное открытие не падает (идемпотентность)', () => {
    expect(() => db.migrate()).not.toThrow();
  });

  it('transaction откатывается при ошибке', () => {
    expect(() =>
      db.transaction(() => {
        repos.settings.set('global', 'x', '1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repos.settings.get('global', 'x')).toBeNull();
  });
});

describe('UsersRepo', () => {
  it('upsert создаёт и обновляет, first_seen сохраняется', () => {
    const u1 = repos.users.upsert({ id: 'u1', username: 'gent', displayName: 'Gent' });
    expect(u1.firstSeenAt).toBeGreaterThan(0);
    const before = u1.firstSeenAt;
    const u2 = repos.users.upsert({ id: 'u1', username: 'gent', displayName: 'GentNew' });
    expect(u2.displayName).toBe('GentNew');
    expect(u2.firstSeenAt).toBe(before);
  });

  it('is_owner залипает (не сбрасывается false)', () => {
    repos.users.upsert({ id: 'u1', isOwner: true });
    const u = repos.users.upsert({ id: 'u1', isOwner: false });
    expect(u.isOwner).toBe(true);
  });
});

describe('RelationshipsRepo', () => {
  it('getOrDefault не пишет в базу', () => {
    const r = repos.relationships.getOrDefault('p1');
    expect(r.trust).toBeCloseTo(0.3);
    expect(repos.relationships.get('p1')).toBeNull();
  });

  it('upsert → get round-trip', () => {
    repos.users.upsert({ id: 'p1', username: 'p1' });
    repos.relationships.upsert({
      personId: 'p1', familiarity: 0.5, trust: 0.6, closeness: 0.4, respect: 0.7,
      affection: 0.3, sharedXp: 3, interactions: 42, summary: 'давно знакомы', updatedAt: 123,
    });
    const r = repos.relationships.get('p1')!;
    expect(r.trust).toBeCloseTo(0.6);
    expect(r.sharedXp).toBe(3);
    expect(r.summary).toBe('давно знакомы');
  });
});

describe('MemoriesRepo', () => {
  it('insert → get round-trip со всеми полями', () => {
    const emb = new Float32Array([0.1, -0.2, 0.3]);
    const rec = repos.memories.insert({
      kind: 'event',
      personId: 'p1',
      channelId: 'c1',
      content: 'Вася помог Luna разобраться с настройкой сервера',
      objectiveFacts: ['Вася помог с настройкой сервера'],
      subjective: { opinion: 'полезный и терпеливый', emotion: 'благодарность', intensity: 0.7 },
      emotion: 'благодарность',
      emotionIntensity: 0.7,
      importance: 0.8,
      confidence: 0.95,
      embedding: emb,
      dedupeKey: 'help:server',
      sourceConversationId: 'conv1',
    });
    const got = repos.memories.get(rec.id)!;
    expect(got.content).toContain('Вася помог');
    expect(got.objectiveFacts).toEqual(['Вася помог с настройкой сервера']);
    expect(got.subjective?.opinion).toBe('полезный и терпеливый');
    expect(got.emotion).toBe('благодарность');
    expect(got.importance).toBeCloseTo(0.8);
    expect(Array.from(got.embedding!)).toEqual(Array.from(emb));
    expect(got.status).toBe('active');
    expect(got.recallCount).toBe(0);
  });

  it('clamp важности/уверенности в 0..1', () => {
    const rec = repos.memories.insert({ kind: 'fact', content: 'x', importance: 5, confidence: -2 });
    const got = repos.memories.get(rec.id)!;
    expect(got.importance).toBe(1);
    expect(got.confidence).toBe(0);
  });

  it('updateContent обновляет поля и updated_at', () => {
    const rec = repos.memories.insert({ kind: 'preference', content: 'любит X', personId: 'p1' });
    repos.memories.updateContent(rec.id, { content: 'любит X и Y', importance: 0.9 });
    const got = repos.memories.get(rec.id)!;
    expect(got.content).toBe('любит X и Y');
    expect(got.importance).toBeCloseTo(0.9);
    expect(got.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt);
  });

  it('dedupe-кандидаты ищутся по person+key', () => {
    repos.memories.insert({ kind: 'preference', content: 'любит аниме', personId: 'p1', dedupeKey: 'pref:anime' });
    repos.memories.insert({ kind: 'preference', content: 'любит аниме', personId: 'p2', dedupeKey: 'pref:anime' });
    repos.memories.insert({ kind: 'fact', content: 'Luna любит новеллы', personId: null, dedupeKey: 'pref:vn' });
    expect(repos.memories.findDedupeCandidates('p1', 'pref:anime')).toHaveLength(1);
    expect(repos.memories.findDedupeCandidates('p2', 'pref:anime')).toHaveLength(1);
    expect(repos.memories.findDedupeCandidates(null, 'pref:vn')).toHaveLength(1);
    expect(repos.memories.findDedupeCandidates('p1', 'pref:vn')).toHaveLength(0);
  });

  it('listActive фильтрует по людям (включая null)', () => {
    repos.memories.insert({ kind: 'fact', content: 'a', personId: 'p1' });
    repos.memories.insert({ kind: 'fact', content: 'b', personId: 'p2' });
    repos.memories.insert({ kind: 'fact', content: 'c', personId: null });
    expect(repos.memories.listActive({ personIds: ['p1', null] }).map((m) => m.content).sort()).toEqual(['a', 'c']);
  });

  it('keywordSearch находит по словам (FTS или LIKE)', () => {
    repos.memories.insert({ kind: 'event', content: 'Обсуждали прохождение Сталкер Зов Припяти', personId: 'p1' });
    repos.memories.insert({ kind: 'preference', content: 'Любит кофе', personId: 'p1' });
    const found = repos.memories.keywordSearch('сталкер прохождение');
    expect(found).toHaveLength(1);
    expect(found[0]!.content).toContain('Сталкер');
    // фильтр по человеку
    expect(repos.memories.keywordSearch('сталкер', { personIds: ['p2'] })).toHaveLength(0);
  });

  it('markRecalled увеличивает счётчик', () => {
    const rec = repos.memories.insert({ kind: 'fact', content: 'x' });
    repos.memories.markRecalled([rec.id]);
    repos.memories.markRecalled([rec.id]);
    const got = repos.memories.get(rec.id)!;
    expect(got.recallCount).toBe(2);
    expect(got.lastRecalledAt).not.toBeNull();
  });

  it('markMerged/status/delete', () => {
    const a = repos.memories.insert({ kind: 'fact', content: 'a', personId: 'p1' });
    const b = repos.memories.insert({ kind: 'fact', content: 'b', personId: 'p1' });
    const merged = repos.memories.insert({ kind: 'consolidated', content: 'a+b', personId: 'p1' });
    repos.memories.markMerged([a.id, b.id], merged.id);
    expect(repos.memories.get(a.id)!.status).toBe('merged');
    expect(repos.memories.get(a.id)!.supersededBy).toBe(merged.id);
    expect(repos.memories.countActive('p1')).toBe(1);
    // deleteByPerson удаляет ВСЕ записи человека, включая merged (privacy: стереть всё)
    expect(repos.memories.deleteByPerson('p1')).toBe(3);
    expect(repos.memories.countActive('p1')).toBe(0);
    // merged-записи не трогаются listActive
    expect(repos.memories.listActive({ personIds: ['p1'] })).toHaveLength(0);
  });

  it('listConsolidatable защищает важные памяти', () => {
    repos.memories.insert({ kind: 'fact', content: 'мелочь', personId: 'p1', importance: 0.2 });
    repos.memories.insert({ kind: 'event', content: 'важное событие', personId: 'p1', importance: 0.9 });
    const list = repos.memories.listConsolidatable('p1', 0.7);
    expect(list.map((m) => m.content)).toEqual(['мелочь']);
  });
});

describe('SummariesRepo', () => {
  it('insert → latest по каналу, свежие первыми', () => {
    repos.summaries.insert({ channelId: 'c1', periodStart: 1, periodEnd: 100, summary: 'старое' });
    repos.summaries.insert({ channelId: 'c1', periodStart: 101, periodEnd: 200, summary: 'новое' });
    repos.summaries.insert({ channelId: 'c2', periodStart: 1, periodEnd: 50, summary: 'другой канал' });
    const latest = repos.summaries.latest('c1', 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.summary).toBe('новое');
    expect(repos.summaries.countForChannel('c1')).toBe(2);
  });
});

describe('EmotionalStatesRepo', () => {
  it('по умолчанию — базовая линия', () => {
    const s = repos.emotions.get();
    expect(s.mood).toBeCloseTo(0.2);
    expect(s.irritation).toBe(0);
  });

  it('save → get round-trip', () => {
    repos.emotions.save({
      mood: -0.4, energy: 0.3, playfulness: 0.2, irritation: 0.6,
      warmth: 0.4, socialEnergy: 0.2, updatedAt: 999,
    });
    const s = repos.emotions.get();
    expect(s.mood).toBeCloseTo(-0.4);
    expect(s.irritation).toBeCloseTo(0.6);
    expect(s.updatedAt).toBe(999);
  });
});

describe('SettingsRepo', () => {
  it('set/get/getBool/remove', () => {
    repos.settings.set('user:p1', 'tts_enabled', 'false');
    expect(repos.settings.get('user:p1', 'tts_enabled')).toBe('false');
    expect(repos.settings.getBool('user:p1', 'tts_enabled', true)).toBe(false);
    expect(repos.settings.getBool('user:p1', 'memory_enabled', true)).toBe(true);
    repos.settings.remove('user:p1', 'tts_enabled');
    expect(repos.settings.get('user:p1', 'tts_enabled')).toBeNull();
  });
});

describe('StatsRepo', () => {
  it('считает сообщения и голосовые секунды', () => {
    repos.stats.incrementMessagesIn('p1');
    repos.stats.incrementMessagesIn('p1');
    repos.stats.incrementMessagesOut('p1');
    repos.stats.addVoiceSeconds('p1', 30.4);
    const t = repos.stats.totals('p1');
    expect(t.messagesIn).toBe(2);
    expect(t.messagesOut).toBe(1);
    expect(t.voiceSeconds).toBe(30);
    expect(t.days).toBe(1);
  });
});

describe('TelemetryRepo', () => {
  it('record → recent round-trip', () => {
    repos.telemetry.record({
      requestId: 'req1', kind: 'text', userId: 'u1', channelId: 'c1',
      provider: 'dashscope', model: 'qwen-flash',
      spans: { message_received: 1, first_token: 500 },
      metrics: { ttftMs: 499 },
      createdAt: Date.now(),
    });
    const rows = repos.telemetry.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metrics.ttftMs).toBe(499);
    expect(rows[0]!.model).toBe('qwen-flash');
  });

  it('clearOlderThan удаляет старое', () => {
    repos.telemetry.record({
      requestId: 'old', kind: 'text', spans: {}, metrics: {}, createdAt: Date.now() - 40 * 86400_000,
    });
    repos.telemetry.clearOlderThan(30);
    expect(repos.telemetry.recent(10)).toHaveLength(0);
  });
});
