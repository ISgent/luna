/**
 * people-tool.ts — «кого Luna знает» для страницы «Люди и память» в панели управления.
 *
 * Зачем отдельный вход: смотритель панели (tools/supervisor.mjs) — обычный Node-процесс
 * без доменного кода, поэтому чтение и правка выполняются ТЕМ ЖЕ кодом, что и у бота
 * (репозитории + RelationshipManager + MemoryManager), коротким отдельным процессом.
 * Приём тот же, что у factory-reset: `node dist/luna/people-tool.js --action=<name>`,
 * аргументы — JSON в stdin, ответ — одна строка `PEOPLE_TOOL_RESULT={…}`.
 *
 * Действия:
 *   list          — все люди: отношения, число записей, как Luna сама их описывает
 *   get           — один человек полностью + его записи памяти (personId=null → общие записи)
 *   createPerson  — добавить человека (Discord ID или «свой»)
 *   updatePerson  — точечная правка имени и отношений (меняются только присланные поля)
 *   deletePerson  — удалить человека (по умолчанию вместе с его записями)
 *   wipePerson    — забыть всё о человеке, но оставить его в списке
 *   setSetting    — память/озвучка/голос для человека
 *   addMemory     — новая запись (эмбеддинг и дедупликация — как у бота)
 *   updateMemory  — точечная правка записи (смена текста пересчитывает эмбеддинг)
 *   deleteMemory  — удалить запись
 *
 * Бот на время правки останавливать НЕ нужно: отношения и долговременная память читаются
 * из БД на каждое сообщение (в процессе бота живёт только short-term текущего диалога).
 */
import { pathToFileURL } from 'node:url';
import { Database, DEFAULT_RELATIONSHIP, createRepositories, type MemoriesRepo, type Repositories } from '../storage/index.js';
import { RelationshipManager } from './relationships/relationship-manager.js';
import { MemoryManager } from './memory/memory-manager.js';
import { createProviders } from '../ai/registry.js';
import type { EmbeddingProvider } from '../ai/types.js';
import type { MemoryKind, MemoryRecord, RelationshipState, SubjectiveImpression } from './types.js';
import { newId } from '../utils/ids.js';

/** Маркер строки результата — смотритель ищет его в stdout, отфильтровывая предупреждения Node. */
export const RESULT_MARKER = 'PEOPLE_TOOL_RESULT=';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'event',
  'joke',
  'promise',
  'open_thread',
  'impression',
  'consolidated',
];

/** Личные настройки человека (scope `user:<id>`) — те же ключи, что у /memory и /luna tts|voice. */
export const PERSON_SETTING_KEYS = ['memory_enabled', 'tts_enabled', 'voice_enabled'] as const;
export type PersonSettingKey = (typeof PERSON_SETTING_KEYS)[number];

export const PEOPLE_ACTIONS = [
  'list',
  'get',
  'createPerson',
  'updatePerson',
  'deletePerson',
  'wipePerson',
  'setSetting',
  'addMemory',
  'updateMemory',
  'deleteMemory',
] as const;
export type PeopleAction = (typeof PEOPLE_ACTIONS)[number];

const MAX_SUMMARY = 1200; // как в RelationshipManager.applyDeltas
const MAX_CONTENT = 2000;
const MAX_OPINION = 600;
const MAX_NAME = 100;
const MAX_FACTS = 20;

// ---------- Что отдаёт инструмент ----------

export interface MemoryView {
  id: string;
  kind: MemoryKind;
  content: string;
  objectiveFacts: string[];
  /** Впечатление Luna (subjective.opinion) — именно оно попадает в промпт. */
  opinion: string | null;
  emotion: string | null;
  emotionIntensity: number;
  importance: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt: number | null;
  recallCount: number;
  channelId: string | null;
  hasEmbedding: boolean;
}

export interface PersonSettings {
  memoryEnabled: boolean;
  ttsEnabled: boolean;
  voiceEnabled: boolean;
}

export interface PersonView {
  personId: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  relationship: RelationshipState | null;
  /** Отношения словами самой Luna (тот же код, что формирует промпт). */
  description: string;
  memoryCount: number;
  /** Только для get: сколько всего сообщений/голоса накопилось. */
  stats?: { messagesIn: number; messagesOut: number; voiceSeconds: number; days: number };
  settings?: PersonSettings;
}

export interface PeopleData {
  people: PersonView[];
  /** Активных записей не о конкретном человеке (о мире и о самой Luna). */
  globalMemories: number;
  person: PersonView | null;
  memories: MemoryView[];
  personId: string;
  memory: MemoryView;
  stored: 'created' | 'updated' | 'skipped';
  deleted: boolean;
  deletedMemories: number;
  settings: PersonSettings;
}

export type PeopleResult = { ok: false; error: string } | ({ ok: true } & Partial<PeopleData>);

// ---------- Что присылает панель ----------

export type RelationshipPatch = Partial<
  Pick<RelationshipState, 'familiarity' | 'trust' | 'closeness' | 'respect' | 'affection' | 'sharedXp' | 'interactions' | 'summary'>
>;

export interface MemoryPatch {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  emotion?: string | null;
  emotionIntensity?: number;
  opinion?: string | null;
  objectiveFacts?: string[];
}

export interface PeoplePayload {
  /** Человек; null — общие записи (не о конкретном человеке). */
  personId?: string | null;
  username?: string | null;
  displayName?: string | null;
  /** Удалить человека вместе с его записями памяти (по умолчанию да). */
  deleteMemories?: boolean;
  /** Присутствующие поля заменяются, отсутствующие не трогаются. */
  relationship?: RelationshipPatch;
  key?: string;
  value?: boolean;
  memoryId?: string;
  memory?: MemoryPatch;
  limit?: number;
}

export interface PeopleToolDeps {
  repos: Repositories;
  /** Эмбеддинги для новых/изменённых записей; null — записи ищутся только по словам. */
  embeddings?: EmbeddingProvider | null;
  ownerId?: string;
  dedupeSimilarity?: number;
  now?: () => number;
}

// ---------- Нормализация входа ----------

const fail = (error: string): PeopleResult => ({ ok: false, error });

function clamp01(v: unknown, def = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(1, n));
}

function nonNegInt(v: unknown, def = 0, max = 1_000_000): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(max, n));
}

/** Обрезанная непустая строка или null (undefined/пусто = «не задано»). */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

function normalizeKind(v: unknown): MemoryKind {
  const k = String(v);
  return (MEMORY_KINDS as readonly string[]).includes(k) ? (k as MemoryKind) : 'fact';
}

/** Факты приходят массивом или текстом «по одному в строке». */
function normalizeFacts(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
  return arr
    .map((x) => String(x).trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_FACTS);
}

function toSubjective(patch: MemoryPatch | undefined, existing: SubjectiveImpression | null): SubjectiveImpression | null {
  const opinion = patch?.opinion === undefined ? (existing?.opinion ?? null) : str(patch.opinion, MAX_OPINION);
  if (!opinion) return null;
  const emotion = patch?.emotion === undefined ? (existing?.emotion ?? null) : str(patch.emotion, 40);
  const intensity = clamp01(patch?.emotionIntensity ?? existing?.intensity ?? 0.3);
  return { opinion, emotion: emotion ?? '', intensity };
}

// ---------- Сборка представлений ----------

const nowOf = (deps: PeopleToolDeps): (() => number) => deps.now ?? Date.now;

function relationshipsOf(deps: PeopleToolDeps): RelationshipManager {
  return new RelationshipManager(deps.repos.users, deps.repos.relationships, {
    ownerId: deps.ownerId,
    seedOwnerRelationship: true,
    now: nowOf(deps),
  });
}

function toMemoryView(m: MemoryRecord): MemoryView {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    objectiveFacts: m.objectiveFacts,
    opinion: m.subjective?.opinion ?? null,
    emotion: m.subjective?.emotion || m.emotion,
    emotionIntensity: m.subjective ? m.subjective.intensity : m.emotionIntensity,
    importance: m.importance,
    confidence: m.confidence,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastRecalledAt: m.lastRecalledAt,
    recallCount: m.recallCount,
    channelId: m.channelId,
    hasEmbedding: m.embedding !== null,
  };
}

function readSettings(deps: PeopleToolDeps, personId: string): PersonSettings {
  const scope = `user:${personId}`;
  const s = deps.repos.settings;
  return {
    memoryEnabled: s.getBool(scope, 'memory_enabled', true),
    ttsEnabled: s.getBool(scope, 'tts_enabled', true),
    voiceEnabled: s.getBool(scope, 'voice_enabled', true),
  };
}

function personView(deps: PeopleToolDeps, rm: RelationshipManager, personId: string, full: boolean): PersonView {
  const user = deps.repos.users.get(personId);
  const rel = deps.repos.relationships.get(personId);
  const view: PersonView = {
    personId,
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    isOwner: user?.isOwner ?? personId === deps.ownerId,
    firstSeenAt: user?.firstSeenAt ?? null,
    lastSeenAt: user?.lastSeenAt ?? null,
    relationship: rel,
    description: rm.describeForPrompt(rel ?? { ...DEFAULT_RELATIONSHIP, personId, updatedAt: nowOf(deps)() }),
    memoryCount: deps.repos.memories.countActive(personId),
  };
  if (full) {
    view.stats = deps.repos.stats.totals(personId);
    view.settings = readSettings(deps, personId);
  }
  return view;
}

/** Люди из всех трёх источников: пользователи, отношения, записи памяти. */
function knownPersonIds(deps: PeopleToolDeps): string[] {
  const ids = new Set<string>();
  for (const u of deps.repos.users.all()) ids.add(u.id);
  for (const r of deps.repos.relationships.all()) ids.add(r.personId);
  for (const id of deps.repos.memories.distinctPersonIds()) ids.add(id);
  return [...ids];
}

function globalMemories(deps: PeopleToolDeps, limit: number): MemoryView[] {
  return deps.repos.memories.listActive({ personIds: [null], limit }).map(toMemoryView);
}

// ---------- Действия ----------

function list(deps: PeopleToolDeps): PeopleResult {
  const rm = relationshipsOf(deps);
  const people = knownPersonIds(deps)
    .map((id) => personView(deps, rm, id, false))
    .sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      const seen = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      if (seen !== 0) return seen;
      return (a.displayName || a.personId).localeCompare(b.displayName || b.personId, 'ru');
    });
  return { ok: true, people, globalMemories: deps.repos.memories.countActive(null) };
}

function get(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const limit = nonNegInt(payload.limit, 500, 5000);
  if (payload.personId === null) {
    return { ok: true, person: null, memories: globalMemories(deps, limit) };
  }
  const personId = str(payload.personId, 64);
  if (!personId) return fail('нужен personId (или null для общих записей)');
  const rm = relationshipsOf(deps);
  return {
    ok: true,
    person: personView(deps, rm, personId, true),
    memories: deps.repos.memories.forPerson(personId).map(toMemoryView),
  };
}

/**
 * Отношения правятся ТОЧЕЧНО: присланное поле заменяется, неприсланное остаётся как было.
 * Числа 0..1 зажимаются, счётчики — целые ≥ 0.
 */
function applyRelationshipPatch(deps: PeopleToolDeps, personId: string, patch: RelationshipPatch): RelationshipState {
  const rel = deps.repos.relationships.getOrDefault(personId);
  for (const dim of ['familiarity', 'trust', 'closeness', 'respect', 'affection'] as const) {
    if (patch[dim] !== undefined) rel[dim] = clamp01(patch[dim], rel[dim]);
  }
  if (patch.sharedXp !== undefined) rel.sharedXp = nonNegInt(patch.sharedXp, rel.sharedXp, 9999);
  if (patch.interactions !== undefined) rel.interactions = nonNegInt(patch.interactions, rel.interactions);
  if (patch.summary !== undefined) rel.summary = String(patch.summary ?? '').trim().slice(0, MAX_SUMMARY);
  rel.updatedAt = nowOf(deps)();
  deps.repos.relationships.upsert(rel);
  return rel;
}

function createPerson(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const personId = str(payload.personId, 64) ?? newId('person');
  if (!/^[\w.:-]{1,64}$/u.test(personId)) {
    return fail('ID человека: только буквы, цифры, _ . : - (до 64 символов)');
  }
  const displayName = str(payload.displayName, MAX_NAME);
  const username = str(payload.username, MAX_NAME);
  if (!displayName && !username) {
    return fail('нужно имя: заполните «Как зовут» (или username)');
  }

  // тот же путь, что и у бота: пользователь + отношения (для владельца — «старый знакомый»)
  relationshipsOf(deps).ensure({ id: personId, username: username ?? undefined, displayName: displayName ?? undefined });
  if (payload.relationship) applyRelationshipPatch(deps, personId, payload.relationship);
  return get(deps, { personId });
}

function updatePerson(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const personId = str(payload.personId, 64);
  if (!personId) return fail('нужен personId');
  if (!deps.repos.users.get(personId)) return fail('такого человека нет — добавьте его через «Добавить человека»');

  const username = typeof payload.username === 'string' ? payload.username.trim().slice(0, MAX_NAME) : undefined;
  const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim().slice(0, MAX_NAME) : undefined;
  if (username !== undefined || displayName !== undefined) {
    deps.repos.users.upsert({ id: personId, username, displayName });
  }
  if (payload.relationship) applyRelationshipPatch(deps, personId, payload.relationship);
  return get(deps, { personId });
}

function deletePerson(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const personId = str(payload.personId, 64);
  if (!personId) return fail('нужен personId');
  const known = !!deps.repos.users.get(personId) || !!deps.repos.relationships.get(personId);
  const before = deps.repos.memories.countActive(personId);
  if (!known && before === 0) return fail('такого человека нет');

  const withMemories = payload.deleteMemories !== false;
  const deletedMemories = withMemories ? deps.repos.memories.deleteByPerson(personId) : 0;
  deps.repos.db.transaction(() => {
    deps.repos.relationships.remove(personId);
    deps.repos.users.remove(personId);
  });
  return { ok: true, personId, deletedMemories, deleted: true };
}

/** «Забыть всё о человеке»: записи и отношения стираются, сам человек остаётся в списке. */
function wipePerson(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const personId = str(payload.personId, 64);
  if (!personId) return fail('нужен personId');
  const deletedMemories = deps.repos.memories.deleteByPerson(personId);
  deps.repos.relationships.remove(personId);
  return { ok: true, personId, deletedMemories, deleted: true };
}

function setSetting(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const personId = str(payload.personId, 64);
  if (!personId) return fail('нужен personId');
  const key = String(payload.key ?? '');
  if (!(PERSON_SETTING_KEYS as readonly string[]).includes(key)) {
    return fail(`неизвестная настройка: ${key || '(нет)'} (доступны ${PERSON_SETTING_KEYS.join(', ')})`);
  }
  if (typeof payload.value !== 'boolean') return fail('нужно value: true или false');
  deps.repos.settings.set(`user:${personId}`, key, String(payload.value));
  return { ok: true, personId, settings: readSettings(deps, personId) };
}

async function embedText(deps: PeopleToolDeps, text: string): Promise<Float32Array | null> {
  if (!deps.embeddings) return null;
  try {
    const [v] = await deps.embeddings.embed([text]);
    return v ?? null;
  } catch {
    return null;
  }
}

/** Новая запись. Идёт через MemoryManager: эмбеддинг + дедупликация работают как у бота. */
async function addMemory(deps: PeopleToolDeps, payload: PeoplePayload): Promise<PeopleResult> {
  if (!('personId' in payload)) return fail('нужен personId (или null для общей записи)');
  const personId = payload.personId === null ? null : str(payload.personId, 64);
  if (payload.personId !== null && !personId) return fail('personId должен быть строкой или null');

  const patch = payload.memory ?? {};
  const content = str(patch.content, MAX_CONTENT);
  if (!content || content.length < 3) return fail('текст записи: минимум 3 символа');

  const mm = new MemoryManager(deps.repos.memories, deps.embeddings ?? null, {
    enabled: true,
    dedupeSimilarity: deps.dedupeSimilarity ?? 0.9,
  });
  const res = await mm.store({
    kind: normalizeKind(patch.kind),
    content,
    personId,
    objectiveFacts: patch.objectiveFacts === undefined ? [] : normalizeFacts(patch.objectiveFacts),
    subjective: toSubjective(patch, null),
    emotion: str(patch.emotion, 40),
    emotionIntensity: clamp01(patch.emotionIntensity),
    // записанное владельцем — не домысел модели: важность по умолчанию «заметное», уверенность высокая
    importance: patch.importance === undefined ? 0.5 : clamp01(patch.importance, 0.5),
    confidence: patch.confidence === undefined ? 0.95 : clamp01(patch.confidence, 0.95),
  });
  if (res.action === 'skipped') return fail(`запись не сохранена: ${res.reason}`);

  const rec = deps.repos.memories.get(res.id);
  return {
    ok: true,
    stored: res.action,
    personId: personId ?? '',
    ...(rec ? { memory: toMemoryView(rec) } : {}),
  };
}

async function updateMemory(deps: PeopleToolDeps, payload: PeoplePayload): Promise<PeopleResult> {
  const id = str(payload.memoryId, 64);
  if (!id) return fail('нужен memoryId');
  const rec = deps.repos.memories.get(id);
  if (!rec) return fail('такой записи нет (или уже удалена)');

  const patch = payload.memory ?? {};
  const update: Parameters<MemoriesRepo['updateContent']>[1] = {};
  let contentChanged = false;

  if (patch.content !== undefined) {
    const content = str(patch.content, MAX_CONTENT);
    if (!content || content.length < 3) return fail('текст записи: минимум 3 символа');
    update.content = content;
    contentChanged = content !== rec.content;
  }
  if (patch.kind !== undefined) update.kind = normalizeKind(patch.kind);
  if (patch.importance !== undefined) update.importance = clamp01(patch.importance, rec.importance);
  if (patch.confidence !== undefined) update.confidence = clamp01(patch.confidence, rec.confidence);
  if (patch.emotion !== undefined) update.emotion = str(patch.emotion, 40);
  if (patch.emotionIntensity !== undefined) update.emotionIntensity = clamp01(patch.emotionIntensity, rec.emotionIntensity);
  if (patch.objectiveFacts !== undefined) update.objectiveFacts = normalizeFacts(patch.objectiveFacts);
  if (patch.opinion !== undefined || patch.emotion !== undefined || patch.emotionIntensity !== undefined) {
    update.subjective = toSubjective(patch, rec.subjective);
  }
  // текст изменился — старый вектор больше не описывает запись
  if (contentChanged && deps.embeddings) {
    const embedding = await embedText(deps, update.content!);
    if (embedding) update.embedding = embedding;
  }

  deps.repos.memories.updateContent(id, update);
  const fresh = deps.repos.memories.get(id);
  return { ok: true, personId: rec.personId ?? '', ...(fresh ? { memory: toMemoryView(fresh) } : {}) };
}

function deleteMemory(deps: PeopleToolDeps, payload: PeoplePayload): PeopleResult {
  const id = str(payload.memoryId, 64);
  if (!id) return fail('нужен memoryId');
  if (!deps.repos.memories.delete(id)) return fail('такой записи нет (или уже удалена)');
  return { ok: true, deleted: true };
}

/** Единая точка входа: действие + аргументы → результат. Ошибки входа — не исключения. */
export async function runPeopleAction(
  deps: PeopleToolDeps,
  action: string,
  payload: PeoplePayload = {},
): Promise<PeopleResult> {
  switch (action) {
    case 'list':
      return list(deps);
    case 'get':
      return get(deps, payload);
    case 'createPerson':
      return createPerson(deps, payload);
    case 'updatePerson':
      return updatePerson(deps, payload);
    case 'deletePerson':
      return deletePerson(deps, payload);
    case 'wipePerson':
      return wipePerson(deps, payload);
    case 'setSetting':
      return setSetting(deps, payload);
    case 'addMemory':
      return addMemory(deps, payload);
    case 'updateMemory':
      return updateMemory(deps, payload);
    case 'deleteMemory':
      return deleteMemory(deps, payload);
    default:
      return fail(`неизвестное действие: ${action || '(нет)'} (доступны ${PEOPLE_ACTIONS.join(', ')})`);
  }
}

async function readStdinJson(): Promise<PeoplePayload> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as PeoplePayload;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const action = process.argv.find((a) => a.startsWith('--action='))?.slice('--action='.length) ?? 'list';
  const payload = await readStdinJson();

  const { loadConfig } = await import('../config/index.js');
  const cfg = loadConfig();
  const db = Database.open(cfg.db.path);
  // панель и работающий бот пишут в одну базу (WAL): ждём блокировку вместо SQLITE_BUSY
  db.raw.exec('PRAGMA busy_timeout = 5000;');
  try {
    // эмбеддинги только с настоящим ключом: мок-векторы испортили бы семантический поиск
    const embeddings = cfg.embeddings.apiKey && cfg.llm.provider !== 'mock' ? createProviders(cfg).embeddings : null;
    const result = await runPeopleAction(
      {
        repos: createRepositories(db),
        embeddings,
        ownerId: cfg.discord.ownerId,
        dedupeSimilarity: cfg.memory.dedupeSimilarity,
      },
      action,
      payload,
    );
    console.log(`${RESULT_MARKER}${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`${RESULT_MARKER}${JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) } satisfies PeopleResult)}`);
    process.exitCode = 1;
  });
}
