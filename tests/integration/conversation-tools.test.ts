/**
 * Tool calling (гибрид, «вариант B»): модель сама вызывает инструменты,
 * ConversationManager выполняет их и делает второй заход за текстом.
 * Plus: quick-action пометка попадает в промпт.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FakeSink, TestHarness } from './harness.js';
import type { ToolCall } from '../../src/ai/types.js';
import type { ToolExecContext } from '../../src/core/conversation/tools.js';

let h: TestHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('Tool loop в ConversationManager', () => {
  it('модель вызывает инструмент → выполняется → второй заход даёт текст', async () => {
    const executed: Array<{ name: string; ctx: ToolExecContext }> = [];
    const toolScript = (): ToolCall[] => [{ id: 'call_1', name: 'join_voice', argumentsJson: '{}' }];

    h = new TestHarness({ reply: 'обычный ответ', toolScript, replyAfterTools: 'Захожу, встречай!' });
    h.tools.register({
      def: { name: 'join_voice', description: 'зайти в голос', parameters: { type: 'object', properties: {} } },
      execute: async (_args, ctx) => {
        executed.push({ name: 'join_voice', ctx });
        return 'ДЕЙСТВИЕ ВЫПОЛНЕНО: Luna зашла в канал.';
      },
    });

    const sink = new FakeSink();
    const res = await h.manager.handle(
      h.makeMessage({ text: 'можешь зайти ко мне в войс?', guildId: 'g1', authorVoiceChannelId: 'v1' }),
      sink,
    );

    expect(res.ok).toBe(true);
    expect(sink.completed).toBe('Захожу, встречай!');
    // инструмент выполнен с контекстом сообщения
    expect(executed).toHaveLength(1);
    expect(executed[0]!.ctx.guildId).toBe('g1');
    expect(executed[0]!.ctx.authorVoiceChannelId).toBe('v1');
    // два стрим-вызова: первый вернул tool_calls, второй — текст
    const streamCalls = h.llm.calls.filter((c) => c.kind === 'stream');
    expect(streamCalls).toHaveLength(2);
    // во второй вызов попали assistant с tool_calls и результат инструмента
    const second = streamCalls[1]!.messages;
    const assistantWithCalls = second.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistantWithCalls?.toolCalls?.[0]?.name).toBe('join_voice');
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/ДЕЙСТВИЕ ВЫПОЛНЕНО/);
    expect(toolMsg?.toolCallId).toBe('call_1');
  });

  it('без инструментов в реестре tools в запрос не передаются (обычный диалог не платит)', async () => {
    h = new TestHarness({ reply: 'просто болтаем' });
    const sink = new FakeSink();
    await h.manager.handle(h.makeMessage({ text: 'привет' }), sink);
    const streamCall = h.llm.calls.find((c) => c.kind === 'stream')!;
    expect(streamCall.opts?.tools).toBeUndefined();
    expect(sink.completed).toBe('просто болтаем');
  });

  it('ошибка инструмента не роняет ответ — модель получает текст ошибки', async () => {
    const toolScript = (): ToolCall[] => [{ id: 'c1', name: 'broken_tool', argumentsJson: '{}' }];
    h = new TestHarness({ toolScript, replyAfterTools: 'Не вышло, но я тут.' });
    h.tools.register({
      def: { name: 'broken_tool', description: 'x', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        throw new Error('инструмент сломался');
      },
    });
    const sink = new FakeSink();
    const res = await h.manager.handle(h.makeMessage({ text: 'сломайся' }), sink);
    expect(res.ok).toBe(true);
    expect(sink.completed).toBe('Не вышло, но я тут.');
    const second = h.llm.calls.filter((c) => c.kind === 'stream')[1]!.messages;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/Не получилось выполнить/);
  });

  it('невалидные аргументы — понятный результат для модели, без падения', async () => {
    const toolScript = (): ToolCall[] => [{ id: 'c1', name: 'set_tts', argumentsJson: '{не json' }];
    h = new TestHarness({ toolScript, replyAfterTools: 'ок' });
    let executed = false;
    h.tools.register({
      def: { name: 'set_tts', description: 'x', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        executed = true;
        return 'done';
      },
    });
    const sink = new FakeSink();
    const res = await h.manager.handle(h.makeMessage({ text: 'включи озвучку как-нибудь' }), sink);
    expect(res.ok).toBe(true);
    expect(executed).toBe(false); // аргументы не разобрались — инструмент не вызывался
    const second = h.llm.calls.filter((c) => c.kind === 'stream')[1]!.messages;
    expect(second.find((m) => m.role === 'tool')?.content).toMatch(/Не удалось разобрать аргументы/);
  });
});

describe('Quick-action пометка в промпте', () => {
  it('actionNote попадает в текущее сообщение как данные', async () => {
    h = new TestHarness({ reply: 'Захожу!' });
    const sink = new FakeSink();
    await h.manager.handle(
      h.makeMessage({
        text: 'го в голос',
        actionNote: 'ДЕЙСТВИЕ ВЫПОЛНЕНО: Luna только что зашла в голосовой канал пользователя.',
      }),
      sink,
    );
    const prompt = h.lastPrompt();
    const lastUser = prompt[prompt.length - 1]!;
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toContain('[пометка:');
    expect(lastUser.content).toContain('ДЕЙСТВИЕ ВЫПОЛНЕНО');
    expect(lastUser.content).toContain('го в голос');
  });
});
