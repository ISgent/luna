import { loadConfig, assertBotRuntime } from './config/index.js';
import { createLogger } from './logging/logger.js';
import { buildSystem } from './system.js';
import { VoiceManager } from './bot/voice/voice-manager.js';
import { LunaDiscordBot } from './bot/discord/client.js';
import { createVoiceTools } from './bot/discord/quick-actions.js';
import type { CommandContext } from './bot/commands/commands.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertBotRuntime(cfg);

  const logger = createLogger({ level: cfg.logging.level, pretty: cfg.logging.pretty });
  logger.info('Luna запускается…');

  const sys = buildSystem(cfg, { logger });

  let botRef: LunaDiscordBot | null = null;

  const voice = cfg.voice.enabled
    ? new VoiceManager({
        stt: sys.providers.stt,
        tts: sys.providers.tts,
        logger,
        config: { vad: cfg.voice.vad, bargeIn: cfg.voice.bargeIn, ttsVoice: cfg.tts.voice },
        resolveUserName: (_guildId, userId) => {
          const u = sys.repos.users.get(userId);
          return u?.displayName || u?.username || userId;
        },
        onUtterance: async (input) => {
          await botRef?.handleVoiceUtterance(input);
        },
      })
    : null;

  // Инструменты модели (tool calling): Luna сама может зайти/выйти из голоса,
  // замолчать, включить/выключить озвучку — по любой человеческой формулировке.
  if (voice) {
    for (const tool of createVoiceTools({
      voice,
      settings: sys.repos.settings,
      voiceEnabled: cfg.voice.enabled,
      adapterFor: (guildId) => botRef?.client.guilds.cache.get(guildId)?.voiceAdapterCreator,
      logger,
    })) {
      sys.tools.register(tool);
    }
  }

  const commandCtx: CommandContext = {
    memory: sys.memory,
    relationships: sys.relationships,
    emotions: sys.emotions,
    repos: sys.repos,
    config: cfg,
    voice,
    adapterFor: (guildId) => botRef?.client.guilds.cache.get(guildId)?.voiceAdapterCreator,
  };

  const bot = new LunaDiscordBot({
    config: cfg,
    logger,
    manager: sys.manager,
    queue: sys.queue,
    voice,
    commands: commandCtx,
    repos: sys.repos,
    telemetry: sys.telemetry,
  });
  botRef = bot;

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'остановка…');
    try {
      await bot.stop();
      await sys.shutdown();
    } catch (e) {
      logger.warn({ err: String(e) }, 'shutdown error');
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection');
  });

  await bot.start();
  logger.info(
    {
      llm: `${cfg.llm.model} @ ${cfg.llm.baseUrl}`,
      backgroundLlm: cfg.llm.backgroundModel,
      tts: `${cfg.tts.provider}:${cfg.tts.model}:${cfg.tts.voice} (enabled=${cfg.tts.enabled})`,
      stt: `${cfg.stt.provider}:${cfg.stt.model}`,
      memory: `enabled=${cfg.memory.enabled} mode=${cfg.memory.retrievalMode}`,
      voice: cfg.voice.enabled,
      db: cfg.db.path,
    },
    'Luna на связи',
  );

  // Прогрев соединений провайдеров (TLS/keep-alive): первый живой запрос
  // пользователя не платит за холодный старт. Ошибки глушатся — это не критичный путь.
  void sys.providers.llm.healthCheck().then((ok) => logger.debug({ ok }, 'llm warmup'));
  if (cfg.memory.enabled) {
    void sys.providers.embeddings.healthCheck().then((ok) => logger.debug({ ok }, 'embeddings warmup'));
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FATAL:', e);
  process.exit(1);
});
