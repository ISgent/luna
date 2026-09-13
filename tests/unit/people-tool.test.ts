/**
 * people-tool — страница «Люди и память» в панели управления:
 * чтение того, что Luna знает о людях, и ТОЧЕЧНАЯ правка (меняется только присланное).
 *
 * Всё на in-memory БД и мок-эмбеддингах: сеть и живая база не трогаются.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, createRepositories, DEFAULT_RELATIONSHIP, type Repositories } from '../../src/storage/index.js';
import { runPeopleAction, PEOPLE_ACTIONS, type PeopleToolDeps } from '../../src/luna/people-tool.js';
import { RelationshipManager, OWNER_SEED } from '../../src/luna/relationships/relationship-manager.js';
import { MockEmbeddingProvider } from '../../src/ai/mock.js';

let db: Database;
let repos: Repositories;
let embeddings: MockEmbeddingProvider;
let deps: PeopleToolDeps;

beforeEach(() => {
  db = Database.open(':memory:');
  repos = createRepositories(db);
  embeddings = new MockEmbeddingProvider(64);
  deps = { repos, embeddings, ownerId: 'owner1', dedupeSimilarity: 0.9 };
});

afterEach(() => {
  db.close();
});

/** Успешное действие: падение ok=false роняет тест с текстом ошибки. */
async function call(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  const r = await runPeopleAction(deps, action, payload);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r;
}

async function callErr(action: string, payload: Record<string, unknown> = {}): Promise<string> {
  const r = await runPeopleAction(deps, action, payload);
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return (r as { ok: false; error: string }).error;
}

/** Человек, заведённый тем же путём, что и в бою (ensure + счётчик взаимодействий). */
function seedPerson(id: string, name: string, isOwner = false): void {
  new RelationshipManager(repos.users, repos.relationships, { ownerId: 'owner1' }).ensureAndCount({
    id,
    displayName: name,
    username: name.toLowerCase(),
    isOwner,
  });
}

async function seedMemory(personId: string | null, content: string, importance = 0.5): Promise<string> {
  const r = await call('addMemory', { personId, memory: { content, kind: 'fact', importance } });
  return r.memory.id;
}

describe('list — кого Luna знает', () => {
  it('собирает людей и из пользователей, и из записей памяти', async () => {
    seedPerson('p1', 'Gent');
    // записи могут ссылаться на человека, о котором нет ни пользователя, ни отношений
    repos.memories.insert({ kind: 'fact', personId: 'ghost', content: 'кто-то писал в личку', importance: 0.4 });

    const { people } = await call('list');
    expect(people.map((p: any) => p.personId)).toEqual(['p1', 'ghost']);
    const ghost = people[1];
    expect(ghost.displayName).toBe('');
    expect(ghost.relationship).toBeNull();
    expect(ghost.memoryCount).toBe(1);
  });

  it('владелец первым, остальные — по последнему контакту', async () => {
    seedPerson('p1', 'Вася');
    repos.users.touch('p1');
    seedPerson('owner1', 'Gent', true);

    const { people } = await call('list');
    expect(people[0].personId).toBe('owner1');
    expect(people[0].isOwner).toBe(true);
    expect(people[1].personId).toBe('p1');
  });

  it('описание отношений — то же, что уходит в промпт', async () => {
    seedPerson('owner1', 'Gent', true);
    const { people } = await call('list');
    expect(people[0].relationship.trust).toBeCloseTo(OWNER_SEED.trust);
    expect(people[0].description).toContain('Luna давно знает этого человека');
    expect(people[0].description).toContain(OWNER_SEED.summary);
  });

  it('общие записи (не о человеке) считаются отдельно', async () => {
    await seedMemory(null, 'на сервере есть канал про игры');
    await seedMemory('p1', 'Gent любит Сталкер');
    const r = await call('list');
    expect(r.globalMemories).toBe(1);
    expect(r.people).toHaveLength(1);
  });

  it('пустая база — пустой список, без ошибок', async () => {
    const r = await call('list');
    expect(r.people).toEqual([]);
    expect(r.globalMemories).toBe(0);
  });
});

describe('get — карточка человека', () => {
  it('человек целиком + его записи, статистика и настройки', async () => {
    seedPerson('p1', 'Gent');
    await seedMemory('p1', 'Gent любит Сталкер');
    repos.stats.incrementMessagesIn('p1');
    repos.settings.set('user:p1', 'tts_enabled', 'false');

    const r = await call('get', { personId: 'p1' });
    expect(r.person.displayName).toBe('Gent');
    expect(r.person.memoryCount).toBe(1);
    expect(r.person.stats.messagesIn).toBe(1);
    expect(r.person.settings.ttsEnabled).toBe(false);
    expect(r.person.settings.memoryEnabled).toBe(true);
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0].content).toBe('Gent любит Сталкер');
    expect(r.memories[0].hasEmbedding).toBe(true);
    // векторы наружу не отдаём — только признак
    expect(r.memories[0].embedding).toBeUndefined();
  });

  it('personId=null — только общие записи', async () => {
    await seedMemory(null, 'сервер называется «Сервер gent»');
    await seedMemory('p1', 'Gent любит Сталкер');

    const r = await call('get', { personId: null });
    expect(r.person).toBeNull();
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0].content).toContain('Сервер gent');
  });

  it('незнакомый id — карточка с дефолтным описанием, без записей', async () => {
    const r = await call('get', { personId: 'nope' });
    expect(r.person.relationship).toBeNull();
    expect(r.person.description).toContain('почти не знает');
    expect(r.memories).toEqual([]);
  });

  it('без personId — понятная ошибка', async () => {
    expect(await callErr('get', {})).toMatch(/personId/);
  });
});

describe('createPerson — добавить человека', () => {
  it('заводит пользователя и отношения по умолчанию', async () => {
    const r = await call('createPerson', { personId: 'p9', displayName: 'Вася', username: 'vasya' });
    expect(r.person.personId).toBe('p9');
    expect(r.person.displayName).toBe('Вася');
    expect(repos.users.get('p9')?.username).toBe('vasya');
    expect(r.person.relationship.trust).toBeCloseTo(DEFAULT_RELATIONSHIP.trust);
    expect(r.person.relationship.interactions).toBe(0);
  });

  it('пресет отношений применяется сразу', async () => {
    const r = await call('createPerson', {
      personId: 'p9',
      displayName: 'Вася',
      relationship: { trust: 0.8, closeness: 0.6, summary: 'они уже приятели' },
    });
    expect(r.person.relationship.trust).toBeCloseTo(0.8);
    expect(r.person.relationship.closeness).toBeCloseTo(0.6);
    // не присланное осталось дефолтным
    expect(r.person.relationship.respect).toBeCloseTo(DEFAULT_RELATIONSHIP.respect);
    expect(r.person.relationship.summary).toBe('они уже приятели');
  });

  it('Discord ID владельца — сразу «старый знакомый»', async () => {
    const r = await call('createPerson', { personId: 'owner1', displayName: 'Gent' });
    expect(r.person.relationship.trust).toBeCloseTo(OWNER_SEED.trust);
    expect(r.person.isOwner).toBe(true);
  });

  it('без ID — внутренний идентификатор', async () => {
    const r = await call('createPerson', { displayName: 'Сосед' });
    expect(r.person.personId).toMatch(/^person_/);
    expect(repos.users.get(r.person.personId)).not.toBeNull();
  });

  it('без имени — ошибка, никого не создали', async () => {
    expect(await callErr('createPerson', { personId: 'p9' })).toMatch(/имя/);
    expect(repos.users.get('p9')).toBeNull();
  });

  it('кривой ID — ошибка', async () => {
    expect(await callErr('createPerson', { personId: 'bad id!', displayName: 'X' })).toMatch(/ID человека/);
  });
});

describe('updatePerson — точечная правка', () => {
  beforeEach(() => seedPerson('p1', 'Gent'));

  it('меняет только присланные измерения отношений', async () => {
    const before = repos.relationships.get('p1')!;
    const r = await call('updatePerson', { personId: 'p1', relationship: { trust: 0.9 } });

    expect(r.person.relationship.trust).toBeCloseTo(0.9);
    expect(r.person.relationship.closeness).toBeCloseTo(before.closeness);
    expect(r.person.relationship.affection).toBeCloseTo(before.affection);
    expect(r.person.relationship.interactions).toBe(before.interactions);
  });

  it('числа зажимаются в 0..1, счётчики — целые и неотрицательные', async () => {
    const r = await call('updatePerson', {
      personId: 'p1',
      relationship: { trust: 5, affection: -3, interactions: -7, sharedXp: 2.6 },
    });
    expect(r.person.relationship.trust).toBe(1);
    expect(r.person.relationship.affection).toBe(0);
    expect(r.person.relationship.interactions).toBe(0);
    expect(r.person.relationship.sharedXp).toBe(3);
  });

  it('имя правится, first_seen не сбрасывается', async () => {
    const firstSeen = repos.users.get('p1')!.firstSeenAt;
    const r = await call('updatePerson', { personId: 'p1', displayName: 'Женя' });
    expect(r.person.displayName).toBe('Женя');
    expect(r.person.username).toBe('gent'); // не присылали — не тронули
    expect(repos.users.get('p1')!.firstSeenAt).toBe(firstSeen);
  });

  it('summary обрезается до разумного предела', async () => {
    const r = await call('updatePerson', { personId: 'p1', relationship: { summary: 'а'.repeat(5000) } });
    expect(r.person.relationship.summary).toHaveLength(1200);
  });

  it('правка отношений создаёт запись, если её стёрли', async () => {
    repos.relationships.remove('p1');
    const r = await call('updatePerson', { personId: 'p1', relationship: { trust: 0.4 } });
    expect(r.person.relationship.trust).toBeCloseTo(0.4);
    expect(repos.relationships.get('p1')).not.toBeNull();
  });

  it('человека нет — ошибка без создания записей', async () => {
    expect(await callErr('updatePerson', { personId: 'ghost', relationship: { trust: 1 } })).toMatch(/нет/);
    expect(repos.relationships.get('ghost')).toBeNull();
  });
});

describe('deletePerson / wipePerson', () => {
  beforeEach(async () => {
    seedPerson('p1', 'Gent');
    seedPerson('p2', 'Вася');
    await seedMemory('p1', 'Gent любит Сталкер');
    await seedMemory('p1', 'Gent чинил сервер');
    await seedMemory('p2', 'Вася заходил в голос');
  });

  it('удаляет человека, отношения и его записи; чужие не трогает', async () => {
    const r = await call('deletePerson', { personId: 'p1' });
    expect(r.deletedMemories).toBe(2);
    expect(repos.users.get('p1')).toBeNull();
    expect(repos.relationships.get('p1')).toBeNull();
    expect(repos.memories.countActive('p1')).toBe(0);
    expect(repos.memories.countActive('p2')).toBe(1);
  });

  it('deleteMemories=false — записи остаются (человек без карточки)', async () => {
    const r = await call('deletePerson', { personId: 'p1', deleteMemories: false });
    expect(r.deletedMemories).toBe(0);
    expect(repos.users.get('p1')).toBeNull();
    expect(repos.memories.countActive('p1')).toBe(2);
    // он всё ещё виден в списке — по записям памяти
    const { people } = await call('list');
    expect(people.map((p: any) => p.personId)).toContain('p1');
  });

  it('полнотекстовый индекс после удаления не врёт', async () => {
    expect(repos.memories.keywordSearch('Сталкер')).toHaveLength(1);
    await call('deletePerson', { personId: 'p1' });
    expect(repos.memories.keywordSearch('Сталкер')).toHaveLength(0);
  });

  it('нет такого человека — ошибка', async () => {
    expect(await callErr('deletePerson', { personId: 'ghost' })).toMatch(/нет/);
  });

  it('wipe: память и отношения стёрты, человек остаётся в списке', async () => {
    const r = await call('wipePerson', { personId: 'p1' });
    expect(r.deletedMemories).toBe(2);
    expect(repos.relationships.get('p1')).toBeNull();
    expect(repos.users.get('p1')).not.toBeNull();
    expect(repos.memories.countActive('p2')).toBe(1);
  });
});

describe('setSetting — память/озвучка/голос человека', () => {
  beforeEach(() => seedPerson('p1', 'Gent'));

  it('переключает те же ключи, что и команды бота', async () => {
    await call('setSetting', { personId: 'p1', key: 'memory_enabled', value: false });
    await call('setSetting', { personId: 'p1', key: 'tts_enabled', value: false });

    expect(repos.settings.get('user:p1', 'memory_enabled')).toBe('false');
    const r = await call('get', { personId: 'p1' });
    expect(r.person.settings.memoryEnabled).toBe(false);
    expect(r.person.settings.ttsEnabled).toBe(false);
    expect(r.person.settings.voiceEnabled).toBe(true);
  });

  it('неизвестный ключ — ошибка (в базу ничего не пишется)', async () => {
    expect(await callErr('setSetting', { personId: 'p1', key: 'admin', value: true })).toMatch(/неизвестная настройка/);
    expect(repos.settings.listScope('user:p1')).toEqual([]);
  });

  it('не-boolean — ошибка', async () => {
    expect(await callErr('setSetting', { personId: 'p1', key: 'tts_enabled', value: 'yes' as unknown as boolean })).toMatch(/value/);
  });
});

describe('addMemory — новая запись', () => {
  beforeEach(() => seedPerson('p1', 'Gent'));

  it('сохраняет запись с вектором, и она сразу ищется', async () => {
    const r = await call('addMemory', {
      personId: 'p1',
      memory: { content: 'Gent любит Сталкер', kind: 'preference', importance: 0.7, opinion: 'с ним интересно' },
    });
    expect(r.stored).toBe('created');
    expect(r.memory.hasEmbedding).toBe(true);
    expect(r.memory.opinion).toBe('с ним интересно');
    expect(repos.memories.countActive('p1')).toBe(1);
    expect(repos.memories.keywordSearch('Сталкер')).toHaveLength(1);
  });

  it('повтор того же усиливает существующую запись, а не плодит дубли', async () => {
    const first = await seedMemory('p1', 'Gent любит Сталкер', 0.5);
    const r = await call('addMemory', { personId: 'p1', memory: { content: 'Gent любит Сталкер', importance: 0.6 } });
    expect(r.stored).toBe('updated');
    expect(r.memory.id).toBe(first);
    expect(repos.memories.countActive('p1')).toBe(1);
    expect(r.memory.importance).toBeGreaterThan(0.5);
  });

  it('personId=null — общая запись (о мире/о себе)', async () => {
    const r = await call('addMemory', { personId: null, memory: { content: 'сервер называется «Сервер gent»' } });
    expect(repos.memories.get(r.memory.id)?.personId).toBeNull();
    expect(repos.memories.countActive('p1')).toBe(0);
  });

  it('короткий или пустой текст — ошибка', async () => {
    expect(await callErr('addMemory', { personId: 'p1', memory: { content: 'ок' } })).toMatch(/минимум 3/);
    expect(await callErr('addMemory', { personId: 'p1', memory: { content: '   ' } })).toMatch(/минимум 3/);
    expect(await callErr('addMemory', { personId: 'p1' })).toMatch(/минимум 3/);
  });

  it('без personId — ошибка (не молча пишет в общие)', async () => {
    expect(await callErr('addMemory', { memory: { content: 'что-то важное про человека' } })).toMatch(/personId/);
  });

  it('важность и уверенность зажимаются, дефолты — как у ручной записи', async () => {
    const r = await call('addMemory', { personId: 'p1', memory: { content: 'Gent заходил вчера', importance: 9, confidence: -1 } });
    expect(r.memory.importance).toBe(1);
    expect(r.memory.confidence).toBe(0);
    const d = await call('addMemory', { personId: 'p1', memory: { content: 'Gent чинил сервер' } });
    expect(d.memory.importance).toBeCloseTo(0.5);
    expect(d.memory.confidence).toBeCloseTo(0.95);
  });

  it('неизвестный тип записи приводится к fact', async () => {
    const r = await call('addMemory', { personId: 'p1', memory: { content: 'Gent заходил вчера', kind: 'wat' } });
    expect(r.memory.kind).toBe('fact');
  });

  it('без провайдера эмбеддингов запись всё равно сохраняется (ищется по словам)', async () => {
    deps.embeddings = null;
    const r = await call('addMemory', { personId: 'p1', memory: { content: 'Gent любит Сталкер' } });
    expect(r.stored).toBe('created');
    expect(r.memory.hasEmbedding).toBe(false);
    expect(repos.memories.keywordSearch('Сталкер')).toHaveLength(1);
  });

  it('факты принимаются и массивом, и текстом по строке', async () => {
    const a = await call('addMemory', { personId: 'p1', memory: { content: 'Gent прошёл Сталкер', objectiveFacts: ['прошёл Зов Припяти'] } });
    expect(a.memory.objectiveFacts).toEqual(['прошёл Зов Припяти']);
    const b = await call('addMemory', { personId: 'p1', memory: { content: 'Gent чинил сервер ночью', objectiveFacts: 'починил диск\nперезапустил' } });
    expect(b.memory.objectiveFacts).toEqual(['починил диск', 'перезапустил']);
  });
});

describe('updateMemory — точечная правка записи', () => {
  let id: string;

  beforeEach(async () => {
    seedPerson('p1', 'Gent');
    id = await seedMemory('p1', 'Gent любит Сталкер', 0.5);
  });

  it('меняет только присланное', async () => {
    const r = await call('updateMemory', { memoryId: id, memory: { importance: 0.9 } });
    expect(r.memory.importance).toBeCloseTo(0.9);
    expect(r.memory.content).toBe('Gent любит Сталкер');
    expect(r.memory.kind).toBe('fact');
    expect(r.memory.confidence).toBeCloseTo(0.95);
  });

  it('текст, тип и впечатление правятся вместе с записью', async () => {
    const r = await call('updateMemory', {
      memoryId: id,
      memory: { content: 'Gent обожает Тень Чернобыля', kind: 'preference', opinion: 'у него хороший вкус', emotion: 'радость', emotionIntensity: 0.4 },
    });
    expect(r.memory.content).toBe('Gent обожает Тень Чернобыля');
    expect(r.memory.kind).toBe('preference');
    expect(r.memory.opinion).toBe('у него хороший вкус');
    expect(r.memory.emotion).toBe('радость');
    const rec = repos.memories.get(id)!;
    expect(rec.subjective?.opinion).toBe('у него хороший вкус');
    expect(rec.subjective?.emotion).toBe('радость');
    expect(rec.objectiveFacts).toEqual([]);
  });

  it('смена текста пересчитывает вектор, смена важности — нет', async () => {
    const before = embeddings.calls;
    await call('updateMemory', { memoryId: id, memory: { importance: 0.8 } });
    expect(embeddings.calls).toBe(before);

    await call('updateMemory', { memoryId: id, memory: { content: 'Gent разлюбил Сталкер' } });
    expect(embeddings.calls).toBe(before + 1);
  });

  it('пустое впечатление убирает его из промпта', async () => {
    await call('updateMemory', { memoryId: id, memory: { opinion: 'нормальный парень' } });
    expect(repos.memories.get(id)!.subjective?.opinion).toBe('нормальный парень');
    const r = await call('updateMemory', { memoryId: id, memory: { opinion: '' } });
    expect(r.memory.opinion).toBeNull();
    expect(repos.memories.get(id)!.subjective).toBeNull();
  });

  it('ползунок важности зажимается в 0..1', async () => {
    const r = await call('updateMemory', { memoryId: id, memory: { importance: 42, confidence: -2 } });
    expect(r.memory.importance).toBe(1);
    expect(r.memory.confidence).toBe(0);
  });

  it('нет такой записи / нет id — ошибка', async () => {
    expect(await callErr('updateMemory', { memoryId: 'mem_nope', memory: { content: 'что-то новое' } })).toMatch(/нет/);
    expect(await callErr('updateMemory', { memory: { content: 'что-то новое' } })).toMatch(/memoryId/);
  });

  it('короткий текст — ошибка, запись не испорчена', async () => {
    expect(await callErr('updateMemory', { memoryId: id, memory: { content: 'ок' } })).toMatch(/минимум 3/);
    expect(repos.memories.get(id)!.content).toBe('Gent любит Сталкер');
  });
});

describe('deleteMemory', () => {
  beforeEach(() => seedPerson('p1', 'Gent'));

  it('удаляет запись и чистит полнотекстовый индекс', async () => {
    const id = await seedMemory('p1', 'Gent любит редкое слово флексоморф');
    expect(repos.memories.keywordSearch('флексоморф')).toHaveLength(1);

    const r = await call('deleteMemory', { memoryId: id });
    expect(r.deleted).toBe(true);
    expect(repos.memories.get(id)).toBeNull();
    expect(repos.memories.keywordSearch('флексоморф')).toHaveLength(0);
  });

  it('повторное удаление и пустой id — ошибка', async () => {
    const id = await seedMemory('p1', 'Gent любит Сталкер');
    await call('deleteMemory', { memoryId: id });
    expect(await callErr('deleteMemory', { memoryId: id })).toMatch(/нет/);
    expect(await callErr('deleteMemory', {})).toMatch(/memoryId/);
  });
});

describe('runPeopleAction — границы', () => {
  it('неизвестное действие отклоняется со списком доступных', async () => {
    const err = await callErr('dropDatabase', {});
    expect(err).toContain('неизвестное действие');
    expect(err).toContain('list');
    expect(PEOPLE_ACTIONS).toContain('list');
  });

  it('мусор в аргументах не роняет инструмент', async () => {
    const r = await call('list');
    expect(r.ok).toBe(true);
    // personId не строка → действие отклоняется, а не падает
    expect(await callErr('get', { personId: 42 as unknown as string })).toMatch(/personId/);
  });
});
