/**
 * voice-diag.ts — почему Luna не держится в голосовом канале.
 *
 * Голос Discord — это два независимых канала:
 *   1. WebSocket-сигналинг (gateway op.4 → VOICE_SERVER_UPDATE → wss://<endpoint> → ssrc/ip/port);
 *   2. UDP-медиа: сначала IP discovery (74-байтный пакет с SSRC, в ответ приходит наш внешний
 *      адрес и порт), потом уже сам звук.
 *
 * Симптом «бот заходит и через несколько секунд молча выходит» = не дошёл до Ready,
 * то есть сломан второй канал. Скрипт проверяет их РАЗДЕЛЬНО и руками, без @discordjs/voice:
 * показывает точный адрес/порт голосового сервера, шлёт настоящий discovery-пакет и
 * говорит, пришёл ли ответ. Дополнительно (по умолчанию) повторяет попытку через
 * @discordjs/voice, чтобы было видно тот же самый обрыв на уровне библиотеки.
 *
 * Запуск (бота лучше остановить, чтобы не было двух сессий на один токен):
 *   npm run voice:diag                       — первый голосовой канал сервера
 *   npm run voice:diag -- --channel=Игры     — конкретный канал (название или id)
 *   npm run voice:diag -- --skip-lib         — только ручной разбор, без @discordjs/voice
 *   npm run voice:diag -- --tries=5          — сколько discovery-пакетов послать
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type VoiceBasedChannel,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  StreamType,
  entersState,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { loadConfig } from '../src/config/index.js';

const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const CHANNEL = arg('channel', '');
const TRIES = Math.max(1, Number(arg('tries', '3')) || 3);
const LIB_WAIT_MS = Number(arg('lib-wait', '20')) * 1000;
const SKIP_LIB = has('skip-lib');

const t0 = Date.now();
const ms = (): string => `+${String(Date.now() - t0).padStart(6)}мс`;
const log = (msg: string): void => console.log(`${ms()}  ${msg}`);

interface VoiceServerInfo {
  token: string;
  endpoint: string;
  sessionId: string;
}

interface VoiceReady {
  ssrc: number;
  ip: string;
  port: number;
  modes: string[];
}

/** 2 секунды синусоиды 440 Гц, 48 кГц стерео Int16 — слышимый признак, что медиа-поток пошёл. */
function tonePcm(): Buffer {
  const frames = 48000 * 2;
  const buf = Buffer.alloc(frames * 2 * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

/**
 * Отправка raw-пакета в gateway. В discord.js 14.27 `client.ws` — своя обёртка
 * с методом broadcast; на случай другой версии оставлен путь через @discordjs/ws.
 */
function sendGateway(client: Client, op: number, d: unknown): void {
  const payload = { op, d };
  const ws = client.ws as unknown as {
    broadcast?: (packet: unknown) => unknown;
    _ws?: { send?: (shardId: number, packet: unknown) => unknown };
    send?: (shardId: number, packet: unknown) => unknown;
  };
  if (typeof ws.broadcast === 'function') {
    ws.broadcast(payload);
    return;
  }
  if (typeof ws._ws?.send === 'function') {
    ws._ws.send(0, payload);
    return;
  }
  if (typeof ws.send === 'function') {
    ws.send(0, payload);
    return;
  }
  throw new Error('не нашёл способа отправить raw-пакет в gateway (client.ws)');
}

/** Пакет IP discovery: type=1, length=70, ssrc, пустой адрес, порт 0, режим 0. */
function discoveryRequest(ssrc: number): Buffer {
  const buf = Buffer.alloc(74);
  buf.writeUInt16BE(0x1, 0);
  buf.writeUInt16BE(70, 2);
  buf.writeUInt32BE(ssrc >>> 0, 4);
  return buf;
}

/** Один discovery-запрос: ждём ответ type=2 с нашим внешним адресом. */
function probeDiscovery(ip: string, port: number, ssrc: number, timeoutMs: number): Promise<{
  ok: boolean;
  ms: number;
  externalIp?: string;
  externalPort?: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = dgram.createSocket('udp4');
    const done = (r: { ok: boolean; externalIp?: string; externalPort?: number; error?: string }) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // уже закрыт
      }
      resolve({ ...r, ms: Date.now() - started });
    };
    const timer = setTimeout(() => done({ ok: false, error: `нет ответа за ${timeoutMs}мс` }), timeoutMs);
    sock.once('message', (msg) => {
      if (msg.length < 8) return done({ ok: false, error: `короткий ответ (${msg.length} байт)` });
      const type = msg.readUInt16BE(0);
      if (type !== 0x2) return done({ ok: false, error: `ответ не того типа: 0x${type.toString(16)}` });
      const addrPart = msg.subarray(8, 72);
      const zero = addrPart.indexOf(0);
      const externalIp = addrPart.subarray(0, zero < 0 ? addrPart.length : zero).toString('utf8');
      const externalPort = msg.length >= 74 ? msg.readUInt16BE(72) : 0;
      done({ ok: true, externalIp, externalPort });
    });
    sock.on('error', (e) => done({ ok: false, error: `ошибка сокета: ${e.message}` }));
    sock.send(discoveryRequest(ssrc), port, ip, (e) => {
      if (e) done({ ok: false, error: `не удалось отправить: ${e.message}` });
    });
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.discord.token || !cfg.discord.guildId) {
    console.error('Нужны DISCORD_TOKEN и GUILD_ID в .env');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  log('подключаюсь к Discord (gateway)…');
  await client.login(cfg.discord.token);
  log(`вошёл как ${client.user?.tag}`);

  const guild = await client.guilds.fetch(cfg.discord.guildId);
  const channels = await guild.channels.fetch();
  const voiceChannels = [...channels.values()].filter(
    (c): c is VoiceBasedChannel => !!c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice),
  );
  if (voiceChannels.length === 0) {
    log('на сервере нет голосовых каналов');
    await client.destroy();
    process.exit(1);
  }
  const target =
    (CHANNEL && voiceChannels.find((c) => c.name === CHANNEL || c.id === CHANNEL)) || voiceChannels[0]!;
  const humans = target.members.filter((m) => !m.user.bot);
  log(`голосовые каналы: ${voiceChannels.map((c) => c.name).join(', ')}`);
  log(`цель: «${target.name}» (${target.id}), регион: ${target.rtcRegion ?? 'авто'}`);
  log(`в канале людей: ${humans.size}${humans.size ? ' (' + humans.map((m) => m.displayName).join(', ') + ')' : ''}`);

  // ---------- фаза 1: сигналинг и UDP своими руками ----------
  console.log('\n── фаза 1: рукопожатие с голосовым сервером (без @discordjs/voice) ──');

  const serverInfo = await new Promise<VoiceServerInfo | null>((resolve) => {
    let token: string | null = null;
    let endpoint: string | null = null;
    let sessionId: string | null = null;
    // discord.js типизирует 'raw' своим пакетом; нам нужен только {t, d}
    const emitter = client as unknown as {
      on: (event: 'raw', fn: (packet: unknown) => void) => void;
      off: (event: 'raw', fn: (packet: unknown) => void) => void;
    };
    const timer = setTimeout(() => resolve(null), 15_000);
    const finish = () => {
      if (token && endpoint && sessionId) {
        clearTimeout(timer);
        emitter.off('raw', onRaw);
        resolve({ token, endpoint, sessionId });
      }
    };
    const onRaw = (packet: unknown) => {
      const p = packet as { t?: string; d?: Record<string, unknown> };
      const d = p.d ?? {};
      if (p.t === 'VOICE_SERVER_UPDATE') {
        token = String(d.token ?? '');
        endpoint = String(d.endpoint ?? '');
        log(`получен VOICE_SERVER_UPDATE: endpoint=${endpoint || '(пусто!)'}`);
        finish();
      } else if (p.t === 'VOICE_STATE_UPDATE' && d.user_id === client.user?.id) {
        sessionId = String(d.session_id ?? '');
        finish();
      }
    };
    emitter.on('raw', onRaw);
    log('прошу у gateway голосовую сессию (op.4)…');
    sendGateway(client, 4, {
      guild_id: guild.id,
      channel_id: target.id,
      self_mute: false,
      self_deaf: false,
    });
  });

  if (!serverInfo) {
    log('✘ gateway не выдал полную голосовую сессию за 15с (нет endpoint или session_id)');
    log('  → проблема на уровне signaling: Discord не назначил голосовой сервер');
    await leaveChannel(client, guild.id);
    await client.destroy();
    process.exit(2);
  }
  if (!serverInfo.endpoint) {
    log('✘ endpoint пустой — Discord не отдал голосовой сервер (обычно значит, что регион недоступен)');
    await leaveChannel(client, guild.id);
    await client.destroy();
    process.exit(2);
  }

  const host = serverInfo.endpoint.replace(/:\d+$/, '');
  const ips = await dns.promises.resolve4(host).catch((e: NodeJS.ErrnoException) => {
    log(`✘ не удалось разрешить ${host}: ${e.code ?? e.message}`);
    return [] as string[];
  });
  log(`адрес голосового сервера: ${host} → ${ips.join(', ') || '(нет A-записи)'}`);

  let closeCode: number | undefined;
  const ready = await new Promise<VoiceReady | null>((resolve) => {
    // endpoint приходит вместе с портом (например host.discord.media:2053) — используем как есть
    const url = `wss://${serverInfo.endpoint}/?v=4`;
    log(`открываю голосовой WebSocket: ${url}`);
    const ws = new WebSocket(url);
    let identified = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (value: VoiceReady | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(v4Fallback);
      if (heartbeat) clearInterval(heartbeat);
      resolve(value);
    };
    const timer = setTimeout(() => {
      log('✘ голосовой WebSocket не дал Ready за 20с');
      try {
        ws.close();
      } catch {
        // уже закрыт
      }
      finish(null);
    }, 20_000);
    const identify = (why: string) => {
      if (identified) return;
      identified = true;
      ws.send(
        JSON.stringify({
          op: 0,
          d: {
            server_id: guild.id,
            user_id: client.user?.id,
            session_id: serverInfo.sessionId,
            token: serverInfo.token,
          },
        }),
      );
      log(`  → identify (op.0) ${why}`);
    };
    // На v8+ сервер ЖДЁТ identify после hello и требует сердцебиение — иначе Ready не пришлёт.
    const v4Fallback = setTimeout(() => identify('без hello (старый порядок v4)'), 3_000);

    ws.addEventListener('open', () => log('  ✔ голосовой WebSocket открыт'));
    ws.addEventListener('message', (ev) => {
      const packet = JSON.parse(String(ev.data)) as {
        op: number;
        d?: VoiceReady & { heartbeat_interval?: number };
      };
      if (packet.op === 8) {
        const interval = packet.d?.heartbeat_interval ?? 13_750;
        log(`  ← hello (op.8), сердцебиение каждые ${interval}мс`);
        heartbeat = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 3, d: Date.now() }));
          } catch {
            // сокет закрывается
          }
        }, interval);
        identify('после hello');
      } else if (packet.op === 2 && packet.d) {
        log('  ← Ready (op.2)');
        finish(packet.d);
      } else if (packet.op === 11) {
        log('  ← ack сердцебиения (op.11)');
      } else if (packet.op === 9) {
        log('  ← op.9 (identify не принят) — пробую ещё раз');
        identified = false;
        identify('повторно после op.9');
      } else {
        log(`  ← op.${packet.op}`);
      }
    });
    ws.addEventListener('error', (e) => {
      const err = e as { message?: string };
      log(`  ✘ ошибка голосового WebSocket: ${String(err.message ?? e)}`);
      finish(null);
    });
    ws.addEventListener('close', (e) => {
      const ev = e as { code?: number; reason?: string };
      closeCode = ev.code;
      log(`  ⚠ голосовой WebSocket закрыт: code=${ev.code ?? '?'} ${ev.reason ?? ''}`.trimEnd());
      finish(null);
    });
  });

  // 4017 = Discord требует сквозное шифрование DAVE. Этот пробник DAVE не реализует,
  // поэтому такой исход — не поломка сети, а ожидаемое поведение: вердикт даёт фаза 3.
  const daveRequired = !ready && closeCode === 4017;
  if (!ready && !daveRequired) {
    log('✘ не получили Ready от голосового сервера — UDP проверять не на чем');
    log(`  Вывод: обрыв на signaling-этапе (WSS до голосового сервера), код закрытия ${closeCode ?? 'неизвестен'}.`);
    await leaveChannel(client, guild.id);
    await client.destroy();
    process.exit(2);
  }
  if (daveRequired) {
    log('✘ Ready не получен: код 4017 «E2EE/DAVE protocol required» — Discord требует шифрование DAVE.');
    log('  Ручной пробник DAVE не реализует, поэтому фаза 2 (UDP) пропускается — вердикт даст фаза 3.');
  }

  let discovered = false;
  if (ready) {
    log(`✔ Ready: ssrc=${ready.ssrc}, медиа-адрес ${ready.ip}:${ready.port}`);
    log(`  режимы шифрования: ${ready.modes.join(', ')}`);

    console.log('\n── фаза 2: UDP IP discovery (именно здесь обычно всё и виснет) ──');
    for (let i = 1; i <= TRIES; i++) {
      const r = await probeDiscovery(ready.ip, ready.port, ready.ssrc, 6000);
      if (r.ok) {
        log(`✔ попытка ${i}: ответ за ${r.ms}мс — Discord видит нас как ${r.externalIp}:${r.externalPort}`);
        discovered = true;
        break;
      }
      log(`✘ попытка ${i}: ${r.error}`);
    }

    if (discovered) {
      log('ВЫВОД: UDP до голосового сервера ПРОХОДИТ.');
    } else {
      log(
        `ВЫВОД: UDP до ${ready.ip}:${ready.port} НЕ ПРОХОДИТ (${TRIES} пакет(а) без ответа). ` +
          'Signaling при этом работает — значит, дело в сети между машиной и голосовым сервером: ' +
          'туннель (WARP/VPN), роутер, провайдер или блокировка.',
      );
      log(`  для диагностики у провайдера/VPN: ${host} → ${ips.join(', ')}, порт ${ready.port}, протокол UDP.`);
    }
  }

  await leaveChannel(client, guild.id);

  // ---------- фаза 3: то же самое через @discordjs/voice ----------
  let verdictOk = discovered;
  if (!SKIP_LIB) {
    console.log('\n── фаза 3: попытка через @discordjs/voice (как это делает Luna) ──');
    const connection = joinVoiceChannel({
      channelId: target.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on('debug', (m) => {
      if (/udp|discover|ssrc|close|error/i.test(m)) log(`  [debug] ${m}`);
    });
    connection.on('stateChange', (from: { status: string }, to: { status: string }) =>
      log(`состояние: ${from.status} → ${to.status}`),
    );
    let libReady = false;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, LIB_WAIT_MS);
      libReady = true;
      log(`✔ @discordjs/voice дошёл до Ready за ${Date.now() - t0}мс`);
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.play(
        createAudioResource(Readable.from([tonePcm()]), { inputType: StreamType.Raw, inlineVolume: false }),
      );
      await entersState(player, AudioPlayerStatus.Playing, 10_000);
      log('✔ исходящий звук пошёл (2 секунды тона 440 Гц) — если ты в канале, ты его услышал');
      await entersState(player, AudioPlayerStatus.Idle, 15_000).catch(() => undefined);
    } catch (e) {
      log(`✘ @discordjs/voice НЕ дошёл до Ready за ${LIB_WAIT_MS / 1000}с: ${String(e)}`);
      log('  это ровно то, что видит Luna: timeout → destroy → «молча вышла из канала»');
    }
    try {
      connection.destroy();
    } catch {
      // уже уничтожено
    }
    log(
      libReady
        ? 'ИТОГ: голос работает — библиотека договорилась с Discord (включая DAVE/E2EE).'
        : daveRequired
          ? 'ИТОГ: Discord требует DAVE, а @discordjs/voice до Ready не дошёл. Лечится версией библиотеки (DAVE есть с 0.19.0), а не настройками сети.'
          : discovered
            ? 'ИТОГ: сеть в порядке, проблема в @discordjs/voice/коде — есть что чинить.'
            : 'ИТОГ: сеть не пускает UDP до голосовых серверов Discord. Код Luna ни при чём.',
    );
    verdictOk = libReady;
  } else if (daveRequired) {
    log('\nИТОГ: фаза 3 пропущена (--skip-lib), а без неё при коде 4017 вывод сделать нельзя.');
    verdictOk = false;
  }

  await client.destroy();
  process.exit(verdictOk ? 0 : 2);
}

/** Вежливо выходим из голосового канала (op.4 с channel_id: null). */
async function leaveChannel(client: Client, guildId: string): Promise<void> {
  try {
    sendGateway(client, 4, {
      guild_id: guildId,
      channel_id: null,
      self_mute: true,
      self_deaf: true,
    });
    await new Promise((r) => setTimeout(r, 500));
    log('вышел из голосового канала');
  } catch {
    // соединение уже закрыто
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
