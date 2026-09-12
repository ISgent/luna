import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectQuickAction, executeQuickAction, createVoiceTools, type QuickActionDeps } from '../../src/bot/discord/quick-actions.js';
import { Database, createRepositories } from '../../src/storage/index.js';
import type { VoiceManager } from '../../src/bot/voice/voice-manager.js';
import type { ToolExecContext } from '../../src/core/conversation/tools.js';

describe('detectQuickAction', () => {
  it('join: живые формулировки', () => {
    expect(detectQuickAction('го в голос')).toBe('join_voice');
    expect(detectQuickAction('гоу в войс')).toBe('join_voice');
    expect(detectQuickAction('Luna, зайди в голосовой')).toBe('join_voice');
    expect(detectQuickAction('заходи в войс')).toBe('join_voice');
    expect(detectQuickAction('ну давай в голос')).toBe('join_voice');
    expect(detectQuickAction('прыгай в канал')).toBe('join_voice');
    expect(detectQuickAction('join the voice channel')).toBe('join_voice');
  });

  it('leave / stop / tts', () => {
    expect(detectQuickAction('выйди из канала')).toBe('leave_voice');
    expect(detectQuickAction('покинь голос')).toBe('leave_voice');
    expect(detectQuickAction('leave voice')).toBe('leave_voice');
    expect(detectQuickAction('замолчи')).toBe('stop_speaking');
    expect(detectQuickAction('стоп')).toBe('stop_speaking');
    expect(detectQuickAction('хватит говорить')).toBe('stop_speaking');
    expect(detectQuickAction('выключи озвучку')).toBe('tts_off');
    expect(detectQuickAction('отключи звук')).toBe('tts_off');
    expect(detectQuickAction('включи озвучку обратно')).toBe('tts_on');
  });

  it('ложные срабатывания отсутствуют', () => {
    expect(detectQuickAction('го в кино')).toBeNull();
    expect(detectQuickAction('я вышел из дома')).toBeNull();
    expect(detectQuickAction('стопудово круто')).toBeNull();
    expect(detectQuickAction('выключи свет')).toBeNull();
    expect(detectQuickAction('как дела?')).toBeNull();
    expect(detectQuickAction('расскажи про голосование')).toBeNull();
  });
});

describe('executeQuickAction', () => {
  let db: Database;
  let repos: ReturnType<typeof createRepositories>;
  let voiceFake: { join: ReturnType<typeof vi.fn>; leaveGuild: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let deps: QuickActionDeps;

  const ctx = { userId: 'u1', guildId: 'g1', authorVoiceChannelId: 'v1' };

  beforeEach(() => {
    db = Database.open(':memory:');
    repos = createRepositories(db);
    voiceFake = { join: vi.fn(async () => true), leaveGuild: vi.fn(), stop: vi.fn() };
    deps = {
      voice: {
        join: voiceFake.join,
        leaveGuild: voiceFake.leaveGuild,
        getTts: () => ({ stop: voiceFake.stop }),
      } as unknown as VoiceManager,
      settings: repos.settings,
      voiceEnabled: true,
      adapterFor: (g) => ({ adapter: g }),
    };
  });

  afterEach(() => db.close());

  it('join_voice: заходит в канал автора, пометка для Luna', async () => {
    const note = await executeQuickAction('join_voice', ctx, deps);
    expect(voiceFake.join).toHaveBeenCalledWith('g1', 'v1', { adapter: 'g1' });
    expect(note).toMatch(/ДЕЙСТВИЕ ВЫПОЛНЕНО/);
    expect(note).toMatch(/зашла в голосовой/);
  });

  it('join_voice: пользователь не в голосе — внятная пометка, без подключения', async () => {
    const note = await executeQuickAction('join_voice', { ...ctx, authorVoiceChannelId: null }, deps);
    expect(voiceFake.join).not.toHaveBeenCalled();
    expect(note).toMatch(/не в голосовом/);
  });

  it('join_voice: голос выключен / личка — корректные пометки', async () => {
    const off = await executeQuickAction('join_voice', ctx, { ...deps, voiceEnabled: false });
    expect(off).toMatch(/отключён/);
    const dm = await executeQuickAction('join_voice', { ...ctx, guildId: null }, deps);
    expect(dm).toMatch(/личная переписка/);
  });

  it('leave_voice и stop_speaking', async () => {
    const left = await executeQuickAction('leave_voice', ctx, deps);
    expect(voiceFake.leaveGuild).toHaveBeenCalledWith('g1');
    expect(left).toMatch(/вышла/);
    const stopped = await executeQuickAction('stop_speaking', ctx, deps);
    expect(voiceFake.stop).toHaveBeenCalled();
    expect(stopped).toMatch(/замолчала/);
  });

  it('tts_on/off пишут настройку пользователя', async () => {
    await executeQuickAction('tts_off', ctx, deps);
    expect(repos.settings.get('user:u1', 'tts_enabled')).toBe('false');
    await executeQuickAction('tts_on', ctx, deps);
    expect(repos.settings.get('user:u1', 'tts_enabled')).toBe('true');
  });
});

describe('createVoiceTools (tool calling)', () => {
  it('четыре инструмента с валидными определениями, execute переиспользует quick actions', async () => {
    const db = Database.open(':memory:');
    try {
      const repos = createRepositories(db);
      const join = vi.fn(async () => true);
      const tools = createVoiceTools({
        voice: { join, leaveGuild: vi.fn(), getTts: () => undefined } as unknown as VoiceManager,
        settings: repos.settings,
        voiceEnabled: true,
        adapterFor: () => ({}),
      });
      expect(tools.map((t) => t.def.name)).toEqual(['join_voice', 'leave_voice', 'stop_speaking', 'set_tts']);
      for (const t of tools) {
        expect(t.def.description.length).toBeGreaterThan(10);
        expect(t.def.parameters.type).toBe('object');
      }
      const ctx: ToolExecContext = {
        personId: 'u1', personName: 'Gent', channelId: 'c1', channelKind: 'text',
        guildId: 'g1', authorVoiceChannelId: 'v1',
      };
      const result = await tools[0]!.execute({}, ctx);
      expect(join).toHaveBeenCalledOnce();
      expect(result).toMatch(/ДЕЙСТВИЕ ВЫПОЛНЕНО/);
      const ttsResult = await tools[3]!.execute({ enabled: false }, ctx);
      expect(ttsResult).toMatch(/выключена/);
      expect(repos.settings.get('user:u1', 'tts_enabled')).toBe('false');
    } finally {
      db.close();
    }
  });
});
