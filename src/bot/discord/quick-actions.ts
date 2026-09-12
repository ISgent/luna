import type { VoiceManager } from '../voice/voice-manager.js';
import type { SettingsRepo } from '../../storage/index.js';
import type { Logger } from '../../logging/logger.js';
import type { LunaTool, ToolExecContext } from '../../core/conversation/tools.js';

/**
 * Quick Actions (гибрид, «вариант A»): мгновенное распознавание команд
 * в обычном тексте БЕЗ обращения к модели. «@Луна го в голос» → действие
 * выполняется сразу (0 мс, бесплатно), а Luna получает пометку в контекст
 * и реагирует в характере («захожу!»).
 *
 * Все действия идемпотентны — если модель позже дёрнет тот же инструмент
 * (tool calling), повтор безопасен.
 */

export type QuickAction = 'join_voice' | 'leave_voice' | 'stop_speaking' | 'tts_on' | 'tts_off';

// Unicode-границы слов: JS \b не работает для кириллицы (ASCII-only),
// поэтому границы и суффиксы описываем через \p{L}/\p{N} с флагом u.
const B = String.raw`(?<![\p{L}\p{N}])`; // левая граница слова
const E = String.raw`(?![\p{L}\p{N}])`; // правая граница (для точных слов)

// Порядок важен: сначала более специфичные (stop/tts), потом голосовые.
const PATTERNS: Array<{ action: QuickAction; patterns: RegExp[] }> = [
  {
    action: 'stop_speaking',
    patterns: [
      new RegExp(`${B}(замолчи|заткнись|тихо|стоп|умолкни|mute|shut ?up)${E}`, 'iu'),
      new RegExp(`${B}хватит\\s+(говорить|болтать|петь)${E}`, 'iu'),
    ],
  },
  {
    action: 'tts_off',
    patterns: [
      new RegExp(`${B}(выключи|отключи|убери|сними|без)\\s[^.!?]{0,20}?(озвучк|голос|звук|tts)`, 'iu'),
    ],
  },
  {
    action: 'tts_on',
    patterns: [
      new RegExp(`${B}(включи|верни|вруби)\\s[^.!?]{0,20}?(озвучк|голос|звук|tts)`, 'iu'),
    ],
  },
  {
    action: 'leave_voice',
    patterns: [
      new RegExp(`${B}(выйди|выходи|покинь|отключайся|вылезай|leave|дропай)[^.!?]{0,25}?(голос|войс|voice|канал)`, 'iu'),
      new RegExp(`${B}(голос|войс|voice)[^.!?]{0,15}?(выйди|leave)`, 'iu'),
    ],
  },
  {
    action: 'join_voice',
    patterns: [
      new RegExp(`${B}(го|гоу|ну|давай)\\s+(в|во)\\s+(голос|войс|voice)`, 'iu'),
      new RegExp(`${B}(зайди|заходи|зайдёшь|приходи|приди|подключайся|прыгай|join)[^.!?]{0,25}?(голос|войс|voice|канал)`, 'iu'),
      new RegExp(`${B}в\\s+(голосов|войс)`, 'iu'),
    ],
  },
];

export function detectQuickAction(text: string): QuickAction | null {
  for (const { action, patterns } of PATTERNS) {
    for (const re of patterns) {
      if (re.test(text)) return action;
    }
  }
  return null;
}

export interface QuickActionDeps {
  voice: VoiceManager | null;
  settings: SettingsRepo;
  voiceEnabled: boolean;
  /** Как получить voice-адаптер гильдии (нужен для join). */
  adapterFor: (guildId: string) => unknown;
  logger?: Logger;
}

export interface QuickActionContext {
  userId: string;
  guildId: string | null;
  authorVoiceChannelId: string | null;
}

/**
 * Выполняет действие и возвращает пометку для Luna (что произошло) —
 * она попадёт в промпт, чтобы ответ был в контексте («захожу!»).
 */
export async function executeQuickAction(
  action: QuickAction,
  ctx: QuickActionContext,
  deps: QuickActionDeps,
): Promise<string> {
  switch (action) {
    case 'join_voice': {
      if (!deps.voice || !deps.voiceEnabled) {
        return 'Голосовой режим отключён — Luna не может зайти в канал. Скажи об этом пользователю.';
      }
      if (!ctx.guildId) {
        return 'Это личная переписка — здесь нет голосовых каналов. Зайти не получится.';
      }
      if (!ctx.authorVoiceChannelId) {
        return 'Пользователь сам не в голосовом канале — некуда заходить. Попроси его сначала зайти в канал.';
      }
      const ok = await deps.voice.join(ctx.guildId, ctx.authorVoiceChannelId, deps.adapterFor(ctx.guildId) as never);
      return ok
        ? 'ДЕЙСТВИЕ ВЫПОЛНЕНО: Luna только что зашла в голосовой канал пользователя. Отреагируй на это в ответе (например, что ты уже тут).'
        : 'Не удалось подключиться к голосовому каналу (ошибка подключения). Скажи об этом честно.';
    }
    case 'leave_voice': {
      if (!deps.voice || !ctx.guildId) return 'Luna не в голосовом канале — выходить не откуда.';
      deps.voice.leaveGuild(ctx.guildId);
      return 'ДЕЙСТВИЕ ВЫПОЛНЕНО: Luna вышла из голосового канала.';
    }
    case 'stop_speaking': {
      const tts = ctx.guildId ? deps.voice?.getTts(ctx.guildId) : undefined;
      tts?.stop();
      return 'ДЕЙСТВИЕ ВЫПОЛНЕНО: Luna замолчала (остановила озвучку).';
    }
    case 'tts_on':
    case 'tts_off': {
      deps.settings.set(`user:${ctx.userId}`, 'tts_enabled', action === 'tts_on' ? 'true' : 'false');
      return action === 'tts_on'
        ? 'ДЕЙСТВИЕ ВЫПОЛНЕНО: озвучка ответов для этого пользователя включена.'
        : 'ДЕЙСТВИЕ ВЫПОЛНЕНО: озвучка ответов для этого пользователя выключена (ответы останутся текстом).';
    }
  }
}

/**
 * Инструменты модели (гибрид, «вариант B»): те же действия, но Luna
 * вызывает их САМА по любой человеческой формулировке.
 * Переиспользуют executeQuickAction — логика одна, идемпотентность та же.
 */
export function createVoiceTools(deps: QuickActionDeps): LunaTool[] {
  const toCtx = (ctx: ToolExecContext): QuickActionContext => ({
    userId: ctx.personId,
    guildId: ctx.guildId ?? null,
    authorVoiceChannelId: ctx.authorVoiceChannelId ?? null,
  });
  return [
    {
      def: {
        name: 'join_voice',
        description:
          'Зайти в голосовой канал, где сейчас находится собеседник. Вызывай, когда человек зовёт тебя в голос/войс/голосовой канал (любыми словами).',
        parameters: { type: 'object', properties: {} },
      },
      execute: async (_args, ctx) => executeQuickAction('join_voice', toCtx(ctx), deps),
    },
    {
      def: {
        name: 'leave_voice',
        description: 'Выйти из голосового канала. Вызывай, когда просят выйти/покинуть канал.',
        parameters: { type: 'object', properties: {} },
      },
      execute: async (_args, ctx) => executeQuickAction('leave_voice', toCtx(ctx), deps),
    },
    {
      def: {
        name: 'stop_speaking',
        description: 'Немедленно замолчать (остановить текущую озвучку).',
        parameters: { type: 'object', properties: {} },
      },
      execute: async (_args, ctx) => executeQuickAction('stop_speaking', toCtx(ctx), deps),
    },
    {
      def: {
        name: 'set_tts',
        description: 'Включить или выключить озвучку своих ответов для текущего собеседника.',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'true — включить озвучку, false — выключить' },
          },
          required: ['enabled'],
        },
      },
      execute: async (args, ctx) =>
        executeQuickAction(args.enabled === false ? 'tts_off' : 'tts_on', toCtx(ctx), deps),
    },
  ];
}
