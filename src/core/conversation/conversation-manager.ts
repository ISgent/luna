import type { LLMProvider, ToolCall } from '../../ai/types.js';
import type { Logger } from '../../logging/logger.js';
import { RequestTracer, Telemetry } from '../../logging/telemetry.js';
import type { StatsRepo } from '../../storage/index.js';
import { SentenceSplitter } from '../../utils/text.js';
import { isAbortError, sleep } from '../../utils/async.js';
import { newId } from '../../utils/ids.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { LunaEventBus } from '../events/bus.js';
import { PromptBuilder } from './prompt-builder.js';
import type { SessionStore } from './session.js';
import type { ToolExecContext, ToolRegistry } from './tools.js';
import type { MemoryManager } from '../../luna/memory/memory-manager.js';

/**
 * ConversationManager — дирижёр ГОРЯЧЕГО пути (ТЗ §16, §19, §50):
 *
 *   message → context (SQLite + ≤1 embeddings-вызов) → prompt → LLM stream
 *   → первое предложение СРАЗУ наружу → остаток стрима → response_completed
 *
 * Перед ответом ровно ОДИН LLM-вызов. Никаких memory-extraction/relationship/
 * emotion/summary АНАЛИЗОВ до ответа — всё это уходит в background через шину.
 */

export interface IncomingMessage {
  personId: string;
  personName: string;
  isOwner: boolean;
  channelId: string;
  channelKind: 'text' | 'voice' | 'dm';
  text: string;
  at: number;
  /** Текст цитируемого сообщения (Discord reply). */
  replyToText?: string;
  conversationId?: string;
  /** Сервер (для действий с голосом). */
  guildId?: string | null;
  /** Голосовой канал автора — куда заходить по «го в голос». */
  authorVoiceChannelId?: string | null;
  /** Пометка от quick-action: действие уже выполнено до модели. */
  actionNote?: string;
}

export interface ReplySink {
  /** Первый видимый фрагмент — Discord: отправить сообщение; voice: первый TTS. */
  onFirstSentence(sentence: string): Promise<void>;
  /** Каждое последующее законченное предложение (voice ставит его в TTS-очередь). */
  onSentence(sentence: string, index: number): Promise<void>;
  /** Приращение полного текста — текстовый sink сам троттлит edit-ы. */
  onProgress(fullText: string): Promise<void>;
  /** Поток завершён, текст окончательный. */
  onComplete(fullText: string): Promise<void>;
  /** Генерация отменена (регенерация с новым батчем) — sink подчищает UI. */
  onCancelled?(): Promise<void>;
  /** Ошибка генерации — sink решает, что показать (например, человеческое «я зависла»). */
  onError(error: unknown): Promise<void>;
}

export interface ConversationManagerDeps {
  sessions: SessionStore;
  context: ContextBuilder;
  prompts: PromptBuilder;
  llm: LLMProvider;
  bus: LunaEventBus;
  telemetry: Telemetry;
  memory: MemoryManager;
  stats?: StatsRepo;
  logger: Logger;
  llmModel: string;
  summaryTriggerMessages: number;
  /** Инструменты модели (tool calling). Пустой/не задан — обычный диалог. */
  tools?: ToolRegistry;
}

export interface HandleResult {
  ok: boolean;
  reply: string;
  requestId: string;
  error?: string;
}

export class ConversationManager {
  constructor(private deps: ConversationManagerDeps) {}

  async handle(msg: IncomingMessage, sink: ReplySink, opts: { tracer?: RequestTracer; signal?: AbortSignal } = {}): Promise<HandleResult> {
    const tracer =
      opts.tracer ??
      new RequestTracer({
        kind: msg.channelKind === 'voice' ? 'voice' : 'text',
        userId: msg.personId,
        channelId: msg.channelId,
      });
    tracer.set('message_received', msg.at);
    const conversationId = msg.conversationId ?? newId('conv');
    const session = this.deps.sessions.get(msg.channelId);

    // recent ДО добавления текущего сообщения (оно придёт отдельным user-turn)
    const recentBefore = [...session.recent];

    const ctx = await this.deps.context.build({
      person: { id: msg.personId, displayName: msg.personName, isOwner: msg.isOwner },
      channel: { id: msg.channelId, kind: msg.channelKind, isGroup: session.isGroup },
      recent: recentBefore,
      userMessage: msg.text,
      tracer,
      signal: opts.signal,
    });

    const prompt = this.deps.prompts.build(ctx);
    prompt.push(
      this.deps.prompts.buildCurrentMessage(ctx, { replyToText: msg.replyToText, actionNote: msg.actionNote }),
    );

    tracer?.mark('context_ready');
    tracer?.mark('llm_request_start');
    if (tracer) {
      tracer.provider = this.deps.llm.name;
      tracer.model = this.deps.llmModel ?? undefined;
    }

    const splitter = new SentenceSplitter();
    let full = '';
    let sentenceIndex = 0;
    let firstEmitted = false;

    const emitSentences = async (sentences: string[]): Promise<void> => {
      for (const s of sentences) {
        if (!firstEmitted) {
          firstEmitted = true;
          tracer?.mark('first_visible_output');
          await sink.onFirstSentence(s);
        } else {
          await sink.onSentence(s, sentenceIndex);
        }
        sentenceIndex++;
      }
    };

    try {
      // Внешний цикл — tool calling: модель может попросить выполнить действие
      // (зайти в голос и т.п.), тогда делаем второй заход с результатом.
      // Для обычной болтовни — ровно один проход, как и было.
      const maxToolRounds = 2;
      const maxStreamAttempts = 2;
      let toolRounds = 0;

      for (;;) {
        let toolCalls: ToolCall[] | null = null;

        // Внутренний цикл — один ретрай стрима, если он упал ДО первого токена
        // (скачок латентности/троттлинг), чтобы пик провайдера не стал ошибкой.
        for (let attempt = 1; ; attempt++) {
          try {
            for await (const chunk of this.deps.llm.generateStream(prompt, {
              model: this.deps.llmModel,
              signal: opts.signal,
              tools: this.deps.tools && this.deps.tools.size > 0 ? this.deps.tools.definitions : undefined,
            })) {
              if (opts.signal?.aborted) break;
              if (chunk.kind === 'text') {
                if (!full) tracer?.mark('first_token');
                full += chunk.text;
                await emitSentences(splitter.feed(chunk.text));
                await sink.onProgress(full);
              } else {
                toolCalls = chunk.toolCalls;
              }
            }
            break;
          } catch (streamErr) {
            const canRetry =
              attempt < maxStreamAttempts &&
              !full &&
              !firstEmitted &&
              !opts.signal?.aborted &&
              !isAbortError(streamErr);
            if (!canRetry) throw streamErr;
            this.deps.logger.warn(
              { err: String(streamErr), requestId: tracer.requestId },
              'llm stream failed before first token — one retry',
            );
            await sleep(300, opts.signal);
          }
        }
        if (opts.signal?.aborted) throw new Error('aborted');

        if (toolCalls && toolCalls.length > 0 && this.deps.tools && toolRounds < maxToolRounds) {
          toolRounds++;
          prompt.push({ role: 'assistant', content: full, toolCalls });
          const toolCtx: ToolExecContext = {
            personId: msg.personId,
            personName: msg.personName,
            channelId: msg.channelId,
            channelKind: msg.channelKind,
            guildId: msg.guildId ?? null,
            authorVoiceChannelId: msg.authorVoiceChannelId ?? null,
          };
          for (const call of toolCalls) {
            const result = await this.deps.tools.execute(call, toolCtx);
            this.deps.logger.info({ tool: call.name, requestId: tracer.requestId }, 'tool executed');
            prompt.push({ role: 'tool', content: result, toolCallId: call.id, name: call.name });
          }
          continue; // второй заход: модель отвечает с учётом результата
        }
        break;
      }

      tracer?.mark('llm_complete');
      await emitSentences(splitter.flush());

      const reply = full.trim();
      if (!firstEmitted && reply) {
        // весь ответ — одно «предложение» без терминаторов
        firstEmitted = true;
        tracer?.mark('first_visible_output');
        await sink.onFirstSentence(reply);
      }
      await sink.onComplete(reply);

      // сессия пополняется только после успешной генерации
      session.push({ role: 'user', content: msg.text, authorId: msg.personId, authorName: msg.personName, at: msg.at });
      session.push({ role: 'assistant', content: reply, at: Date.now() });

      this.deps.stats?.incrementMessagesIn(msg.personId);
      this.deps.stats?.incrementMessagesOut(msg.personId);

      // retrieval отметился — обновляем recall-статистику найденных памятей (дёшево, локально)
      if (ctx.memories.length > 0) {
        try {
          this.deps.memory.recall(ctx.memories.map((m) => m.memory.id));
        } catch (e) {
          this.deps.logger.warn({ err: String(e) }, 'recall update failed');
        }
      }

      // суммаризация — только когда short-term переполнился (уходит в фон)
      if (session.evictedCount >= this.deps.summaryTriggerMessages) {
        const evicted = session.takeEvicted();
        this.deps.bus.emitSummaryNeeded({ channelId: msg.channelId, messages: evicted });
      }

      tracer?.mark('response_complete');
      this.deps.telemetry.finish(tracer!);

      // ВСЁ необязательное — в background (fire-and-forget)
      this.deps.bus.emitResponseCompleted({
        requestId: tracer?.requestId ?? conversationId,
        conversationId,
        personId: msg.personId,
        personName: msg.personName,
        isOwner: msg.isOwner,
        channelId: msg.channelId,
        channelKind: msg.channelKind,
        userMessage: msg.text,
        lunaReply: reply,
        tracer: tracer!,
      });

      return { ok: true, reply, requestId: tracer?.requestId ?? conversationId };
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) {
        await sink.onCancelled?.();
        return { ok: false, reply: '', requestId: tracer?.requestId ?? conversationId, error: 'cancelled' };
      }
      if (tracer) tracer.error = String(e instanceof Error ? e.message : e);
      this.deps.telemetry.finish(tracer!);
      this.deps.logger.error({ err: e, requestId: tracer?.requestId }, 'response generation failed');
      await sink.onError(e);
      return { ok: false, reply: '', requestId: tracer?.requestId ?? conversationId, error: String(e) };
    }
  }
}
