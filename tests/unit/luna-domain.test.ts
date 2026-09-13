import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, createRepositories, type Repositories } from '../../src/storage/index.js';
import { EmotionManager, MAX_DELTA_PER_EVENT } from '../../src/luna/emotion/emotion-manager.js';
import {
  RelationshipManager,
  MAX_REL_DELTA_PER_EVENT,
  OWNER_SEED,
} from '../../src/luna/relationships/relationship-manager.js';
import { MemoryManager } from '../../src/luna/memory/memory-manager.js';
import { MemoryRetrieval } from '../../src/luna/memory/retrieval.js';
import { MemoryConsolidator } from '../../src/luna/memory/consolidator.js';
import { factoryReset } from '../../src/luna/factory-reset.js';
import { MockEmbeddingProvider, MockLLMProvider } from '../../src/ai/mock.js';
import { EMOTION_BASELINE } from '../../src/luna/types.js';

let db: Database;
let repos: Repositories;

beforeEach(() => {
  db = Database.open(':memory:');
  repos = createRepositories(db);
});
afterEach(() => db.close());

describe('EmotionManager', () => {
  it('по умолчанию — базовая линия', () => {
    let t = 1000;
    const em = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90, now: () => t });
    const s = em.current();
    expect(s.mood).toBeCloseTo(EMOTION_BASELINE.mood);
    expect(s.playfulness).toBeCloseTo(EMOTION_BASELINE.playfulness);
  });

  it('дельты применяются и ограничиваются за событие', () => {
    let t = 1000;
    const em = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90, now: () => t });
    const s = em.applyDeltas({ mood: 5, irritation: -5 });
    expect(s.mood).toBeLessThanOrEqual(EMOTION_BASELINE.mood + MAX_DELTA_PER_EVENT + 1e-9);
    expect(s.irritation).toBe(0);
  });

  it('decay: через период полураспада отклонение уменьшается вдвое', () => {
    let t = 0;
    const em = new EmotionManager(repos.emotions, { decayHalfLifeMin: 60, now: () => t });
    em.applyDeltas({ mood: 0.2 }, 0); // mood: 0.2 → 0.4 (дельта в пределах лимита)
    t = 60 * 60_000;
    const s = em.current();
    expect(s.mood).toBeCloseTo(0.3, 5); // половина отклонения (0.4 → 0.3)
  });

  it('decay ленивый: состояние читается из БД, а не из таймеров', () => {
    let t = 0;
    const em1 = new EmotionManager(repos.emotions, { decayHalfLifeMin: 60, now: () => t });
    em1.applyDeltas({ mood: 0.2 }, 0); // mood 0.4, updatedAt 0
    t = 120 * 60_000; // два полураспада
    const em2 = new EmotionManager(repos.emotions, { decayHalfLifeMin: 60, now: () => t });
    expect(em2.current().mood).toBeCloseTo(0.25, 5); // 0.2 + 0.2*0.25
  });

  it('describe даёт естественный текст, а не числа', () => {
    const em = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90 });
    // одно событие не может сильно сдвинуть состояние — копим три
    em.applyDeltas({ mood: 0.2, irritation: 0.2 });
    em.applyDeltas({ mood: 0.2, irritation: 0.2 });
    const s = em.applyDeltas({ mood: 0.2, irritation: 0.2 });
    const text = em.describe(s);
    expect(text).toContain('Luna');
    expect(text).not.toMatch(/\d\.\d/);
    expect(text).toMatch(/раздражена/);
  });

  it('состояние переживает перезапуск (персистентность)', () => {
    const em1 = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90, now: () => 1000 });
    em1.applyDeltas({ mood: 0.5 });
    const em2 = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90, now: () => 1000 });
    expect(em2.current().mood).toBeCloseTo(em1.current().mood);
  });
});

describe('RelationshipManager', () => {
  const mk = (ownerId?: string) => new RelationshipManager(repos.users, repos.relationships, { ownerId });

  it('новый человек — дефолтные отношения, описание осторожное', () => {
    const rm = mk();
    const rel = rm.ensure({ id: 'new1', username: 'someone' });
    expect(rel.interactions).toBe(0);
    expect(rel.trust).toBeCloseTo(0.3);
    const desc = rm.describeForPrompt(rel);
    expect(desc).toMatch(/почти не знает/);
    expect(desc).not.toMatch(/давно знает/);
  });

  it('владелец — preseed «давно знакомы»', () => {
    const rm = mk('owner1');
    const rel = rm.ensure({ id: 'owner1', username: 'gent' });
    expect(rel.familiarity).toBeCloseTo(OWNER_SEED.familiarity);
    expect(rel.interactions).toBe(OWNER_SEED.interactions);
    const desc = rm.describeForPrompt(rel);
    expect(desc).toMatch(/давно знает/);
    expect(desc).toMatch(/доверяет/);
    expect(desc).toContain(OWNER_SEED.summary.slice(0, 30));
  });

  it('seedOwnerRelationship=false — владелец как обычный новый', () => {
    const rm = new RelationshipManager(repos.users, repos.relationships, {
      ownerId: 'owner1',
      seedOwnerRelationship: false,
    });
    const rel = rm.ensure({ id: 'owner1' });
    expect(rel.interactions).toBe(0);
  });

  it('число совместных событий в описании склоняется по-русски', () => {
    const rm = mk();
    const rel = rm.ensure({ id: 'p1' });
    const word = (n: number) => {
      rel.sharedXp = n;
      return rm.describeForPrompt(rel).match(/за плечами \d+ значимых совместных (\S+)\./)?.[1];
    };
    expect(word(1)).toBe('событие');
    expect(word(2)).toBe('события');
    expect(word(4)).toBe('события');
    expect(word(5)).toBe('событий');
    expect(word(11)).toBe('событий');
    expect(word(21)).toBe('событие');
    expect(word(22)).toBe('события');
  });

  it('дельты плавные: логистика + лимит за событие', () => {
    const rm = mk();
    rm.ensure({ id: 'p1' });
    let rel = rm.applyDeltas('p1', { trust: 99 });
    // дельта ограничена MAX и умножена на (1-cur)
    expect(rel.trust).toBeLessThan(0.3 + MAX_REL_DELTA_PER_EVENT + 1e-9);
    expect(rel.trust).toBeGreaterThan(0.3);
    // 20 «хороших разговоров» подряд не дают 1.0 мгновенно, но растут
    for (let i = 0; i < 20; i++) rel = rm.applyDeltas('p1', { trust: 0.12 });
    expect(rel.trust).toBeGreaterThan(0.75);
    expect(rel.trust).toBeLessThanOrEqual(1);
    // негатив не обнуляет одним событием
    rel = rm.applyDeltas('p1', { trust: -99 });
    expect(rel.trust).toBeGreaterThan(0.5);
  });

  it('recordInteraction растит familiarity и счётчик', () => {
    const rm = mk();
    rm.ensure({ id: 'p2' });
    let rel = rm.get('p2');
    for (let i = 0; i < 10; i++) rel = rm.recordInteraction('p2');
    expect(rel.interactions).toBe(10);
    expect(rel.familiarity).toBeGreaterThan(0.15);
    expect(rel.familiarity).toBeLessThan(0.5);
  });

  it('summary от фона попадает в описание', () => {
    const rm = mk();
    rm.ensure({ id: 'p3' });
    rm.recordInteraction('p3');
    const rel = rm.applyDeltas('p3', { summary: 'Кажется, он спокойный и любит пошутить.' });
    expect(rm.describeForPrompt(rel)).toContain('спокойный и любит пошутить');
  });
});

describe('MemoryManager + dedupe', () => {
  const emb = new MockEmbeddingProvider(128);
  const mk = (enabled = true) =>
    new MemoryManager(repos.memories, emb, { enabled, dedupeSimilarity: 0.85 });

  it('повтор того же факта не создаёт дубль (семантика)', async () => {
    const mm = mk();
    const r1 = await mm.store({ kind: 'preference', content: 'Gent любит играть в Сталкер', personId: 'p1', dedupeKey: 'pref:stalker' });
    const r2 = await mm.store({ kind: 'preference', content: 'Gent любит Сталкер', personId: 'p1', dedupeKey: 'pref:stalker' });
    expect(r1.action).toBe('created');
    expect(r2.action).toBe('updated');
    expect(mm.countActive('p1')).toBe(1);
  });

  it('без dedupe_key семантическая близость тоже ловит дубль', async () => {
    const mm = mk();
    await mm.store({ kind: 'preference', content: 'любит играть в сталкер зов припяти', personId: 'p1' });
    const r2 = await mm.store({ kind: 'preference', content: 'любит играть в сталкер зов припяти', personId: 'p1' });
    expect(r2.action).toBe('updated');
  });

  it('разные факты не сливаются', async () => {
    const mm = mk();
    await mm.store({ kind: 'preference', content: 'Gent любит кофе', personId: 'p1' });
    const r2 = await mm.store({ kind: 'preference', content: 'Gent работает программистом', personId: 'p1' });
    expect(r2.action).toBe('created');
    expect(mm.countActive('p1')).toBe(2);
  });

  it('reinforce объединяет objective-факты и усиливает важность', async () => {
    const mm = mk();
    const r1 = await mm.store({
      kind: 'preference', content: 'Gent любит Сталкер', personId: 'p1', dedupeKey: 'pref:stalker',
      objectiveFacts: ['Gent любит Сталкер'], importance: 0.4,
    });
    await mm.store({
      kind: 'preference', content: 'Gent любит Сталкер', personId: 'p1', dedupeKey: 'pref:stalker',
      objectiveFacts: ['Gent прошёл Зов Припяти'], importance: 0.6,
    });
    const rec = repos.memories.get((r1 as { id: string }).id)!;
    expect(rec.objectiveFacts).toEqual(['Gent любит Сталкер', 'Gent прошёл Зов Припяти']);
    expect(rec.importance).toBeGreaterThan(0.6);
  });

  it('отключённая память → skipped, ничего не пишет', async () => {
    const mm = mk(false);
    const r = await mm.store({ kind: 'fact', content: 'что-то', personId: 'p1' });
    expect(r.action).toBe('skipped');
    expect(mm.countActive()).toBe(0);
  });

  it('privacy: forgetPerson удаляет все памяти человека', async () => {
    const mm = mk();
    await mm.store({ kind: 'fact', content: 'Gent работает системным администратором', personId: 'p1' });
    await mm.store({ kind: 'fact', content: 'Gent живёт в Екатеринбурге', personId: 'p1' });
    await mm.store({ kind: 'fact', content: 'Вася collects vintage synthesizers', personId: 'p2' });
    expect(mm.forgetPerson('p1')).toBe(2);
    expect(mm.countActive('p1')).toBe(0);
    expect(mm.countActive('p2')).toBe(1);
  });

  it('embeddings упали — память всё равно записывается (без вектора)', async () => {
    const failing = new MockEmbeddingProvider(64);
    failing.shouldFail = true;
    const mm = new MemoryManager(repos.memories, failing, { enabled: true, dedupeSimilarity: 0.9 });
    const r = await mm.store({ kind: 'fact', content: 'важный факт', personId: 'p1' });
    expect(r.action).toBe('created');
    expect(repos.memories.get((r as { id: string }).id)!.embedding).toBeNull();
  });
});

describe('MemoryRetrieval', () => {
  const emb = new MockEmbeddingProvider(128);
  const mkRetrieval = (mode: 'hybrid' | 'keyword' | 'semantic' = 'hybrid') =>
    new MemoryRetrieval(repos.memories, emb, {
      mode,
      topK: 5,
      minScore: 0.05,
      recencyHalfLifeDays: 14,
      weights: { semantic: 1, recency: 0.5, importance: 0.6, emotion: 0.35, recall: 0.25, personBoost: 1.25 },
    });

  const seed = async () => {
    const mm = new MemoryManager(repos.memories, emb, { enabled: true, dedupeSimilarity: 0.99 });
    await mm.store({ kind: 'event', content: 'Gent помог Luna настроить сервер', personId: 'p1', importance: 0.8, emotion: 'благодарность', emotionIntensity: 0.7 });
    await mm.store({ kind: 'preference', content: 'Gent обожает визуальные новеллы', personId: 'p1', importance: 0.5 });
    await mm.store({ kind: 'preference', content: 'Соседний канал обсуждал футбол', personId: null, importance: 0.2 });
    await mm.store({ kind: 'event', content: 'Другой человек рассказывал про новеллы', personId: 'p2', importance: 0.5 });
  };

  it('семантически релевантное поднимается выше', async () => {
    await seed();
    const r = mkRetrieval('semantic');
    const out = await r.retrieve({ query: 'что там с настройкой сервера', personId: 'p1' });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.memory.content).toMatch(/сервер/i);
  });

  it('keyword-режим работает без embeddings-провайдера', async () => {
    await seed();
    const r = new MemoryRetrieval(repos.memories, null, {
      mode: 'keyword', topK: 5, minScore: 0.05, recencyHalfLifeDays: 14,
      weights: { semantic: 1, recency: 0.5, importance: 0.6, emotion: 0.35, recall: 0.25, personBoost: 1.25 },
    });
    const out = await r.retrieve({ query: 'визуальные новеллы', personId: 'p1' });
    expect(out.some((m) => m.memory.content.includes('новеллы'))).toBe(true);
  });

  it('памяти другого человека не всплывают', async () => {
    await seed();
    const r = mkRetrieval();
    const out = await r.retrieve({ query: 'новеллы', personId: 'p1' });
    expect(out.every((m) => m.memory.personId === 'p1' || m.memory.personId === null)).toBe(true);
  });

  it('эмоционально значимое событие ранжируется выше сухого факта той же темы', async () => {
    const mm = new MemoryManager(repos.memories, emb, { enabled: true, dedupeSimilarity: 0.99 });
    await mm.store({ kind: 'event', content: 'Мы с Gent вместе прошли трудный рейд и это было круто', personId: 'p1', importance: 0.6, emotion: 'радость', emotionIntensity: 0.9 });
    await mm.store({ kind: 'fact', content: 'Gent упоминал рейд мельком', personId: 'p1', importance: 0.6, emotionIntensity: 0 });
    const r = mkRetrieval('hybrid');
    const out = await r.retrieve({ query: 'рейд', personId: 'p1' });
    expect(out).toHaveLength(2);
    expect(out[0]!.memory.content).toMatch(/трудный рейд/);
    expect(out[0]!.components.emotion).toBeGreaterThan(out[1]!.components.emotion);
  });

  it('recall_count повышает шансы (часто всплывавшее важнее)', async () => {
    const mm = new MemoryManager(repos.memories, emb, { enabled: true, dedupeSimilarity: 0.99 });
    const a = await mm.store({ kind: 'fact', content: 'факт альфа про игры', personId: 'p1', importance: 0.5 });
    const b = await mm.store({ kind: 'fact', content: 'факт бета про игры', personId: 'p1', importance: 0.5 });
    repos.memories.markRecalled([(a as { id: string }).id]);
    repos.memories.markRecalled([(a as { id: string }).id]);
    repos.memories.markRecalled([(a as { id: string }).id]);
    const r = mkRetrieval('keyword');
    const out = await r.retrieve({ query: 'факт альфа бета про игры', personId: 'p1' });
    const ia = out.findIndex((m) => m.memory.id === (a as { id: string }).id);
    const ib = out.findIndex((m) => m.memory.id === (b as { id: string }).id);
    expect(ia).toBeLessThan(ib);
    void b;
  });

  it('провал embeddings не блокирует retrieval (degrade to keyword)', async () => {
    const failing = new MockEmbeddingProvider(64);
    failing.shouldFail = true;
    await seed();
    const r = new MemoryRetrieval(repos.memories, failing, {
      mode: 'hybrid', topK: 5, minScore: 0.05, recencyHalfLifeDays: 14,
      weights: { semantic: 1, recency: 0.5, importance: 0.6, emotion: 0.35, recall: 0.25, personBoost: 1.25 },
    });
    // у записей embedding от другого провайдера (128) — семантика 0, но keyword вытягивает
    const out = await r.retrieve({ query: 'настроить сервер', personId: 'p1' });
    expect(out.some((m) => m.memory.content.includes('сервер'))).toBe(true);
  });
});

describe('MemoryConsolidator', () => {
  it('мелочь сливается в consolidated, оригиналы — merged, важные не тронуты', async () => {
    const mm = new MemoryManager(repos.memories, null, { enabled: true, dedupeSimilarity: 0.99 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await mm.store({ kind: 'fact', content: `мелкий факт про игры номер ${i}`, personId: 'p1', importance: 0.2, dedupeKey: `games:f${i}` });
      ids.push((r as { id: string }).id);
    }
    const important = await mm.store({ kind: 'event', content: 'ВАЖНОЕ событие', personId: 'p1', importance: 0.9 });

    const llm = new MockLLMProvider({
      structured: () => ({ summary: 'Luna и p1 много раз обсуждали разные игры; он заядлый игрок.', importance: 0.5 }),
    });
    const c = new MemoryConsolidator(repos.memories, llm, {
      backgroundModel: 'bg-model', minCluster: 6, protectImportance: 0.7,
    });
    const res = await c.runForPerson('p1');
    expect(res.clustersMerged).toBe(1);
    expect(res.memoriesMerged).toBe(6);

    for (const id of ids) expect(repos.memories.get(id)!.status).toBe('merged');
    expect(repos.memories.get((important as { id: string }).id)!.status).toBe('active');
    const consolidated = repos.memories.listActive({ personIds: ['p1'], kinds: ['consolidated'] });
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]!.content).toMatch(/заядлый игрок/);
    // важность консолидированной записи не выше protectImportance
    expect(consolidated[0]!.importance).toBeLessThanOrEqual(0.7);
  });

  it('меньше minCluster — ничего не делает', async () => {
    const mm = new MemoryManager(repos.memories, null, { enabled: true, dedupeSimilarity: 0.99 });
    await mm.store({ kind: 'fact', content: 'один факт', personId: 'p1', importance: 0.2 });
    const llm = new MockLLMProvider({ structured: () => ({ summary: 'x'.repeat(20), importance: 0.5 }) });
    const c = new MemoryConsolidator(repos.memories, llm, { backgroundModel: 'bg', minCluster: 6, protectImportance: 0.7 });
    const res = await c.runForPerson('p1');
    expect(res.clustersMerged).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('LLM вернул мусор — кластер остаётся как был (фон не роняет данные)', async () => {
    const mm = new MemoryManager(repos.memories, null, { enabled: true, dedupeSimilarity: 0.99 });
    for (let i = 0; i < 6; i++) {
      await mm.store({ kind: 'fact', content: `факт ${i}`, personId: 'p1', importance: 0.2, dedupeKey: `k${i}` });
    }
    const llm = new MockLLMProvider({ structured: () => ({ wrong: 'shape' }) });
    const c = new MemoryConsolidator(repos.memories, llm, { backgroundModel: 'bg', minCluster: 6, protectImportance: 0.7 });
    const res = await c.runForPerson('p1');
    expect(res.clustersMerged).toBe(0);
    expect(repos.memories.countActive('p1')).toBe(6);
  });
});

describe('factoryReset — сброс памяти к заводскому (кнопка в панели)', () => {
  const seed = async () => {
    const mm = new MemoryManager(repos.memories, new MockEmbeddingProvider(128), { enabled: true, dedupeSimilarity: 0.99 });
    await mm.store({ kind: 'preference', content: 'Gent любит Сталкер', personId: 'p1', importance: 0.6 });
    await mm.store({ kind: 'event', content: 'Вася починил сервер', personId: 'p2', importance: 0.8 });
    repos.summaries.insert({ channelId: 'ch1', periodStart: 1, periodEnd: 2, summary: 'говорили про игры' });
    const rm = new RelationshipManager(repos.users, repos.relationships, { ownerId: 'owner1' });
    rm.ensureAndCount({ id: 'p1', displayName: 'Gent' });
    rm.applyDeltas('p1', { trust: 0.1, summary: 'Они уже неплохо общаются.' });
    new EmotionManager(repos.emotions, { decayHalfLifeMin: 90 }).applyDeltas({ mood: 0.2, irritation: 0.2 });
    repos.settings.set('user:p1', 'tts_enabled', 'false');
    repos.stats.incrementMessagesIn('p1');
  };

  it('стирает памяти, summary и отношения, эмоции возвращает на базовую линию', async () => {
    await seed();
    const result = factoryReset(repos, { ownerId: 'owner1' });

    expect(result.memories).toBe(2);
    expect(result.summaries).toBe(1);
    expect(result.relationships).toBe(1);
    expect(result.emotions).toBe('baseline');
    expect(repos.memories.countActive()).toBe(0);
    expect(repos.summaries.countForChannel('ch1')).toBe(0);
    const state = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90 }).current();
    expect(state.mood).toBeCloseTo(EMOTION_BASELINE.mood);
    expect(state.irritation).toBe(EMOTION_BASELINE.irritation);
  });

  it('обычные люди — знакомитесь заново, владелец снова «старый знакомый»', async () => {
    await seed();
    const result = factoryReset(repos, { ownerId: 'owner1' });

    expect(result.ownerSeeded).toBe(true);
    expect(repos.relationships.get('p1')).toBeNull();
    const owner = repos.relationships.get('owner1')!;
    expect(owner).not.toBeNull();
    expect(owner.familiarity).toBeCloseTo(OWNER_SEED.familiarity);
    expect(owner.trust).toBeCloseTo(OWNER_SEED.trust);
    expect(owner.summary).toBe(OWNER_SEED.summary);
    expect(owner.interactions).toBe(OWNER_SEED.interactions);
    // пользователь как запись остаётся — это не память
    expect(repos.users.get('p1')).not.toBeNull();
  });

  it('настройки озвучки и статистика не трогаются', async () => {
    await seed();
    factoryReset(repos, { ownerId: 'owner1' });
    expect(repos.settings.get('user:p1', 'tts_enabled')).toBe('false');
    expect(repos.stats.totals('p1').messagesIn).toBe(1);
  });

  it('без ownerId никто не пересеивается', async () => {
    await seed();
    const result = factoryReset(repos);
    expect(result.ownerSeeded).toBe(false);
    expect(repos.relationships.all()).toHaveLength(0);
  });

  it('полнотекстовый индекс после сброса не врёт (FTS чистится триггером)', async () => {
    repos.memories.insert({ kind: 'fact', personId: 'p1', content: 'редкое слово флексоморф', importance: 0.5 });
    expect(repos.memories.keywordSearch('флексоморф')).toHaveLength(1);
    factoryReset(repos);
    expect(repos.memories.keywordSearch('флексоморф')).toHaveLength(0);
    // и новая запись после сброса ищется нормально
    repos.memories.insert({ kind: 'fact', personId: 'p2', content: 'снова флексоморф', importance: 0.5 });
    expect(repos.memories.keywordSearch('флексоморф')).toHaveLength(1);
  });
});
