import type { MemoriesRepo } from '../../storage/index.js';
import type { EmbeddingProvider } from '../../ai/types.js';
import type { MemoryKind, MemoryRecord, SubjectiveImpression } from '../types.js';
import { newId } from '../../utils/ids.js';

/**
 * MemoryManager — запись, дедупликация, обновление и удаление памятей.
 *
 * Дедупликация (ТЗ §34): повтор того же факта НЕ создаёт новую запись —
 * существующая усиливается (растёт confidence/importance, объединяются
 * объективные факты). Поиск дубля: по dedupe_key, затем по косинусной
 * близости эмбеддинга среди свежих памятей того же человека.
 */

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  objectiveFacts?: string[];
  subjective?: SubjectiveImpression | null;
  emotion?: string | null;
  emotionIntensity?: number;
  importance?: number;
  confidence?: number;
  personId?: string | null;
  dedupeKey?: string | null;
}

export interface StoreMeta {
  channelId?: string | null;
  sourceConversationId?: string | null;
}

export type StoreResult =
  | { action: 'created'; id: string }
  | { action: 'updated'; id: string }
  | { action: 'skipped'; reason: string };

export interface MemoryManagerOptions {
  enabled: boolean;
  dedupeSimilarity: number;
  /** Сколько свежих памятей человека сканировать на семантический дубль. */
  dedupeScanLimit?: number;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // векторы нормализованы провайдерами; на всякий случай зажимаем
}

export function clampCos(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

export class MemoryManager {
  constructor(
    private repo: MemoriesRepo,
    private embeddings: EmbeddingProvider | null,
    private opts: MemoryManagerOptions,
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Best-effort эмбеддинг: провал не блокирует запись памяти. */
  async embed(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
    if (!this.embeddings) return null;
    try {
      const [v] = await this.embeddings.embed([text], signal);
      return v ?? null;
    } catch {
      return null;
    }
  }

  async store(candidate: MemoryCandidate, meta: StoreMeta = {}, signal?: AbortSignal): Promise<StoreResult> {
    if (!this.opts.enabled) return { action: 'skipped', reason: 'memory disabled' };
    const content = candidate.content.trim();
    if (!content) return { action: 'skipped', reason: 'empty content' };

    const personId = candidate.personId ?? null;
    const embedding = await this.embed(content, signal);

    // 1) dedupe по явному ключу
    let dup: MemoryRecord | null = null;
    if (candidate.dedupeKey) {
      const byKey = this.repo.findDedupeCandidates(personId, candidate.dedupeKey);
      dup = byKey[0] ?? null;
    }

    // 2) dedupe по семантике среди свежих памятей того же человека
    if (!dup && embedding) {
      const recent = this.repo.listActive({ personIds: [personId], limit: this.opts.dedupeScanLimit ?? 120 });
      let best = 0;
      for (const m of recent) {
        if (!m.embedding || m.kind === 'consolidated') continue;
        const sim = clampCos(cosine(embedding, m.embedding));
        if (sim > best) {
          best = sim;
          if (sim >= this.opts.dedupeSimilarity) dup = m;
        }
      }
    }

    if (dup) {
      this.reinforce(dup, candidate, embedding);
      return { action: 'updated', id: dup.id };
    }

    const rec = this.repo.insert({
      id: newId('mem'),
      personId,
      channelId: meta.channelId ?? null,
      kind: candidate.kind,
      content,
      objectiveFacts: candidate.objectiveFacts ?? [],
      subjective: candidate.subjective ?? null,
      emotion: candidate.emotion ?? null,
      emotionIntensity: clamp01(candidate.emotionIntensity ?? 0),
      importance: candidate.importance,
      confidence: candidate.confidence,
      embedding,
      dedupeKey: candidate.dedupeKey ?? null,
      sourceConversationId: meta.sourceConversationId ?? null,
    });
    return { action: 'created', id: rec.id };
  }

  /** Усиление существующей памяти вместо дубля. */
  private reinforce(dup: MemoryRecord, candidate: MemoryCandidate, embedding: Float32Array | null): void {
    const facts = [...new Set([...dup.objectiveFacts, ...(candidate.objectiveFacts ?? [])])];
    const strongerEmotion =
      (candidate.emotionIntensity ?? 0) > dup.emotionIntensity
        ? { emotion: candidate.emotion ?? dup.emotion, emotionIntensity: clamp01(candidate.emotionIntensity ?? 0) }
        : { emotion: dup.emotion, emotionIntensity: dup.emotionIntensity };
    this.repo.updateContent(dup.id, {
      objectiveFacts: facts,
      subjective: candidate.subjective ?? dup.subjective,
      importance: Math.min(1, Math.max(dup.importance, candidate.importance ?? 0) + 0.05),
      confidence: Math.min(1, Math.max(dup.confidence, candidate.confidence ?? 0.9) + 0.03),
      dedupeKey: dup.dedupeKey ?? candidate.dedupeKey ?? null,
      ...(embedding && !dup.embedding ? { embedding } : {}),
      ...strongerEmotion,
    });
  }

  recall(ids: string[]): void {
    this.repo.markRecalled(ids);
  }

  // ---------- Privacy / control (ТЗ §36) ----------

  listForUser(personId: string): MemoryRecord[] {
    return this.repo.forPerson(personId);
  }

  deleteMemory(id: string): boolean {
    return this.repo.delete(id);
  }

  forgetPerson(personId: string): number {
    return this.repo.deleteByPerson(personId);
  }

  countActive(personId?: string): number {
    return this.repo.countActive(personId);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
