import type { MemoriesRepo } from '../../storage/index.js';
import { tokenizeForSearch } from '../../storage/index.js';
import type { EmbeddingProvider } from '../../ai/types.js';
import type { MemoryRecord, RetrievedMemory } from '../types.js';
import { clampCos, cosine } from './memory-manager.js';

/**
 * Memory Retrieval (ТЗ §16–17): перед ответом ищем ТОЛЬКО релевантные записи.
 *
 * Ранжирование: semantic relevance × person boost × recency × importance ×
 * emotional significance × recall count (веса из конфига).
 *
 * Отказоустойчивость: embeddings недоступны/упали → деградация до keyword-ранжирования;
 * retrieval НИКОГДА не блокирует ответ дольше одного embeddings-вызова с таймаутом.
 */

export interface RetrievalWeights {
  semantic: number;
  recency: number;
  importance: number;
  emotion: number;
  recall: number;
  personBoost: number;
}

export interface RetrievalOptions {
  mode: 'hybrid' | 'keyword' | 'semantic';
  topK: number;
  minScore: number;
  recencyHalfLifeDays: number;
  weights: RetrievalWeights;
  /** Лимит кандидатов, загружаемых из БД за раз. */
  candidateLimit?: number;
}

export interface RetrieveArgs {
  query: string;
  personId: string | null;
  limit?: number;
  signal?: AbortSignal;
  now?: number;
}

const DAY_MS = 86400_000;

export class MemoryRetrieval {
  constructor(
    private repo: MemoriesRepo,
    private embeddings: EmbeddingProvider | null,
    private opts: RetrievalOptions,
  ) {}

  async retrieve(args: RetrieveArgs): Promise<RetrievedMemory[]> {
    const now = args.now ?? Date.now();
    const topK = Math.max(1, args.limit ?? this.opts.topK);

    // кандидаты: памяти этого человека + общие (о мире/о себе)
    const candidates = this.repo.listActive({
      personIds: [args.personId, null],
      limit: this.opts.candidateLimit ?? 1500,
    });
    if (candidates.length === 0) return [];

    // семантика (не более ОДНОГО внешнего вызова; провал → 0)
    let queryVec: Float32Array | null = null;
    if (this.opts.mode !== 'keyword' && this.embeddings) {
      try {
        const [v] = await this.embeddings.embed([args.query], args.signal);
        queryVec = v ?? null;
      } catch {
        queryVec = null;
      }
    }

    // keyword-подсветка: токены запроса + результаты FTS/LIKE-поиска
    const tokens = tokenizeForSearch(args.query);
    const keywordHits = new Set<string>();
    if (this.opts.mode !== 'semantic' && tokens.length > 0) {
      try {
        for (const m of this.repo.keywordSearch(args.query, { personIds: [args.personId, null], limit: 30 })) {
          keywordHits.add(m.id);
        }
      } catch {
        // FTS-сбой не критичен — считаем overlap вручную ниже
      }
    }

    const scored: RetrievedMemory[] = [];
    for (const m of candidates) {
      const semantic = queryVec && m.embedding ? Math.max(0, clampCos(cosine(queryVec, m.embedding))) : 0;
      const overlap = tokens.length > 0 ? tokenOverlap(m.content, tokens) : 0;
      const keywordScore = keywordHits.has(m.id) ? Math.max(0.55, overlap * 0.9) : overlap * 0.7;

      let relevance: number;
      if (this.opts.mode === 'semantic') relevance = semantic;
      else if (this.opts.mode === 'keyword') relevance = keywordScore;
      else relevance = Math.max(semantic, keywordScore);

      const recency = Math.pow(0.5, Math.max(0, now - m.createdAt) / DAY_MS / Math.max(0.5, this.opts.recencyHalfLifeDays));
      const importance = m.importance;
      const emotion = Math.min(1, m.emotionIntensity * 0.7 + (m.subjective ? 0.3 : 0));
      const recall = Math.min(1, m.recallCount / 5);
      const personBoost = m.personId && m.personId === args.personId ? this.opts.weights.personBoost : 1;

      const w = this.opts.weights;
      const base =
        w.semantic * relevance +
        w.recency * recency +
        w.importance * importance +
        w.emotion * emotion +
        w.recall * recall;
      const score = base * personBoost;

      if (score < this.opts.minScore) continue;
      scored.push({ memory: m, score, components: { semantic, recency, importance, emotion, recall, personBoost } });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

function tokenOverlap(content: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = content.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (lower.includes(t)) hits++;
  return hits / tokens.length;
}
