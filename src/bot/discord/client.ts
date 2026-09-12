import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  type Collection,
  type GuildMember,
  type Message,
  type Interaction,
  type VoiceState,
  type TextBasedChannel,
} from 'discord.js';
import type { AppConfig } from '../../config/index.js';
import type { Logger } from '../../logging/logger.js';
import type { Telemetry } from '../../logging/telemetry.js';
import type { Repositories } from '../../storage/index.js';
import type { ConversationManager, ReplySink } from '../../core/conversation/conversation-manager.js';
import type { ResponseQueue } from '../../processing/queues/response-queue.js';
import type { CommandContext, CommandInvocation } from '../commands/commands.js';
import { runCommand } from '../commands/commands.js';
import { DiscordTextSink, type OutputChannel } from './output.js';
import { shouldRespond, toIncomingMessage, type MessageLike } from './message-handler.js';
import { detectQuickAction, executeQuickAction, type QuickActionDeps } from './quick-actions.js';
import type { VoiceManager, UtteranceInput } from '../voice/voice-manager.js';
import { VoiceSink } from '../voice/tts-player.js';
import { EndBehaviorType } from '@discordjs/voice';

/**
 * LunaDiscordBot — ТОНКИЙ слой discord.js: события, маппинг, права.
 * Вся логика живёт в ConversationManager/ResponseQueue/VoiceManager.
 */

export interface LunaBotDeps {
  config: AppConfig;
  logger: Logger;
  manager: ConversationManager;
  queue: ResponseQueue;
  voice: VoiceManager | null;
  commands: CommandContext;
  repos: Repositories;
  telemetry: Telemetry;
}

export class LunaDiscordBot {
  readonly client: Client;

  constructor(private deps: LunaBotDeps) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.registerEvents();
  }

  async start(): Promise<void> {
    try {
      await this.client.login(this.deps.config.discord.token);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/disallowed intents/i.test(msg)) {
        throw new Error(
          'Discord отклонил подключение: у бота не включён привилегированный intent. ' +
            'Откройте https://discord.com/developers/applications → ваше приложение → Bot → ' +
            'Privileged Gateway Intents → включите MESSAGE CONTENT INTENT → Save Changes, затем перезапустите. ' +
            `(исходная ошибка: ${msg})`,
        );
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.deps.voice?.leaveAll();
    this.client.destroy();
  }

  private registerEvents(): void {
    this.client.once(Events.ClientReady, (c) => {
      this.deps.logger.info({ user: c.user.tag }, 'discord: ready');
      void this.registerCommands().catch((e) => this.deps.logger.error({ err: String(e) }, 'command registration failed'));
    });

    this.client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg).catch((e) => this.deps.logger.error({ err: String(e) }, 'message handler failed'));
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch((e) => this.deps.logger.error({ err: String(e) }, 'interaction failed'));
    });

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      void this.handleVoiceState(oldState, newState).catch((e) => this.deps.logger.error({ err: String(e) }, 'voice state failed'));
    });
  }

  // ---------- текст ----------

  private async handleMessage(raw: Message): Promise<void> {
    if (!this.client.user) return;
    const lunaId = this.client.user.id;
    const msg = this.toMessageLike(raw);
    const decision = shouldRespond({
      msg,
      lunaId,
      ownerId: this.deps.config.discord.ownerId,
    });
    if (!decision.respond) {
      this.deps.logger.debug({ reason: decision.reason, channelId: msg.channelId }, 'skip message');
      return;
    }

    const incoming = toIncomingMessage(msg, decision.text, this.deps.config.discord.ownerId);

    // Quick actions: «го в голос» и т.п. выполняются МГНОВЕННО, до модели;
    // Luna получит пометку и отреагирует в характере («захожу!»).
    const quick = detectQuickAction(decision.text);
    if (quick) {
      incoming.actionNote = await executeQuickAction(
        quick,
        {
          userId: msg.authorId,
          guildId: msg.guildId,
          authorVoiceChannelId: msg.authorVoiceChannelId ?? null,
        },
        this.quickActionDeps(),
      );
    }

    const sink = new DiscordTextSink({
      channel: raw.channel as unknown as OutputChannel,
      editIntervalMs: this.deps.config.pipeline.messageEditIntervalMs,
      chunkLimit: this.deps.config.pipeline.messageChunkLimit,
      onFirstVisible: () => this.deps.queue.markFirstEmitted(incoming.channelId),
      logger: this.deps.logger,
    });
    this.deps.queue.enqueue({ msg: incoming, sink, receivedAt: msg.createdAtMs });
  }

  private quickActionDeps(): QuickActionDeps {
    return {
      voice: this.deps.voice,
      settings: this.deps.repos.settings,
      voiceEnabled: this.deps.config.voice.enabled,
      adapterFor: (guildId) => this.client.guilds.cache.get(guildId)?.voiceAdapterCreator,
      logger: this.deps.logger,
    };
  }

  private toMessageLike(msg: Message): MessageLike {
    // referencedMessage есть в рантайме v14, но отсутствует в типах некоторых версий
    const refMsg =
      (msg as unknown as { referencedMessage?: Message | null }).referencedMessage ?? null;
    return {
      id: msg.id,
      authorId: msg.author.id,
      authorIsBot: msg.author.bot,
      authorIsWebhook: !!msg.webhookId,
      authorName: msg.author.username,
      authorDisplayName: (msg.member?.displayName ?? msg.author.globalName ?? null) as string | null,
      content: msg.content,
      channelId: msg.channelId,
      guildId: msg.guildId,
      mentionedUserIds: [...msg.mentions.users.keys()],
      everyoneMentioned: msg.mentions.everyone,
      referencedAuthorId: msg.reference?.messageId ? (refMsg?.author.id ?? null) : null,
      referencedContent: refMsg?.content ?? null,
      createdAtMs: msg.createdTimestamp,
      authorVoiceChannelId: msg.member?.voice?.channelId ?? null,
    };
  }

  // ---------- команды ----------

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    const member = interaction.member;
    const guildMember = member && 'voice' in member ? member : null;
    const inv: CommandInvocation = {
      userId: interaction.user.id,
      userName: interaction.user.displayName ?? interaction.user.username,
      isOwner: interaction.user.id === this.deps.config.discord.ownerId,
      guildId: interaction.guildId,
      voiceChannelId: guildMember?.voice?.channelId ?? null,
      command: interaction.commandName as CommandInvocation['command'],
      sub: (() => {
        try {
          return interaction.options.getSubcommand();
        } catch {
          return '';
        }
      })(),
      args: {
        id: interaction.options.getString('id') ?? undefined,
        mode: interaction.options.getString('mode') ?? undefined,
        target: interaction.options.getString('target') ?? undefined,
        count: interaction.options.getInteger('count') ?? undefined,
      },
    };
    // voice join требует id канала вызывающего
    if (inv.command === 'voice' && inv.sub === 'join' && !inv.voiceChannelId && guildMember) {
      inv.voiceChannelId = guildMember.voice?.channelId ?? null;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const reply = await runCommand(this.deps.commands, inv);
      await interaction.editReply({ content: reply.slice(0, 1900) });
    } catch (e) {
      this.deps.logger.error({ err: String(e), cmd: inv.command }, 'command failed');
      await interaction.editReply({ content: 'команда сломалась, я записала' });
    }
  }

  private commandDefinitions(): Array<{ toJSON(): unknown }> {
    const memory = new SlashCommandBuilder()
      .setName('memory')
      .setDescription('Память Luna о тебе')
      .addSubcommand((s) => s.setName('list').setDescription('Показать сохранённые записи').addIntegerOption((o) => o.setName('count').setDescription('Сколько показать')))
      .addSubcommand((s) => s.setName('delete').setDescription('Удалить запись').addStringOption((o) => o.setName('id').setDescription('ID записи').setRequired(true)))
      .addSubcommand((s) => s.setName('wipe').setDescription('Удалить ВСЮ память о тебе и сбросить отношения'))
      .addSubcommand((s) => s.setName('on').setDescription('Включить память о тебе'))
      .addSubcommand((s) => s.setName('off').setDescription('Отключить память о тебе'));

    const luna = new SlashCommandBuilder()
      .setName('luna')
      .setDescription('Состояние и настройки Luna')
      .addSubcommand((s) => s.setName('mood').setDescription('Какое у Luna сейчас настроение'))
      .addSubcommand((s) => s.setName('stats').setDescription('Статистика вашего общения'))
      .addSubcommand((s) => s.setName('tts').setDescription('Озвучка ответов').addStringOption((o) => o.setName('mode').setDescription('on/off').addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }).setRequired(true)))
      .addSubcommand((s) => s.setName('voice').setDescription('Обработка твоего голоса').addStringOption((o) => o.setName('mode').setDescription('on/off').addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }).setRequired(true)))
      .addSubcommand((s) => s.setName('telemetry').setDescription('Последние замеры латентности (владелец)').addIntegerOption((o) => o.setName('count').setDescription('Сколько строк')))
      .addSubcommand((s) => s.setName('reset').setDescription('Сбросить память/отношения о пользователе (владелец)').addStringOption((o) => o.setName('target').setDescription('ID пользователя').setRequired(true)));

    const voice = new SlashCommandBuilder()
      .setName('voice')
      .setDescription('Голосовой режим')
      .addSubcommand((s) => s.setName('join').setDescription('Позвать Luna в свой голосовой канал'))
      .addSubcommand((s) => s.setName('leave').setDescription('Luna выходит из канала'));

    return [memory, luna, voice];
  }

  private async registerCommands(): Promise<void> {
    if (!this.client.user) return;
    const body = this.commandDefinitions().map((c) => c.toJSON());
    const rest = new REST({ version: '10' }).setToken(this.deps.config.discord.token ?? '');
    const guildId = this.deps.config.discord.guildId;
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(this.client.user.id, guildId), { body });
      this.deps.logger.info({ guildId }, 'commands: guild-registered');
    } else {
      await rest.put(Routes.applicationCommands(this.client.user.id), { body });
      this.deps.logger.info('commands: globally registered (может занять до часа)');
    }
  }

  // ---------- голос ----------

  private async handleVoiceState(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const voice = this.deps.voice;
    if (!voice || !this.deps.config.voice.enabled) return;
    const guildId = newState.guild.id;
    const me = newState.guild.members.me;
    const lunaChannelId = me?.voice.channelId ?? null;
    const user = newState.member;
    if (!user || user.user.bot) return;

    // auto-join за владельцем
    if (
      this.deps.config.voice.autoJoin &&
      user.id === this.deps.config.discord.ownerId &&
      newState.channelId &&
      !lunaChannelId
    ) {
      const ok = await voice.join(guildId, newState.channelId, newState.guild.voiceAdapterCreator);
      if (ok) this.attachVoiceListeners(guildId, newState.channelId);
      return;
    }

    if (!lunaChannelId) return;

    if (newState.channelId === lunaChannelId && oldState.channelId !== lunaChannelId) {
      // пользователь зашёл в канал Luna
      this.attachVoiceListeners(guildId, lunaChannelId, user.id);
    } else if (oldState.channelId === lunaChannelId && newState.channelId !== lunaChannelId) {
      voice.unlistenUser(guildId, user.id);
    }

    // Luna осталась одна — выходим (не висим в пустом канале)
    const channel = newState.guild.channels.cache.get(lunaChannelId);
    const members = (channel as { members?: Collection<string, GuildMember> } | undefined)?.members;
    if (members) {
      const humans = [...members.values()].filter((m) => !m.user.bot);
      if (humans.length === 0) {
        voice.leaveGuild(guildId);
      }
    }
  }

  private attachVoiceListeners(guildId: string, channelId: string, onlyUserId?: string): void {
    const voice = this.deps.voice;
    const connection = voice?.getConnection(guildId);
    if (!voice || !connection) return;
    const receiver = connection.receiver;
    const subscribe = (userId: string, opts: { end: { behavior: EndBehaviorType } }) =>
      receiver.subscribe(userId, opts as never) as unknown as import('node:stream').Readable;

    if (onlyUserId) {
      voice.listenUser(guildId, channelId, onlyUserId, subscribe);
      return;
    }
    const channel = this.client.channels.cache.get(channelId);
    const members = (channel as { members?: Collection<string, GuildMember> } | undefined)?.members;
    if (members) {
      for (const m of members.values()) {
        if (!m.user.bot) voice.listenUser(guildId, channelId, m.id, subscribe);
      }
    }
  }

  /** Реплика из голосового канала → ConversationManager (озвучка ИЛИ текст). */
  async handleVoiceUtterance(input: UtteranceInput): Promise<void> {
    const voice = this.deps.voice;
    if (!voice) return;
    const scope = `user:${input.userId}`;
    if (!this.deps.repos.settings.getBool(scope, 'voice_enabled', true)) return;

    const ttsEnabled =
      this.deps.config.tts.enabled && this.deps.repos.settings.getBool(scope, 'tts_enabled', true);
    const player = ttsEnabled ? voice.getTts(input.guildId) : undefined;

    let sink: ReplySink | null = null;
    if (player) {
      sink = new VoiceSink({ player, tracer: input.tracer, logger: this.deps.logger });
    } else {
      // TTS выключен/недоступен — текстовая копия в текстовый чат голосового канала
      const voiceChannel = await this.client.channels.fetch(input.voiceChannelId).catch(() => null);
      const textChannel = voiceChannel as unknown as TextBasedChannel | null;
      if (textChannel && typeof (textChannel as { send?: unknown }).send === 'function') {
        sink = new DiscordTextSink({
          channel: textChannel as unknown as OutputChannel,
          editIntervalMs: this.deps.config.pipeline.messageEditIntervalMs,
          chunkLimit: this.deps.config.pipeline.messageChunkLimit,
          onFirstVisible: () => this.deps.queue.markFirstEmitted(input.voiceChannelId),
          logger: this.deps.logger,
        });
      }
    }
    if (!sink) {
      this.deps.logger.warn({ guildId: input.guildId }, 'voice utterance: no output available');
      return;
    }

    // Quick actions работают и для голосовых реплик («выйди из канала» голосом)
    const quick = detectQuickAction(input.text);
    let actionNote: string | undefined;
    if (quick) {
      actionNote = await executeQuickAction(
        quick,
        { userId: input.userId, guildId: input.guildId, authorVoiceChannelId: input.voiceChannelId },
        this.quickActionDeps(),
      );
    }

    this.deps.queue.enqueue({
      msg: {
        personId: input.userId,
        personName: input.userName,
        isOwner: input.userId === this.deps.config.discord.ownerId,
        channelId: input.voiceChannelId,
        channelKind: 'voice',
        text: input.text,
        at: Date.now(),
        guildId: input.guildId,
        authorVoiceChannelId: input.voiceChannelId,
        actionNote,
      },
      sink,
      tracer: input.tracer,
      receivedAt: Date.now(),
    });
  }
}
