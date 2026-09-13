import type { LLMProvider } from '../../ai/types.js';
import type { SummariesRepo } from '../../storage/index.js';
import type { SessionMessage } from '../../core/conversation/session.js';
import { LUNA_BACKGROUND_PERSONALITY } from '../../luna/personality/core.js';
import { truncate } from '../../utils/text.js';

/**
 * Суммаризация разговора (ТЗ §11): при переполнении short-буфера старые
 * сообщения не выбрасываются, а сжимаются в summary канала.
 * Предыдущее summary учитывается (инкрементальное сжатие).
 */

export class ConversationSummarizer {
  constructor(
    private llm: LLMProvider,
    private summaries: SummariesRepo,
    private opts: { backgroundModel: string; maxInputMessages?: number },
  ) {}

  async summarizeChannel(channelId: string, messages: SessionMessage[], signal?: AbortSignal): Promise<string | null> {
    if (messages.length === 0) return null;
    const max = this.opts.maxInputMessages ?? 80;
    const slice = messages.slice(-max);
    const periodStart = slice[0]!.at;
    const periodEnd = slice[slice.length - 1]!.at;

    const prev = this.summaries.latest(channelId, 1);
    const prevText = prev.length > 0 ? `Предыдущее краткое содержание:\n${prev[0]!.summary}\n\n` : '';

    const transcript = slice
      .map((m) => {
        const who = m.role === 'assistant' ? 'Luna' : (m.authorName ?? 'Кто-то');
        return `${who}: ${truncate(m.content, 400)}`;
      })
      .join('\n');

    const res = await this.llm.generate(
      [
        { role: 'system', content: LUNA_BACKGROUND_PERSONALITY },
        {
          role: 'user',
          content:
            `${prevText}Сожми продолжение разговора в 3-6 предложений на русском. ` +
            `Сохрани: кто о чём рассказывал, важные события, обещания, незакрытые темы, эмоциональные моменты. ` +
            `Фактами считаются только слова и действия собеседника: то, что Luna рассказала о себе, своих вкусах ` +
            `или о совместном прошлом, в содержание не переноси — она могла это выдумать на ходу. ` +
            `Пиши связным текстом от третьего лица, простыми предложениями, без списков и заголовков.\n\n` +
            `Транскрипт:\n${truncate(transcript, 12000)}`,
        },
      ],
      { model: this.opts.backgroundModel, temperature: 0.3, maxTokens: 350, signal },
    );

    const summary = res.text.trim();
    if (!summary) return null;
    this.summaries.insert({ channelId, periodStart, periodEnd, summary });
    return summary;
  }
}
