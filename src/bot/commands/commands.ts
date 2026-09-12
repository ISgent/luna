import type { AppConfig } from '../../config/index.js';
import type { Repositories } from '../../storage/index.js';
import type { MemoryManager } from '../../luna/memory/memory-manager.js';
import type { RelationshipManager } from '../../luna/relationships/relationship-manager.js';
import type { EmotionManager } from '../../luna/emotion/emotion-manager.js';
import type { VoiceManager } from '../voice/voice-manager.js';
import { truncate } from '../../utils/text.js';

/**
 * Команды Luna: приватность/контроль данных (ТЗ §36) и управление режимом.
 * Логика чистая (без discord.js) — client.ts только маппит interaction → runCommand.
 */

export interface CommandContext {
  memory: MemoryManager;
  relationships: RelationshipManager;
  emotions: EmotionManager;
  repos: Repositories;
  config: AppConfig;
  voice: VoiceManager | null;
  /** Как получить voice-адаптер гильдии (нужен для /voice join). */
  adapterFor?: (guildId: string) => unknown;
}

export interface CommandInvocation {
  userId: string;
  userName: string;
  isOwner: boolean;
  guildId?: string | null;
  voiceChannelId?: string | null;
  command: 'memory' | 'luna' | 'voice';
  sub: string;
  args?: { id?: string; mode?: string; target?: string; count?: number };
}

const KIND_LABEL: Record<string, string> = {
  fact: 'факт',
  preference: 'предпочтение',
  event: 'событие',
  joke: 'шутка',
  promise: 'обещание',
  open_thread: 'незакрытая тема',
  impression: 'впечатление',
  consolidated: 'обобщение',
};

export async function runCommand(ctx: CommandContext, inv: CommandInvocation): Promise<string> {
  const userScope = `user:${inv.userId}`;

  switch (inv.command) {
    case 'memory':
      return memoryCommand(ctx, inv, userScope);
    case 'luna':
      return lunaCommand(ctx, inv, userScope);
    case 'voice':
      return voiceCommand(ctx, inv);
    default:
      return 'неизвестная команда';
  }
}

async function memoryCommand(ctx: CommandContext, inv: CommandInvocation, scope: string): Promise<string> {
  switch (inv.sub) {
    case 'list': {
      const memories = ctx.memory.listForUser(inv.userId);
      if (memories.length === 0) return 'Luna ничего о тебе не помнит (или память отключена).';
      const count = Math.min(inv.args?.count ?? 10, 25);
      const lines = memories.slice(0, count).map((m) => {
        const when = new Date(m.createdAt).toLocaleDateString('ru-RU');
        return `• \`${m.id.slice(4, 12)}\` [${KIND_LABEL[m.kind] ?? m.kind}, ${when}] ${truncate(m.content, 90)}`;
      });
      return `Luna помнит о тебе ${memories.length} записей (показано ${lines.length}):\n${lines.join('\n')}\n\nУдалить: /memory delete id`;
    }
    case 'delete': {
      const id = inv.args?.id;
      if (!id) return 'нужен id записи: /memory delete <id>';
      const rec = ctx.repos.memories.get(id.startsWith('mem_') ? id : `mem_${id}`);
      if (!rec) return 'такой записи нет (или уже удалена)';
      if (rec.personId !== inv.userId && !inv.isOwner) return 'это память не о тебе — трогать нельзя';
      ctx.memory.deleteMemory(rec.id);
      return `запись удалена: ${truncate(rec.content, 80)}`;
    }
    case 'wipe': {
      const n = ctx.memory.forgetPerson(inv.userId);
      ctx.repos.relationships.remove(inv.userId);
      return `стёрто ${n} записей о тебе. отношения сброшены — знакомитесь заново.`;
    }
    case 'off':
      ctx.repos.settings.set(scope, 'memory_enabled', 'false');
      return 'память о тебе отключена. Luna перестанет запоминать и доставать записи (существующие останутся в базе — удаление: /memory wipe).';
    case 'on':
      ctx.repos.settings.set(scope, 'memory_enabled', 'true');
      return 'память снова включена';
    default:
      return 'memory: list | delete <id> | wipe | on | off';
  }
}

async function lunaCommand(ctx: CommandContext, inv: CommandInvocation, scope: string): Promise<string> {
  switch (inv.sub) {
    case 'mood': {
      const state = ctx.emotions.current();
      return ctx.emotions.describe(state);
    }
    case 'stats': {
      const totals = ctx.repos.stats.totals(inv.userId);
      const rel = ctx.repos.relationships.get(inv.userId);
      const memCount = ctx.memory.countActive(inv.userId);
      return [
        `сообщений от тебя: ${totals.messagesIn}, ответов: ${totals.messagesOut}`,
        `дней общения: ${totals.days}, голос: ${Math.round(totals.voiceSeconds / 60)} мин`,
        `записей в памяти о тебе: ${memCount}`,
        rel ? `доверие ${(rel.trust * 100).toFixed(0)}%, близость ${(rel.closeness * 100).toFixed(0)}%, симпатия ${(rel.affection * 100).toFixed(0)}%` : 'отношений пока нет',
      ].join('\n');
    }
    case 'tts': {
      const mode = inv.args?.mode;
      if (mode !== 'on' && mode !== 'off') return 'luna tts on|off';
      ctx.repos.settings.set(scope, 'tts_enabled', mode === 'on' ? 'true' : 'false');
      return mode === 'on' ? 'озвучка включена' : 'озвучка выключена (текст остаётся)';
    }
    case 'voice': {
      const mode = inv.args?.mode;
      if (mode !== 'on' && mode !== 'off') return 'luna voice on|off';
      ctx.repos.settings.set(scope, 'voice_enabled', mode === 'on' ? 'true' : 'false');
      return mode === 'on' ? 'Luna снова слушает твой голос' : 'Luna не обрабатывает твой голос';
    }
    case 'telemetry': {
      if (!inv.isOwner) return 'только для владельца';
      const n = inv.args?.count ?? 5;
      const rows = ctx.repos.telemetry.recent(n);
      if (rows.length === 0) return 'телеметрия пуста';
      return rows
        .map((r) => {
          const m = r.metrics;
          return `\`${r.requestId.slice(4, 12)}\` ttft=${m.ttftMs ?? '-'}мс mem=${m.memoryRetrievalMs ?? '-'}мс total=${m.totalMs ?? '-'}мс ${r.error ? `ERR:${truncate(r.error, 40)}` : ''}`;
        })
        .join('\n');
    }
    case 'reset': {
      if (!inv.isOwner) return 'только для владельца';
      const target = inv.args?.target;
      if (!target) return 'нужен id пользователя';
      ctx.memory.forgetPerson(target);
      ctx.repos.relationships.remove(target);
      return `память и отношения о ${target} сброшены`;
    }
    default:
      return 'luna: mood | stats | tts on|off | voice on|off | telemetry | reset <user-id>';
  }
}

async function voiceCommand(ctx: CommandContext, inv: CommandInvocation): Promise<string> {
  if (!ctx.voice || !ctx.config.voice.enabled) return 'голосовой режим отключён в конфиге';
  if (inv.sub === 'join') {
    if (!inv.guildId || !inv.voiceChannelId) return 'зайди сначала в голосовой канал';
    const adapter = ctx.adapterFor?.(inv.guildId);
    const ok = await ctx.voice.join(inv.guildId, inv.voiceChannelId, adapter as never);
    return ok ? 'я в канале' : 'не получилось зайти в канал';
  }
  if (inv.sub === 'leave') {
    if (!inv.guildId) return 'это работает только на сервере';
    ctx.voice.leaveGuild(inv.guildId);
    return 'вышла';
  }
  return 'voice: join | leave';
}
