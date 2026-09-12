import { z } from 'zod';
import type { MemoriesRepo } from '../../storage/index.js';
import type { LLMProvider } from '../../ai/types.js';
import type { MemoryRecord } from '../types.js';
import { newId } from '../../utils/ids.js';

/**
 * Консолидация памяти (ТЗ §35): старые МЕЛКИЕ памяти сливаются в обобщённую
 * запись. Важные события (importance ≥ protectImportance) не трогаются.
 * Оригиналы помечаются merged (не удаляются) — история не теряется.
 *
 * Запускается из фонового планировщика, использует ФОНОВУЮ (более умную) модель.
 */

const consolidationSchema = z.object({
  summary: z.string().min(10),
  importance: z.number().min(0).max(1),
});

export interface ConsolidatorOptions {
  backgroundModel: string;
  minCluster: number;
  protectImportance: number;
}

export interface ConsolidationResult {
  personId: string;
  clustersMerged: number;
  memoriesMerged: number;
}

export class MemoryConsolidator {
  constructor(
    private repo: MemoriesRepo,
    private llm: LLMProvider,
    private opts: ConsolidatorOptions,
  ) {}

  /** Консолидация по одному человеку. */
  async runForPerson(personId: string, signal?: AbortSignal): Promise<ConsolidationResult> {
    const items = this.repo.listConsolidatable(personId, this.opts.protectImportance);
    if (items.length < this.opts.minCluster) {
      return { personId, clustersMerged: 0, memoriesMerged: 0 };
    }

    // кластеризация по префиксу dedupe_key (тема) или по kind
    const clusters = new Map<string, MemoryRecord[]>();
    for (const m of items) {
      const key = m.dedupeKey ? m.dedupeKey.split(':')[0]! : `kind:${m.kind}`;
      const list = clusters.get(key) ?? [];
      list.push(m);
      clusters.set(key, list);
    }

    let clustersMerged = 0;
    let memoriesMerged = 0;
    for (const group of clusters.values()) {
      if (group.length < this.opts.minCluster) continue;
      const ok = await this.mergeCluster(personId, group, signal);
      if (ok) {
        clustersMerged++;
        memoriesMerged += group.length;
      }
    }
    return { personId, clustersMerged, memoriesMerged };
  }

  private async mergeCluster(personId: string, group: MemoryRecord[], signal?: AbortSignal): Promise<boolean> {
    const list = group
      .map(
        (m, i) =>
          `${i + 1}. [${m.kind}] ${m.content}` +
          (m.subjective ? ` (впечатление Luna: ${m.subjective.opinion}, ${m.subjective.emotion})` : '') +
          (m.emotion ? ` (эмоция: ${m.emotion} ${m.emotionIntensity.toFixed(1)})` : ''),
      )
      .join('\n');

    const result = await this.llm.generateStructured(
      [
        {
          role: 'user',
          content:
            `Объедини следующие записи памяти Luna об одном человеке в ОДНУ общую запись. ` +
            `Сохрани все значимые факты и впечатления, ничего не выдумывай. ` +
            `Формулируй от третьего лица о человеке и о Luna ("Gent любит…", "Luna и Gent часто…").\n\n${list}`,
        },
      ],
      { schema: consolidationSchema, model: this.opts.backgroundModel, maxTokens: 400, signal },
    );
    if (!result.ok) return false;

    const importance = Math.min(
      this.opts.protectImportance,
      Math.max(result.value.importance, Math.max(...group.map((m) => m.importance))),
    );
    const merged = this.repo.insert({
      id: newId('mem'),
      personId,
      kind: 'consolidated',
      content: result.value.summary,
      objectiveFacts: group.flatMap((m) => m.objectiveFacts),
      importance,
      confidence: Math.max(...group.map((m) => m.confidence)),
      dedupeKey: `consolidated:${group[0]!.dedupeKey?.split(':')[0] ?? group[0]!.kind}`,
      createdAt: Date.now(),
    });
    this.repo.markMerged(
      group.map((m) => m.id),
      merged.id,
    );
    return true;
  }

  /** Консолидация по всем людям с достаточным числом мелочи. */
  async runAll(personIds: string[], signal?: AbortSignal): Promise<ConsolidationResult[]> {
    const results: ConsolidationResult[] = [];
    for (const pid of personIds) {
      if (signal?.aborted) break;
      try {
        results.push(await this.runForPerson(pid, signal));
      } catch {
        // фон не должен падать целиком из-за одного человека
      }
    }
    return results;
  }
}
