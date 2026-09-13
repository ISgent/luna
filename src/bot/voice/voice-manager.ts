import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  EndBehaviorType,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import type { Logger } from '../../logging/logger.js';
import type { STTProvider, TTSProvider } from '../../ai/types.js';
import type { AudioOutput } from './tts-player.js';
import { TtsPlayer } from './tts-player.js';
import { EnergyVad } from '../../utils/audio.js';
import { TextPreprocessor } from '../../utils/text.js';
import { RequestTracer } from '../../logging/telemetry.js';

/**
 * VoiceManager — жизненный цикл голосовых подключений (по одной гильдии).
 *
 * Состав на гильдию:
 *  - VoiceConnection (вход в канал; авто-переподключение силами @discordjs/voice)
 *  - AudioPlayer — ЕДИНСТВЕННЫЙ поток воспроизведения (без наложений, ТЗ §39)
 *  - TtsPlayer: очередь предложений → синтез → play (стриминг-озвучка без
 *    стримингового провайдера: говорим, пока модель ещё договаривает)
 *  - Конвейер приёма: opus → PCM → EnergyVad → STT → текст (createUtterancePipeline
 *    и attachOpusSource вынесены так, что тестируются без Discord)
 *  - barge-in: speech_start говорящего глушит воспроизведение (опция конфига)
 */

export interface VoiceGuildConfig {
  vad: { startRms: number; endSilenceMs: number; minSpeechMs: number; maxUtteranceMs: number };
  bargeIn: boolean;
  ttsVoice?: string;
}

export interface UtteranceInput {
  userId: string;
  userName: string;
  text: string;
  guildId: string;
  voiceChannelId: string;
  tracer: RequestTracer;
}

export type UtteranceHandler = (input: UtteranceInput) => void | Promise<void>;

interface GuildVoiceState {
  connection: VoiceConnection;
  player: AudioPlayer;
  tts: TtsPlayer;
  detachUsers: Map<string, () => void>;
}

export interface VoiceManagerDeps {
  stt: STTProvider;
  tts: TTSProvider;
  logger: Logger;
  config: VoiceGuildConfig;
  onUtterance: UtteranceHandler;
  resolveUserName?: (guildId: string, userId: string) => string;
}

/** Проигрывание сырого PCM через AudioPlayer (@discordjs/voice). */
export class DiscordAudioOutput implements AudioOutput {
  constructor(
    private player: AudioPlayer,
    private logger: Logger,
  ) {}

  play(pcmDiscord: Int16Array): Promise<void> {
    const bytes = Buffer.from(pcmDiscord.buffer, pcmDiscord.byteOffset, pcmDiscord.byteLength);
    const resource = createAudioResource(Readable.from([bytes]), {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    this.player.play(resource);
    return new Promise<void>((resolve) => {
      const cleanup = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onError);
      };
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      this.player.once(AudioPlayerStatus.Idle, onIdle);
      this.player.once('error', onError);
    });
  }

  stopAll(): void {
    try {
      this.player.stop(true);
    } catch (e) {
      this.logger.warn({ err: String(e) }, 'audio stop failed');
    }
  }
}

export class VoiceManager {
  private states = new Map<string, GuildVoiceState>();

  constructor(private deps: VoiceManagerDeps) {}

  async join(
    guildId: string,
    voiceChannelId: string,
    adapterCreator?: DiscordGatewayAdapterCreator,
  ): Promise<boolean> {
    if (this.states.has(guildId)) return true;
    if (!adapterCreator) {
      this.deps.logger.error({ guildId }, 'voice: no adapterCreator (бот не на сервере?)');
      return false;
    }
    let connection: VoiceConnection | null = null;
    try {
      connection = joinVoiceChannel({
        channelId: voiceChannelId,
        guildId,
        adapterCreator,
        selfDeaf: false, // Luna должна слышать
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      const player = createAudioPlayer();
      connection.subscribe(player);
      const output = new DiscordAudioOutput(player, this.deps.logger);
      const tts = new TtsPlayer(this.deps.tts, output, {
        logger: this.deps.logger,
        voice: this.deps.config.ttsVoice,
      });

      const state: GuildVoiceState = { connection, player, tts, detachUsers: new Map() };
      this.states.set(guildId, state);

      const conn = connection;
      // Debug-поток голосового соединения: сюда приходят код и причина закрытия WS.
      // Без него любой обрыв выглядит как «бот молча вышел из канала» (так было с 4017
      // «E2EE/DAVE protocol required», когда @discordjs/voice 0.18 ещё не умел DAVE).
      conn.on('debug', (detail) => {
        if (/close|closed|error|fail|4\d{3}|dave|encrypt/i.test(detail)) {
          this.deps.logger.warn({ guildId, detail }, 'voice: debug');
        }
      });
      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // кратковременный разрыв → ждём восстановления, иначе чистим
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this.leaveGuild(guildId);
        }
      });

      this.deps.logger.info({ guildId, voiceChannelId }, 'voice: joined');
      return true;
    } catch (e) {
      this.deps.logger.error(
        {
          err: String(e),
          guildId,
          hint: /abort/i.test(String(e))
            ? 'соединение не дошло до Ready: смотри строки «voice: debug» выше (код закрытия WS) и npm run voice:diag'
            : undefined,
        },
        'voice: join failed',
      );
      try {
        connection?.destroy();
      } catch {
        // уже уничтожен
      }
      this.states.delete(guildId);
      return false;
    }
  }

  getTts(guildId: string): TtsPlayer | undefined {
    return this.states.get(guildId)?.tts;
  }

  getConnection(guildId: string): VoiceConnection | undefined {
    return this.states.get(guildId)?.connection;
  }

  /**
   * Конвейер обработки PCM-кадрей пользователя: VAD → (barge-in) → STT → onUtterance.
   * Чистая логика — Discord-специфика только в attachOpusSource.
   */
  createUtterancePipeline(guildId: string, voiceChannelId: string, userId: string): {
    pushFrame(frame: Int16Array): void;
    forceEnd(): void;
  } {
    const vad = new EnergyVad({
      startRms: this.deps.config.vad.startRms,
      endSilenceMs: this.deps.config.vad.endSilenceMs,
      minSpeechMs: this.deps.config.vad.minSpeechMs,
      maxUtteranceMs: this.deps.config.vad.maxUtteranceMs,
      sampleRate: 48000,
      channels: 2,
    });
    const preprocessor = new TextPreprocessor();
    let inFlight = false;

    const handleSpeechEnd = async (pcm: Int16Array): Promise<void> => {
      if (inFlight) return; // одна фраза за раз на пользователя
      inFlight = true;
      const tracer = new RequestTracer({ kind: 'voice', userId, channelId: voiceChannelId });
      try {
        tracer.mark('stt_start');
        const result = await this.deps.stt.transcribe({ audio: { sampleRate: 48000, channels: 2, data: pcm } });
        tracer.mark('stt_end');
        const text = preprocessor.cleanTranscript(result.text);
        if (!text) return;
        if (this.deps.config.bargeIn) this.states.get(guildId)?.tts.stop();
        const userName = this.deps.resolveUserName?.(guildId, userId) ?? userId;
        await this.deps.onUtterance({ userId, userName, text, guildId, voiceChannelId, tracer });
      } catch (e) {
        tracer.error = String(e);
        this.deps.logger.warn({ err: String(e), userId }, 'voice: STT failed');
      } finally {
        inFlight = false;
      }
    };

    return {
      pushFrame: (frame) => {
        for (const ev of vad.push(frame)) {
          if (ev.type === 'speech_start') {
            // barge-in: пользователь заговорил — Luna замолкает (ТЗ §23/§39)
            if (this.deps.config.bargeIn) this.states.get(guildId)?.tts.stop();
          } else {
            void handleSpeechEnd(ev.pcm);
          }
        }
      },
      forceEnd: () => {
        for (const ev of vad.forceEnd()) {
          if (ev.type === 'speech_end') void handleSpeechEnd(ev.pcm);
        }
      },
    };
  }

  /**
   * Подключает opus-поток пользователя (из VoiceReceiver.subscribe) к конвейеру.
   * Возвращает функцию отключения.
   */
  listenUser(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    subscribe: (userId: string, opts: { end: { behavior: EndBehaviorType } }) => Readable,
  ): () => void {
    const state = this.states.get(guildId);
    if (!state) return () => {};
    if (state.detachUsers.has(userId)) return state.detachUsers.get(userId)!;

    const pipeline = this.createUtterancePipeline(guildId, voiceChannelId, userId);
    const opusStream = subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const onData = (buf: Buffer) => {
      pipeline.pushFrame(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    };
    opusStream.pipe(decoder);
    decoder.on('data', onData);

    const detach = () => {
      try {
        opusStream.unpipe(decoder);
        opusStream.destroy();
      } catch {
        // поток уже закрыт
      }
      decoder.off('data', onData);
      decoder.destroy();
      pipeline.forceEnd();
      state.detachUsers.delete(userId);
    };
    state.detachUsers.set(userId, detach);
    return detach;
  }

  /** Отключить слушателя (вышел из канала). */
  unlistenUser(guildId: string, userId: string): void {
    this.states.get(guildId)?.detachUsers.get(userId)?.();
  }

  leaveGuild(guildId: string): void {
    const state = this.states.get(guildId);
    if (!state) return;
    for (const detach of state.detachUsers.values()) {
      try {
        detach();
      } catch {
        // лучшее усилие
      }
    }
    try {
      state.tts.stop();
      state.connection.destroy();
    } catch {
      // уже отключены
    }
    this.states.delete(guildId);
    this.deps.logger.info({ guildId }, 'voice: left');
  }

  isInVoice(guildId: string): boolean {
    return this.states.has(guildId);
  }

  leaveAll(): void {
    for (const guildId of [...this.states.keys()]) this.leaveGuild(guildId);
  }
}
