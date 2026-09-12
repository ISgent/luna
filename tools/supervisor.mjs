/**
 * Luna Supervisor — фоновый смотритель бота + веб-панель управления.
 *
 * Запускается без окна (wscript start-supervisor.vbs) или вручную (node tools/supervisor.mjs).
 * Умеет: старт/стоп/рестарт бота, авто-перезапуск при падении (с защитой от crash-loop),
 * лог в файл + ротация, автозапуск при входе в Windows (папка Startup, без админа),
 * правка основных настроек .env, сборка (npm run build), статус «онлайн» по логу бота.
 *
 * Панель: http://127.0.0.1:8787 (только localhost — наружу не слушает).
 *
 * Env-переменные (в основном для тестов):
 *   LUNA_PANEL_PORT  — порт панели (0 = случайный; фактический печатается как PANEL_PORT=<n>)
 *   LUNA_DATA_DIR    — каталог данных (default <root>/data)
 *   LUNA_ENV_FILE    — путь к .env (default <root>/.env)
 *   LUNA_STARTUP_DIR — папка автозапуска (default Startup из APPDATA)
 *   LUNA_BOT_CMD / LUNA_BOT_ARGS(JSON) — чем запускать бота (default node dist/index.js)
 * Флаг --auto: сразу стартовать бота, если в panel.json включён autostartBot.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.LUNA_DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'luna.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const PANEL_FILE = path.join(DATA_DIR, 'panel.json');
const ENV_FILE = process.env.LUNA_ENV_FILE || path.join(ROOT, '.env');
const STARTUP_DIR =
  process.env.LUNA_STARTUP_DIR ||
  path.join(process.env.APPDATA ?? os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_FILE = path.join(STARTUP_DIR, 'Luna-supervisor.vbs');
const BOT_CMD = process.env.LUNA_BOT_CMD || process.execPath;
const BOT_ARGS = process.env.LUNA_BOT_ARGS ? JSON.parse(process.env.LUNA_BOT_ARGS) : [path.join('dist', 'index.js')];
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.js');
const PORT = Number(process.env.LUNA_PANEL_PORT || 8787);
const AUTO_FLAG = process.argv.includes('--auto');
const RING_LIMIT = 500;

// ---------- состояние ----------

/** @type {{child: import('node:child_process').ChildProcess | null, stopping: boolean, online: boolean, startedAt: number|null, restarts: number, crashLoop: boolean}} */
const state = { child: null, stopping: false, online: false, startedAt: null, restarts: 0, crashLoop: false };
const restartTimes = [];
const ring = [];
let restartTimer = null;

function panelConfig() {
  try {
    const raw = JSON.parse(readFileSync(PANEL_FILE, 'utf8'));
    return { autostartBot: raw.autostartBot !== false, autoRestart: raw.autoRestart !== false };
  } catch {
    return { autostartBot: true, autoRestart: true };
  }
}

function savePanelConfig(cfg) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PANEL_FILE, JSON.stringify({ ...panelConfig(), ...cfg }, null, 2));
}

// ---------- лог ----------

function appendLog(line) {
  const stamp = new Date().toISOString();
  const full = `[${stamp}] ${line}`;
  ring.push(full);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.old`); // одна старая копия, без бесконечного роста
    }
    writeFileSync(LOG_FILE, full + '\n', { flag: 'a' });
  } catch {
    // лог не критичен для управления
  }
}

function logTail(n) {
  return ring.slice(-Math.max(1, Math.min(n || 200, RING_LIMIT)));
}

// ---------- управление ботом ----------

function distReady() {
  return existsSync(DIST_ENTRY);
}

function startBot() {
  if (state.child) return { ok: true, already: true };
  const isDefaultEntry = BOT_CMD === process.execPath && BOT_ARGS.length === 1 && BOT_ARGS[0].endsWith(path.join('dist', 'index.js'));
  if (isDefaultEntry && !distReady()) {
    return { ok: false, error: 'Нет сборки: запустите «Собрать» в панели (или npm run build).' };
  }
  state.stopping = false;
  state.online = false;
  const child = spawn(BOT_CMD, BOT_ARGS, { cwd: ROOT, windowsHide: true, env: { ...process.env } });
  state.child = child;
  state.startedAt = Date.now();
  appendLog(`[supervisor] бот запущен (pid ${child.pid})`);

  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line.trim()) continue;
      appendLog(line);
      if (line.includes('discord: ready')) state.online = true;
      if (line.includes('FATAL')) state.online = false;
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('exit', (code) => {
    appendLog(`[supervisor] бот остановился (code ${code})`);
    state.child = null;
    state.online = false;
    const wasStopping = state.stopping;
    state.stopping = false;
    state.startedAt = null;
    if (wasStopping) return;
    const cfg = panelConfig();
    if (!cfg.autoRestart || state.crashLoop) return;
    // защита от crash-loop: >5 авто-перезапусков за минуту — останавливаемся и ждём человека
    const now = Date.now();
    restartTimes.push(now);
    while (restartTimes.length && now - restartTimes[0] > 60_000) restartTimes.shift();
    state.restarts++;
    if (restartTimes.length > 5) {
      state.crashLoop = true;
      appendLog('[supervisor] crash-loop: 5+ падений за минуту, авто-перезапуск выключен. Смотрите лог выше.');
      return;
    }
    appendLog('[supervisor] перезапуск через 3с…');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!state.child && !state.stopping) startBot();
    }, 3000);
  });

  return { ok: true, pid: child.pid };
}

async function stopBot() {
  // отменяем запланированный авто-рестарт, иначе «стоп» в паузе между падениями не сработает
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const child = state.child;
  if (!child) return { ok: true, already: true };
  state.stopping = true;
  appendLog('[supervisor] останавливаю бота…');
  // надёжное снятие дерева процессов на Windows
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    const t = setTimeout(resolve, 5000);
    killer.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
    killer.on('error', () => {
      clearTimeout(t);
      try {
        child.kill('SIGKILL');
      } catch {
        // уже мёртв
      }
      resolve();
    });
  });
  return { ok: true };
}

async function runBuild() {
  appendLog('[supervisor] npm run build…');
  return new Promise((resolve) => {
    const p = spawn('npm run build', { cwd: ROOT, shell: true, windowsHide: true });
    const out = [];
    const onData = (b) => {
      const s = String(b);
      out.push(s);
      for (const line of s.split(/\r?\n/)) if (line.trim()) appendLog(`[build] ${line}`);
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.on('exit', (code) => resolve({ ok: code === 0, code }));
    p.on('error', (e) => resolve({ ok: false, code: -1, error: String(e) }));
  });
}

// ---------- автозапуск (Startup folder) ----------

function autostartEnabled() {
  return existsSync(STARTUP_FILE);
}

function setAutostart(enabled) {
  if (enabled) {
    mkdirSync(STARTUP_DIR, { recursive: true });
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${ROOT}"`,
      `sh.Run "node ""${path.join(ROOT, 'tools', 'supervisor.mjs')}"" --auto", 0, False`,
      '',
    ].join('\r\n');
    writeFileSync(STARTUP_FILE, vbs);
    appendLog('[supervisor] автозапуск включён (Startup/Luna-supervisor.vbs)');
  } else if (existsSync(STARTUP_FILE)) {
    rmSync(STARTUP_FILE, { force: true });
    appendLog('[supervisor] автозапуск выключен');
  }
}

// ---------- правка .env (белый список) ----------

const ENV_EDITABLE = ['TTS_VOICE', 'LLM_MODEL', 'LLM_BACKGROUND_MODEL', 'LOG_LEVEL'];

function readEnv() {
  const out = {};
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // файла может не быть
  }
  return out;
}

function writeEnv(values) {
  let lines = [];
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_EDITABLE.includes(key)) continue;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join('\r\n'));
}

// ---------- HTTP ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function statusPayload() {
  const cfg = panelConfig();
  return {
    supervisor: 'ok',
    bot: {
      state: state.crashLoop && !state.child ? 'crash-loop' : state.child ? 'running' : 'stopped',
      online: state.online,
      pid: state.child?.pid ?? null,
      startedAt: state.startedAt,
      uptimeSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
      restarts: state.restarts,
    },
    distReady: distReady(),
    autostart: { enabled: autostartEnabled(), autostartBot: cfg.autostartBot, autoRestart: cfg.autoRestart },
    envFile: ENV_FILE,
    logFile: LOG_FILE,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1`);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /') {
      const html = readFileSync(path.join(ROOT, 'tools', 'panel.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (route === 'GET /api/status') return json(res, 200, statusPayload());
    if (route === 'GET /api/logs') return json(res, 200, { lines: logTail(Number(url.searchParams.get('tail') || 200)) });
    if (route === 'POST /api/start') {
      const r = startBot();
      return json(res, r.ok ? 200 : 409, r);
    }
    if (route === 'POST /api/stop') return json(res, 200, await stopBot());
    if (route === 'POST /api/restart') {
      await stopBot();
      state.crashLoop = false;
      restartTimes.length = 0;
      return json(res, 200, startBot());
    }
    if (route === 'POST /api/build') return json(res, 200, await runBuild());
    if (route === 'GET /api/autostart') {
      const cfg = panelConfig();
      return json(res, 200, { enabled: autostartEnabled(), autostartBot: cfg.autostartBot, autoRestart: cfg.autoRestart });
    }
    if (route === 'POST /api/autostart') {
      const b = await readBody(req);
      if (typeof b.enabled === 'boolean') setAutostart(b.enabled);
      const patch = {};
      if (typeof b.autostartBot === 'boolean') patch.autostartBot = b.autostartBot;
      if (typeof b.autoRestart === 'boolean') patch.autoRestart = b.autoRestart;
      if (Object.keys(patch).length) savePanelConfig(patch);
      const cfg = panelConfig();
      return json(res, 200, { enabled: autostartEnabled(), autostartBot: cfg.autostartBot, autoRestart: cfg.autoRestart });
    }
    if (route === 'GET /api/config') {
      const env = readEnv();
      const out = {};
      for (const k of ENV_EDITABLE) out[k] = env[k] ?? '';
      return json(res, 200, out);
    }
    if (route === 'POST /api/config') {
      const b = await readBody(req);
      writeEnv(b.values ?? {});
      if (b.apply && state.child) {
        await stopBot();
        startBot();
      }
      return json(res, 200, { ok: true, restarted: !!b.apply });
    }
    if (route === 'POST /api/shutdown') {
      json(res, 200, { ok: true });
      appendLog('[supervisor] завершаюсь по запросу панели');
      setTimeout(async () => {
        await stopBot();
        process.exit(0);
      }, 100);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    appendLog(`[supervisor] ошибка запроса: ${String(e)}`);
    json(res, 500, { error: String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // супервизор уже работает — тихо выходим (этим пользуется Luna.bat)
    process.exit(0);
  }
  console.error('supervisor http error:', e);
  process.exit(1);
});

mkdirSync(LOG_DIR, { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  const realPort = server.address().port;
  console.log(`PANEL_PORT=${realPort}`);
  console.log(`Luna supervisor: панель на http://127.0.0.1:${realPort}`);
  appendLog(`[supervisor] стартовал, порт ${realPort}, bot=${BOT_CMD} ${BOT_ARGS.join(' ')}`);
  if (AUTO_FLAG && panelConfig().autostartBot) {
    setTimeout(() => startBot(), 500);
  }
});

process.on('uncaughtException', (e) => {
  appendLog(`[supervisor] uncaught: ${String(e)}`);
});
