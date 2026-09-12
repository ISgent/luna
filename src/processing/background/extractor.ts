import { z } from 'zod';
import type { LLMProvider } from '../../ai/types.js';
import { LUNA_BACKGROUND_PERSONALITY } from '../../luna/personality/core.js';

/**
 * BackgroundExtractor: ОДИН structured-вызов фоновой модели на обмен
 * репликами. Извлекает сразу всё (ТЗ §16):
 *   памяти (objective + subjective + emotion) + дельты отношений + дельты эмоций.
 *
 * Никаких 4–5 отдельных AI-запросов «на каждую мелочь».
 * Работает ТОЛЬКО в фоне — горячий путь ответа от него не зависит.
 */

const subjectiveSchema = z.object({
  opinion: z.string(),
  emotion: z.string(),
  intensity: z.number().min(0).max(1),
});

const memoryCandidateSchema = z.object({
  kind: z.enum(['fact', 'preference', 'event', 'joke', 'promise', 'open_thread', 'impression']),
  content: z.string().min(3),
  objectiveFacts: z.array(z.string()).optional(),
  subjective: subjectiveSchema.optional(),
  emotion: z.string().optional(),
  emotionIntensity: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
  dedupeKey: z.string().optional(),
});

const delta = (max: number) => z.number().min(-max).max(max).optional();

export const extractionSchema = z.object({
  memories: z.array(memoryCandidateSchema).max(6),
  relationshipDelta: z
    .object({
      trust: delta(0.3),
      closeness: delta(0.3),
      affection: delta(0.3),
      respect: delta(0.3),
      sharedXpAdd: z.number().int().min(0).max(2).optional(),
      summary: z.string().max(600).optional(),
    })
    .optional(),
  emotionDeltas: z
    .object({
      mood: delta(0.3),
      energy: delta(0.3),
      playfulness: delta(0.3),
      irritation: delta(0.3),
      warmth: delta(0.3),
      socialEnergy: delta(0.3),
    })
    .optional(),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

export interface ExtractInput {
  personName: string;
  isOwner: boolean;
  userMessage: string;
  lunaReply: string;
  relationshipDescription: string;
  emotionDescription: string;
}

const PROMPT_RULES = `Извлеки из обмена репликами:

1. "memories" — только ЗНАЧИМОЕ: факты о человеке, его предпочтения, важные или совместные события, обещания, незакрытые темы ("а как там твой ремонт?"), повторяющиеся шутки, впечатления Luna. Пустую болтовню и разовые реплики НЕ сохранять. Поля:
   - kind: fact|preference|event|joke|promise|open_thread|impression
   - content: одна естественная фраза на русском (от третьего лица: "Gent любит…", "Gent помог Luna…")
   - objectiveFacts: что произошло ОБЪЕКТИВНО (массив коротких фактов)
   - subjective: впечатление Luna {opinion, emotion, intensity 0..1} — только если впечатление реально есть
   - emotion + emotionIntensity: эмоция СОБЫТИЯ (не текущее настроение Luna)
   - importance: 0.1-0.3 бытовое, 0.4-0.6 заметное, 0.7+ значимое событие
   - confidence: 0..1 насколько это точно следует из разговора
   - dedupeKey: короткий ключ темы "вид:тема" латиницей (например "pref:stalker", "event:server-setup"). Одинаковая тема = одинаковый ключ (система сливает дубликаты).

2. "relationshipDelta" — как обмен СЛЕГКА сдвинул отношение Luna (trust/closeness/affection/respect в пределах ±0.1 каждое; sharedXpAdd=1 только если было значимое совместное событие; summary — обновлённое описание отношений в 1-3 предложениях, ТОЛЬКО если появилось реально новое). Изменения ПЛАВНЫЕ: один разговор не делает лучшим другом, одна ссора не обнуляет доверие.

3. "emotionDeltas" — как изменилось ТЕКУЩЕЕ состояние Luna после обмена (mood/energy/playfulness/irritation/warmth/socialEnergy, каждое ±0.15). Спокойный разговор = почти нулевые дельты.

Если сохранять нечего — верни пустые массивы/объекты, но валидный JSON.`;

export class BackgroundExtractor {
  constructor(
    private llm: LLMProvider,
    private opts: { backgroundModel: string; maxTokens?: number; timeoutMs?: number },
  ) {}

  async extract(input: ExtractInput, signal?: AbortSignal): Promise<ExtractionResult | null> {
    const userPrompt = [
      PROMPT_RULES,
      '',
      '# Текущий контекст',
      `Собеседник: ${input.personName}${input.isOwner ? ' (старый знакомый Luna)' : ''}`,
      `Отношения сейчас: ${input.relationshipDescription}`,
      `Состояние Luna сейчас: ${input.emotionDescription}`,
      '',
      '# Обмен репликами',
      `${input.personName}: ${input.userMessage}`,
      `Luna: ${input.lunaReply}`,
    ].join('\n');

    const result = await this.llm.generateStructured(
      [
        { role: 'system', content: LUNA_BACKGROUND_PERSONALITY },
        { role: 'user', content: userPrompt },
      ],
      {
        schema: extractionSchema,
        model: this.opts.backgroundModel,
        temperature: 0.2,
        maxTokens: this.opts.maxTokens ?? 800,
        timeoutMs: this.opts.timeoutMs,
        signal,
      },
    );

    if (!result.ok) return null;
    return result.value;
  }
}
