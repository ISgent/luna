import { describe, it, expect, vi } from 'vitest';
import { DiscordTextSink, type EditableMessage, type OutputChannel } from '../../src/bot/discord/output.js';
import { shouldRespond, stripLunaMention, toIncomingMessage, type MessageLike } from '../../src/bot/discord/message-handler.js';
import { TtsPlayer, VoiceSink, type AudioOutput } from '../../src/bot/voice/tts-player.js';
import { MockTTSProvider } from '../../src/ai/mock.js';
import type { TTSProvider, TTSRequest } from '../../src/ai/types.js';
import type { AudioPCM } from '../../src/utils/audio.js';
import { runCommand, type CommandContext, type CommandInvocation } from '../../src/bot/commands/commands.js';
import { Database, createRepositories } from '../../src/storage/index.js';
import { MemoryManager } from '../../src/luna/memory/memory-manager.js';
import { RelationshipManager } from '../../src/luna/relationships/relationship-manager.js';
import { EmotionManager } from '../../src/luna/emotion/emotion-manager.js';
import { loadConfig } from '../../src/config/index.js';
import { createSilentLogger } from '../../src/logging/logger.js';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- DiscordTextSink ----------

class FakeChannel implements OutputChannel {
  messages: FakeMessage[] = [];
  typingCount = 0;
  failSend = false;

  async send(content: string): Promise<EditableMessage> {
    if (this.failSend) throw new Error('send failed');
    const m = new FakeMessage(content);
    this.messages.push(m);
    return m;
  }
  sendTyping(): void {
    this.typingCount++;
  }
}

class FakeMessage implements EditableMessage {
  edits: string[] = [];
  deleted = false;
  constructor(public content: string) {}
  async edit(content: string): Promise<void> {
    this.content = content;
    this.edits.push(content);
  }
  async delete(): Promise<void> {
    this.deleted = true;
  }
}

describe('DiscordTextSink', () => {
  it('первое предложение уходит сразу, стрим доезжает edit-ами, финал — onComplete', async () => {
    const ch = new FakeChannel();
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 1800 });
    await sink.onFirstSentence('Привет!');
    expect(ch.messages).toHaveLength(1);
    expect(ch.messages[0]!.content).toBe('Привет!');

    await sink.onProgress('Привет! Как де');
    await sleepMs(30);
    await sink.onProgress('Привет! Как дела?');
    await sleepMs(30);
    await sink.onComplete('Привет! Как дела? Ну рассказывай.');
    expect(ch.messages[0]!.content).toBe('Привет! Как дела? Ну рассказывай.');
    expect(ch.messages).toHaveLength(1);
  });

  it('onFirstVisible вызывается один раз при первой отправке', async () => {
    const ch = new FakeChannel();
    const onFirstVisible = vi.fn();
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 1800, onFirstVisible });
    await sink.onFirstSentence('раз');
    await sink.onFirstSentence('два');
    expect(onFirstVisible).toHaveBeenCalledTimes(1);
  });

  it('длинный ответ режется на дополнительное сообщение', async () => {
    const ch = new FakeChannel();
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 50 });
    const long = Array.from({ length: 10 }, (_, i) => `Предложение ${i} достаточно длинное.`).join(' ');
    await sink.onFirstSentence(long.slice(0, 30));
    await sink.onComplete(long);
    expect(ch.messages.length).toBeGreaterThan(1);
    expect(ch.messages.every((m) => m.content.length <= 50)).toBe(true);
  });

  it('onCancelled удаляет сообщение', async () => {
    const ch = new FakeChannel();
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 1800 });
    await sink.onFirstSentence('начало');
    await sink.onCancelled();
    expect(ch.messages[0]!.deleted).toBe(true);
  });

  it('onError без отправленного сообщения — человеческая фраза, без технического мусора', async () => {
    const ch = new FakeChannel();
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 1800 });
    await sink.onError(new Error('LLM timeout after 20000ms'));
    expect(ch.messages).toHaveLength(1);
    expect(ch.messages[0]!.content).not.toMatch(/timeout|Error/i);
    expect(ch.messages[0]!.content.length).toBeGreaterThan(5);
  });

  it('ошибка send не роняет sink', async () => {
    const ch = new FakeChannel();
    ch.failSend = true;
    const sink = new DiscordTextSink({ channel: ch, editIntervalMs: 10, chunkLimit: 1800, logger: createSilentLogger() });
    await expect(sink.onFirstSentence('привет')).resolves.toBeUndefined();
  });
});

// ---------- shouldRespond ----------

const LUNA_ID = 'luna123';

function fakeMsg(p: Partial<MessageLike> = {}): MessageLike {
  return {
    id: 'm1',
    authorId: 'u1',
    authorIsBot: false,
    authorIsWebhook: false,
    authorName: 'user',
    content: 'привет',
    channelId: 'c1',
    guildId: 'g1',
    mentionedUserIds: [],
    everyoneMentioned: false,
    createdAtMs: Date.now(),
    ...p,
  };
}

describe('shouldRespond', () => {
  it('DM — отвечает всегда', () => {
    expect(shouldRespond({ msg: fakeMsg({ guildId: null }), lunaId: LUNA_ID }).respond).toBe(true);
  });

  it('сервер без упоминания — молчит', () => {
    const d = shouldRespond({ msg: fakeMsg(), lunaId: LUNA_ID });
    expect(d.respond).toBe(false);
    expect(d.reason).toBe('not-addressed');
  });

  it('упоминание Luna — отвечает, упоминание вырезано', () => {
    const d = shouldRespond({
      msg: fakeMsg({ content: `<@${LUNA_ID}> привет как дела`, mentionedUserIds: [LUNA_ID] }),
      lunaId: LUNA_ID,
    });
    expect(d.respond).toBe(true);
    expect(d.text).toBe('привет как дела');
  });

  it('@everyone — не триггерит', () => {
    const d = shouldRespond({
      msg: fakeMsg({ content: `<@${LUNA_ID}> хей`, mentionedUserIds: [LUNA_ID], everyoneMentioned: true }),
      lunaId: LUNA_ID,
    });
    expect(d.respond).toBe(false);
  });

  it('ответ на сообщение Luna — отвечает (с цитатой)', () => {
    const msg = fakeMsg({ content: 'а подробнее?', referencedAuthorId: LUNA_ID, referencedContent: 'я люблю новеллы' });
    const d = shouldRespond({ msg, lunaId: LUNA_ID });
    expect(d.respond).toBe(true);
    expect(d.reason).toBe('reply-to-luna');
    const inc = toIncomingMessage(msg, d.text, 'owner1');
    expect(inc.replyToText).toBe('я люблю новеллы');
  });

  it('боты и вебхуки игнорируются', () => {
    expect(shouldRespond({ msg: fakeMsg({ authorIsBot: true }), lunaId: LUNA_ID }).respond).toBe(false);
    expect(shouldRespond({ msg: fakeMsg({ authorIsWebhook: true }), lunaId: LUNA_ID }).respond).toBe(false);
  });

  it('сама Luna не отвечает себе', () => {
    expect(shouldRespond({ msg: fakeMsg({ authorId: LUNA_ID }), lunaId: LUNA_ID }).respond).toBe(false);
  });

  it('пустое упоминание — молчит', () => {
    const d = shouldRespond({
      msg: fakeMsg({ content: `<@${LUNA_ID}>`, mentionedUserIds: [LUNA_ID] }),
      lunaId: LUNA_ID,
    });
    expect(d.respond).toBe(false);
  });

  it('stripLunaMention убирает обе формы упоминания', () => {
    expect(stripLunaMention(`<@${LUNA_ID}> <@!${LUNA_ID}> текст`, LUNA_ID)).toBe('текст');
  });
});

// ---------- TtsPlayer ----------

class FakeAudioOutput implements AudioOutput {
  played: number[] = [];
  stopped = 0;
  playDelayMs = 0;
  async play(pcm: Int16Array): Promise<void> {
    if (this.playDelayMs) await sleepMs(this.playDelayMs);
    this.played.push(pcm.length);
  }
  stopAll(): void {
    this.stopped++;
  }
}

describe('TtsPlayer', () => {
  it('предложения играются по очереди, без наложений', async () => {
    const tts = new MockTTSProvider();
    const out = new FakeAudioOutput();
    out.playDelayMs = 20;
    const player = new TtsPlayer(tts, out);
    player.enqueue('Первое предложение.');
    player.enqueue('Второе предложение.');
    player.enqueue('Третье.');
    await sleepMs(200);
    expect(tts.calls).toHaveLength(3);
    expect(out.played).toHaveLength(3);
  });

  it('stop() (barge-in) глушит очередь', async () => {
    const tts = new MockTTSProvider();
    const out = new FakeAudioOutput();
    out.playDelayMs = 30;
    const player = new TtsPlayer(tts, out);
    player.enqueue('раз');
    player.enqueue('два');
    player.enqueue('три');
    await sleepMs(10);
    player.stop();
    await sleepMs(150);
    expect(out.stopped).toBe(1);
    expect(out.played.length).toBeLessThan(3);
  });

  it('TTS упал — предложение пропущено, очередь продолжается (текст уже доставлен)', async () => {
    class ScriptedTTS implements TTSProvider {
      readonly name = 'scripted';
      calls: string[] = [];
      failOn = new Set<number>([2]);
      async synthesize(req: TTSRequest): Promise<AudioPCM> {
        this.calls.push(req.text);
        if (this.failOn.has(this.calls.length)) throw new Error('tts down');
        return { sampleRate: 24000, channels: 1, data: new Int16Array(10) };
      }
      async healthCheck(): Promise<boolean> {
        return true;
      }
    }
    const tts = new ScriptedTTS();
    const out = new FakeAudioOutput();
    const player = new TtsPlayer(tts, out, { logger: createSilentLogger() });
    player.enqueue('первое');
    player.enqueue('второе');
    player.enqueue('третье');
    await sleepMs(200);
    expect(tts.calls).toEqual(['первое', 'второе', 'третье']);
    // 'второе' пропущено после ошибки, остальные проигрались
    expect(out.played.length).toBe(2);
  });

  it('markdown/emoji чистятся перед озвучкой', async () => {
    const tts = new MockTTSProvider();
    const out = new FakeAudioOutput();
    const player = new TtsPlayer(tts, out);
    player.enqueue('**важно** https://x.y 💀');
    await sleepMs(100);
    expect(tts.calls[0]!.text).toBe('важно');
  });
});

describe('VoiceSink', () => {
  it('предложения → очередь плеера; onError глушит', async () => {
    const tts = new MockTTSProvider();
    const out = new FakeAudioOutput();
    const player = new TtsPlayer(tts, out);
    const sink = new VoiceSink({ player });
    await sink.onFirstSentence('Привет!');
    await sink.onSentence('Как дела?', 1);
    await sleepMs(100);
    expect(tts.calls).toHaveLength(2);
    await sink.onError(new Error('x'));
    // onError не бросает
  });
});

// ---------- Команды ----------

function makeCmdCtx(): { ctx: CommandContext; db: Database; repos: ReturnType<typeof createRepositories> } {
  const db = Database.open(':memory:');
  const repos = createRepositories(db);
  const config = loadConfig({ env: { LLM_PROVIDER: 'mock', VOICE_ENABLED: 'false' } });
  const memory = new MemoryManager(repos.memories, null, { enabled: true, dedupeSimilarity: 0.9 });
  const relationships = new RelationshipManager(repos.users, repos.relationships, { ownerId: 'owner1' });
  const emotions = new EmotionManager(repos.emotions, { decayHalfLifeMin: 90 });
  return { ctx: { memory, relationships, emotions, repos, config, voice: null }, db, repos };
}

function inv(p: Partial<CommandInvocation> & { command: CommandInvocation['command']; sub: string }): CommandInvocation {
  return {
    userId: 'u1',
    userName: 'user',
    isOwner: false,
    guildId: 'g1',
    voiceChannelId: null,
    args: {},
    ...p,
  };
}

describe('Команды', () => {
  it('/memory list — пусто и с записями', async () => {
    const { ctx, db, repos } = makeCmdCtx();
    try {
      expect(await runCommand(ctx, inv({ command: 'memory', sub: 'list' }))).toMatch(/ничего о тебе не помнит/);
      await ctx.memory.store({ kind: 'fact', content: 'u1 любит чай', personId: 'u1' });
      const out = await runCommand(ctx, inv({ command: 'memory', sub: 'list' }));
      expect(out).toMatch(/любит чай/);
      expect(out).toMatch(/1 запис/);
      void repos;
    } finally {
      db.close();
    }
  });

  it('/memory delete — только свои записи (владелец может любые)', async () => {
    const { ctx, db } = makeCmdCtx();
    try {
      const r = await ctx.memory.store({ kind: 'fact', content: 'u2 любит кофе', personId: 'u2' });
      const id = (r as { id: string }).id;
      const denied = await runCommand(ctx, inv({ command: 'memory', sub: 'delete', args: { id } }));
      expect(denied).toMatch(/трогать нельзя/);
      expect(ctx.memory.countActive('u2')).toBe(1);
      const allowed = await runCommand(ctx, inv({ command: 'memory', sub: 'delete', isOwner: true, args: { id } }));
      expect(allowed).toMatch(/удалена/);
      expect(ctx.memory.countActive('u2')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('/memory off → memory_enabled=false в настройках; wipe стирает', async () => {
    const { ctx, db } = makeCmdCtx();
    try {
      await ctx.memory.store({ kind: 'fact', content: 'u1 любит чай', personId: 'u1' });
      await runCommand(ctx, inv({ command: 'memory', sub: 'off' }));
      expect(ctx.repos.settings.getBool('user:u1', 'memory_enabled', true)).toBe(false);
      const wiped = await runCommand(ctx, inv({ command: 'memory', sub: 'wipe' }));
      expect(wiped).toMatch(/стёрто 1/);
      expect(ctx.memory.countActive('u1')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('/luna mood и stats отвечают по-русски', async () => {
    const { ctx, db } = makeCmdCtx();
    try {
      expect(await runCommand(ctx, inv({ command: 'luna', sub: 'mood' }))).toMatch(/Luna/);
      const stats = await runCommand(ctx, inv({ command: 'luna', sub: 'stats' }));
      expect(stats).toMatch(/сообщений от тебя/);
    } finally {
      db.close();
    }
  });

  it('/luna telemetry — только владелец', async () => {
    const { ctx, db } = makeCmdCtx();
    try {
      expect(await runCommand(ctx, inv({ command: 'luna', sub: 'telemetry' }))).toMatch(/только для владельца/);
      const owner = await runCommand(ctx, inv({ command: 'luna', sub: 'telemetry', isOwner: true }));
      expect(owner).toMatch(/телеметрия пуста/);
    } finally {
      db.close();
    }
  });

  it('/voice join без голосового канала — внятный ответ', async () => {
    const { ctx, db } = makeCmdCtx();
    try {
      // voice отключён в конфиге harness
      expect(await runCommand(ctx, inv({ command: 'voice', sub: 'join' }))).toMatch(/отключён/);
    } finally {
      db.close();
    }
  });
});
