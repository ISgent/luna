import type { RelationshipsRepo, UsersRepo } from '../../storage/index.js';
import { DEFAULT_RELATIONSHIP } from '../../storage/index.js';
import type { RelationshipState } from '../types.js';

/**
 * Отношения Luna с каждым человеком (ТЗ §7–9, §31).
 *
 * - Числа — внутреннее представление; для LLM формируется естественное описание.
 * - Изменения плавные: дельта события ограничена и проходит через логистику
 *   (чем ближе к грани, тем труднее её сдвинуть). Один разговор ≠ trust 100.
 * - С владельцем отношения стартуют как «давно знакомы» (preseed), но история
 *   всё равно пишется в БД и развивается на общих основаниях.
 */

export interface RelationshipDeltas {
  trust?: number;
  closeness?: number;
  affection?: number;
  respect?: number;
  sharedXpAdd?: number;
  /** Фоновая модель может переписать естественное описание отношений. */
  summary?: string;
}

/** Ограничение дельты одного события для 0..1-измерений. */
export const MAX_REL_DELTA_PER_EVENT = 0.12;

export interface RelationshipManagerOptions {
  ownerId?: string;
  seedOwnerRelationship?: boolean;
  now?: () => number;
}

export const OWNER_SEED: Omit<RelationshipState, 'personId' | 'updatedAt'> = {
  familiarity: 0.8,
  trust: 0.72,
  closeness: 0.65,
  respect: 0.6,
  affection: 0.6,
  // 0: значимые совместные события считаются только из реально записанной памяти.
  // Сид «старого знакомого» делается через familiarity/trust/closeness, а не через
  // выдуманный счётчик — иначе промпт заявлял о шести общих событиях, которых в памяти
  // нет, и модель их сочиняла.
  sharedXp: 0,
  interactions: 25,
  // Никакой придуманной совместной истории: общие события берутся только
  // из записей памяти, иначе модель начинает сочинять «а помнишь, как мы…».
  summary:
    'Они хорошие приятели, и Luna говорит с ним свободно, без лишней вежливости: может шутить, подкалывать, спорить и не соглашаться. Конкретных общих событий она не припоминает — если их нет в записях памяти, значит, их не было.',
};

export class RelationshipManager {
  constructor(
    private users: UsersRepo,
    private relationships: RelationshipsRepo,
    private opts: RelationshipManagerOptions = {},
  ) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  /**
   * Гарантирует наличие пользователя и отношений.
   * Для владельца при первом контакте — preseed «старый знакомый».
   */
  ensure(person: { id: string; username?: string; displayName?: string; isOwner?: boolean }): RelationshipState {
    const isOwner = person.isOwner ?? person.id === this.opts.ownerId;
    this.users.upsert({ id: person.id, username: person.username, displayName: person.displayName, isOwner });
    let rel = this.relationships.get(person.id);
    if (!rel) {
      rel = { ...DEFAULT_RELATIONSHIP, personId: person.id, updatedAt: this.now() };
      if (isOwner && this.opts.seedOwnerRelationship !== false) {
        rel = { ...rel, ...OWNER_SEED };
      }
      this.relationships.upsert(rel);
    }
    return rel;
  }

  get(personId: string): RelationshipState {
    return this.relationships.getOrDefault(personId);
  }

  /**
   * ensure + подсчёт взаимодействия одним вызовом (горячий путь):
   * familiarity растёт от частоты и длительности знакомства.
   */
  ensureAndCount(person: { id: string; username?: string; displayName?: string; isOwner?: boolean }): RelationshipState {
    const rel = this.ensure(person);
    const user = this.users.get(person.id);
    return this.recordInteraction(person.id, user?.firstSeenAt ?? rel.updatedAt);
  }

  /** +1 взаимодействие, пересчёт familiarity по длительности и частоте. */
  recordInteraction(personId: string, firstSeenAt?: number): RelationshipState {
    const rel = this.relationships.getOrDefault(personId);
    rel.interactions += 1;
    // familiarity монотонно не убывает: preseed «старого знакомого» не сбрасывается формулой
    rel.familiarity = Math.max(rel.familiarity, this.computeFamiliarity(rel.interactions, firstSeenAt ?? rel.updatedAt));
    rel.updatedAt = this.now();
    this.relationships.upsert(rel);
    return rel;
  }

  private computeFamiliarity(interactions: number, firstSeenAt: number): number {
    const interactionPart = 1 - Math.exp(-interactions / 40);
    const days = Math.max(0, (this.now() - firstSeenAt) / 86400_000);
    const daysPart = Math.min(1, days / 60);
    return Math.max(0, Math.min(1, 0.8 * interactionPart + 0.2 * daysPart));
  }

  /**
   * Плавное изменение отношений. Дельты ограничиваются MAX_REL_DELTA_PER_EVENT
   * и масштабируются логистикой: positive * (1-cur), negative * cur.
   */
  applyDeltas(personId: string, deltas: RelationshipDeltas): RelationshipState {
    const rel = this.relationships.getOrDefault(personId);
    for (const dim of ['trust', 'closeness', 'affection', 'respect'] as const) {
      const d = deltas[dim];
      if (d === undefined || !Number.isFinite(d)) continue;
      const clamped = Math.max(-MAX_REL_DELTA_PER_EVENT, Math.min(MAX_REL_DELTA_PER_EVENT, d));
      const cur = rel[dim];
      const effective = clamped > 0 ? clamped * (1 - cur) : clamped * cur;
      rel[dim] = Math.max(0, Math.min(1, cur + effective));
    }
    if (deltas.sharedXpAdd && Number.isFinite(deltas.sharedXpAdd)) {
      rel.sharedXp += Math.max(0, Math.min(3, Math.round(deltas.sharedXpAdd)));
    }
    if (deltas.summary && deltas.summary.trim().length > 0) {
      rel.summary = deltas.summary.trim().slice(0, 1200);
    }
    rel.updatedAt = this.now();
    this.relationships.upsert(rel);
    return rel;
  }

  /**
   * Естественное описание отношений для промпта (ТЗ §7):
   * не числа, а человеческая формулировка + сохранённый summary.
   */
  describeForPrompt(rel: RelationshipState): string {
    const sentences: string[] = [];

    if (rel.interactions === 0 || rel.familiarity < 0.08) {
      sentences.push('Luna почти не знает этого человека — это первый (или один из первых) контактов.');
    } else if (rel.familiarity < 0.3) {
      sentences.push('Luna знает этого человека пока поверхностно, они общались всего несколько раз.');
    } else if (rel.familiarity < 0.6) {
      sentences.push('Luna уже неплохо знает этого человека, они общались не один раз.');
    } else {
      sentences.push('Luna давно знает этого человека и хорошо привыкла к его манере общения.');
    }

    if (rel.trust > 0.7) sentences.push('Она ему доверяет.');
    else if (rel.trust < 0.25 && rel.interactions > 3) sentences.push('Она к нему насторожена — доверия пока мало.');

    if (rel.affection > 0.65) sentences.push('Он ей по-человечески нравится.');
    else if (rel.affection < 0.2 && rel.interactions > 5) sentences.push('Отношение к нему скорее прохладное.');

    if (rel.respect < 0.25 && rel.interactions > 5) sentences.push('Уважения к нему у неё немного — было за что.');
    else if (rel.respect > 0.7) sentences.push('Она его уважает.');

    // Число — не приглашение сочинять: что именно было, видно только в записях памяти.
    if (rel.sharedXp > 0) {
      sentences.push(`У них за плечами ${rel.sharedXp} значимых совместных ${pluralEvents(rel.sharedXp)}. Что именно — видно в записях памяти; чего там нет, того не было.`);
    }

    if (rel.summary.trim()) sentences.push(rel.summary.trim());

    return sentences.join(' ');
  }
}

/** Русское склонение слова «событие» под число: 1 событие, 2 события, 5 событий. */
function pluralEvents(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return 'событие';
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'события';
  return 'событий';
}
