/**
 * Интеграционные тесты супервизора панели управления.
 * Поднимают РЕАЛЬНЫЙ процесс tools/supervisor.mjs с фейковым ботом
 * (эфемерный порт, временные каталоги — Startup и .env не трогаем)
 * и проверяют API: статус, старт/стоп, онлайн-детект, автозапуск,
 * настройки, авто-рестарт при падении, shutdown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SUPERVISOR = path.resolve(process.cwd(), 'tools', 'supervisor.mjs');

interface Sup {
  proc: ChildProcess;
  port: number;
  startupDir: string;
  envFile: string;
  api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }>;
  kill(): void;
}

const spawned: Sup[] = [];
const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'luna-sup-'));
  tmpDirs.push(dir);
  return dir;
}

async function startSupervisor(botScript: string, extraEnv: Record<string, string> = {}): Promise<Sup> {
  const tmp = makeTmp();
  const dataDir = path.join(tmp, 'data');
  const startupDir = path.join(tmp, 'startup');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(startupDir, { recursive: true });
  const envFile = path.join(tmp, '.env');
  writeFileSync(envFile, 'TTS_VOICE=Cherry\nLLM_MODEL=qwen-flash\n');

  const proc = spawn(process.execPath, [SUPERVISOR], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      LUNA_PANEL_PORT: '0',
      LUNA_DATA_DIR: dataDir,
      LUNA_ENV_FILE: envFile,
      LUNA_STARTUP_DIR: startupDir,
      LUNA_BOT_CMD: process.execPath,
      LUNA_BOT_ARGS: JSON.stringify([botScript]),
      ...extraEnv,
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('supervisor не поднялся за 10с')), 10_000);
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/PANEL_PORT=(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`supervisor вышел рано, code=${code}`));
    });
  });

  const sup: Sup = {
    proc,
    port,
    startupDir,
    envFile,
    async api(method, p, body) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
    kill() {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        proc.kill('SIGKILL');
      }
    },
  };
  spawned.push(sup);
  return sup;
}

async function pollUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 15_000, stepMs = 200): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

let aliveBot: string;
let crashBot: string;
/** Заглушка скрипта сброса: печатает ту же строку-маркер, что и dist/luna/factory-reset.js. */
let resetStub: string;
let resetFailStub: string;
/** Заглушки страницы «Люди и память»: эхо действия и аргументов, отказ и падение. */
let peopleStub: string;
let peopleErrStub: string;
let peopleFailStub: string;

beforeAll(() => {
  const dir = makeTmp();
  aliveBot = path.join(dir, 'alive-bot.mjs');
  crashBot = path.join(dir, 'crash-bot.mjs');
  resetStub = path.join(dir, 'reset-stub.mjs');
  resetFailStub = path.join(dir, 'reset-fail-stub.mjs');
  peopleStub = path.join(dir, 'people-stub.mjs');
  peopleErrStub = path.join(dir, 'people-err-stub.mjs');
  peopleFailStub = path.join(dir, 'people-fail-stub.mjs');
  writeFileSync(aliveBot, "console.log('discord: ready'); setInterval(() => {}, 1000);\n");
  writeFileSync(crashBot, "console.log('crash-bot starting'); setTimeout(() => process.exit(1), 250);\n");
  writeFileSync(
    resetStub,
    "console.log('FACTORY_RESET_RESULT=' + JSON.stringify({ ok: true, memories: 3, summaries: 1, relationships: 2, emotions: 'baseline', ownerSeeded: true }));\n",
  );
  writeFileSync(resetFailStub, "console.log('что-то пошло не так'); process.exit(2);\n");
  // инструмент людей: читает аргументы из stdin, отвечает строкой-маркером (как dist/luna/people-tool.js)
  writeFileSync(
    peopleStub,
    "let raw='';process.stdin.on('data',(d)=>{raw+=d;});process.stdin.on('end',()=>{" +
      "const a=(process.argv.find((x)=>x.startsWith('--action='))||'').slice(9);" +
      "console.log('PEOPLE_TOOL_RESULT='+JSON.stringify({ok:true,action:a,payload:raw?JSON.parse(raw):{}}));});\n",
  );
  writeFileSync(peopleErrStub, "process.stdin.resume();console.log('PEOPLE_TOOL_RESULT={\"ok\":false,\"error\":\"такого человека нет\"}');\n");
  writeFileSync(peopleFailStub, "process.stdin.resume();console.error('boom');process.exit(3);\n");
});

afterAll(() => {
  for (const s of spawned) s.kill();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Supervisor API', () => {
  it('панель отдаётся, статус — бот остановлен', async () => {
    const sup = await startSupervisor(aliveBot);
    const html = await fetch(`http://127.0.0.1:${sup.port}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('Luna');

    const { data } = await sup.api('GET', '/api/status');
    expect(data.supervisor).toBe('ok');
    expect(data.bot.state).toBe('stopped');
    expect(data.autostart).toBeDefined();
  });

  it('start → running → online (по строке лога «discord: ready»), stop → stopped', async () => {
    const sup = await startSupervisor(aliveBot);
    const started = await sup.api('POST', '/api/start');
    expect(started.data.ok).toBe(true);

    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.online === true);
    let { data } = await sup.api('GET', '/api/status');
    expect(data.bot.state).toBe('running');
    expect(data.bot.pid).toBeGreaterThan(0);
    expect(data.bot.uptimeSec).toBeGreaterThanOrEqual(0);

    const { data: logs } = await sup.api('GET', '/api/logs?tail=100');
    expect(logs.lines.join('\n')).toContain('discord: ready');

    await sup.api('POST', '/api/stop');
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.state === 'stopped');
    ({ data } = await sup.api('GET', '/api/status'));
    expect(data.bot.state).toBe('stopped');
  });

  it('автозапуск: вкл/выкл создаёт и удаляет vbs в (псевдо)Startup', async () => {
    const sup = await startSupervisor(aliveBot);
    const vbs = path.join(sup.startupDir, 'Luna-supervisor.vbs');
    expect(existsSync(vbs)).toBe(false);

    const on = await sup.api('POST', '/api/autostart', { enabled: true });
    expect(on.data.enabled).toBe(true);
    expect(existsSync(vbs)).toBe(true);
    // vbs пишется UTF-16 LE с BOM: WSH без BOM читает его как ANSI и ломает кириллицу в пути
    const content = readFileSync(vbs, 'utf16le');
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content).toContain('supervisor.mjs');
    expect(content).toContain('--auto');

    const off = await sup.api('POST', '/api/autostart', { enabled: false });
    expect(off.data.enabled).toBe(false);
    expect(existsSync(vbs)).toBe(false);
  });

  it('флаги autostartBot/autoRestart сохраняются в panel.json', async () => {
    const sup = await startSupervisor(aliveBot);
    await sup.api('POST', '/api/autostart', { autostartBot: false, autoRestart: false });
    const { data } = await sup.api('GET', '/api/autostart');
    expect(data.autostartBot).toBe(false);
    expect(data.autoRestart).toBe(false);
  });

  it('config: белый список ключей .env читается и обновляется', async () => {
    const sup = await startSupervisor(aliveBot);
    const before = await sup.api('GET', '/api/config');
    expect(before.data.TTS_VOICE).toBe('Cherry');

    await sup.api('POST', '/api/config', { values: { TTS_VOICE: 'Serena', LOG_LEVEL: 'debug', DISCORD_TOKEN: 'hacked' } });
    const after = await sup.api('GET', '/api/config');
    expect(after.data.TTS_VOICE).toBe('Serena');
    expect(after.data.LOG_LEVEL).toBe('debug');

    // файл реально обновлён, а НЕ-белый ключ (DISCORD_TOKEN) не записан
    const envContent = readFileSync(sup.envFile, 'utf8');
    expect(envContent).toContain('TTS_VOICE=Serena');
    expect(envContent).toContain('LOG_LEVEL=debug');
    expect(envContent).not.toContain('hacked');
  });

  it('падение бота → авто-рестарт (restarts растёт)', async () => {
    const sup = await startSupervisor(crashBot);
    await sup.api('POST', '/api/start');
    await pollUntil(
      async () => (await sup.api('GET', '/api/status')).data.bot.restarts >= 2,
      25_000,
      400,
    );
    const { data } = await sup.api('GET', '/api/status');
    expect(data.bot.restarts).toBeGreaterThanOrEqual(2);
    await sup.api('POST', '/api/stop');
  });

  it('reset-memory: без слова-подтверждения сброс не выполняется', async () => {
    const sup = await startSupervisor(aliveBot, {
      LUNA_RESET_CMD: process.execPath,
      LUNA_RESET_ARGS: JSON.stringify([resetStub]),
    });
    const empty = await sup.api('POST', '/api/reset-memory', {});
    expect(empty.status).toBe(400);
    expect(empty.data.error).toMatch(/подтверждение/);

    const wrong = await sup.api('POST', '/api/reset-memory', { confirm: 'maybe' });
    expect(wrong.status).toBe(400);

    const { data: logs } = await sup.api('GET', '/api/logs?tail=100');
    expect(logs.lines.join('\n')).not.toContain('сброс памяти выполнен');
  });

  it('reset-memory: с подтверждением сбрасывает и поднимает бота обратно', async () => {
    const sup = await startSupervisor(aliveBot, {
      LUNA_RESET_CMD: process.execPath,
      LUNA_RESET_ARGS: JSON.stringify([resetStub]),
    });
    await sup.api('POST', '/api/start');
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.online === true);

    const r = await sup.api('POST', '/api/reset-memory', { confirm: 'RESET' });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.memories).toBe(3);
    expect(r.data.summaries).toBe(1);
    expect(r.data.relationships).toBe(2);
    expect(r.data.restarted).toBe(true);

    // сброс делается на остановленном боте, но после него бот снова в сети
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.online === true);
    const { data: logs } = await sup.api('GET', '/api/logs?tail=100');
    expect(logs.lines.join('\n')).toContain('сброс памяти: останавливаю бота');
    expect(logs.lines.join('\n')).toContain('сброс памяти выполнен');
    await sup.api('POST', '/api/stop');
  });

  it('reset-memory: скрипт сброса упал — ошибка видна, бот снова запущен', async () => {
    const sup = await startSupervisor(aliveBot, {
      LUNA_RESET_CMD: process.execPath,
      LUNA_RESET_ARGS: JSON.stringify([resetFailStub]),
    });
    await sup.api('POST', '/api/start');
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.state === 'running');

    const r = await sup.api('POST', '/api/reset-memory', { confirm: 'RESET' });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toMatch(/кодом 2/);
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.state === 'running');
    await sup.api('POST', '/api/stop');
  });

  it('shutdown: смотритель останавливает бота и выходит сам', async () => {
    const sup = await startSupervisor(aliveBot);
    await sup.api('POST', '/api/start');
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.state === 'running');

    const exited = new Promise<number | null>((resolve) => sup.proc.on('exit', (code) => resolve(code)));
    await sup.api('POST', '/api/shutdown');
    const code = await Promise.race([
      exited,
      new Promise<null>((r) => setTimeout(() => r(null), 8000)),
    ]);
    expect(code !== null || sup.proc.exitCode !== null).toBe(true);
  });
});

describe('Supervisor: страница «Люди и память»', () => {
  const stubEnv = (stub: string) => ({
    LUNA_PEOPLE_CMD: process.execPath,
    LUNA_PEOPLE_ARGS: JSON.stringify([stub]),
  });

  it('страница отдаётся по /people и знает про свой API', async () => {
    const sup = await startSupervisor(aliveBot);
    const r = await fetch(`http://127.0.0.1:${sup.port}/people`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('Люди и память');
    expect(html).toContain('/api/people');

    // главная панель ссылается на страницу
    const main = await (await fetch(`http://127.0.0.1:${sup.port}/`)).text();
    expect(main).toContain('href="/people"');
  });

  it('действие и аргументы доходят до инструмента (stdin), ответ — панели', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    const r = await sup.api('POST', '/api/people', {
      action: 'updatePerson',
      payload: { personId: 'p1', relationship: { trust: 0.9 } },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.action).toBe('updatePerson');
    expect(r.data.payload.personId).toBe('p1');
    expect(r.data.payload.relationship.trust).toBe(0.9);
  });

  it('чтение без аргументов работает (пустой payload, не undefined)', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    const r = await sup.api('POST', '/api/people', { action: 'list' });
    expect(r.status).toBe(200);
    expect(r.data.payload).toEqual({});
  });

  it('действия не из белого списка отклоняются без запуска инструмента', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    const r = await sup.api('POST', '/api/people', { action: 'dropDatabase' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('неизвестное действие');
    expect((await sup.api('POST', '/api/people', {})).status).toBe(400);

    const { data: logs } = await sup.api('GET', '/api/logs?tail=50');
    expect(logs.lines.join('\n')).not.toContain('люди: dropDatabase');
  });

  it('отказ инструмента (ok:false) панель отдаёт как ошибку с причиной', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleErrStub));
    const r = await sup.api('POST', '/api/people', { action: 'deletePerson', payload: { personId: 'ghost' } });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toContain('такого человека нет');
  });

  it('инструмент упал — ошибка видна, смотритель жив', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleFailStub));
    const r = await sup.api('POST', '/api/people', { action: 'list' });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toMatch(/code 3/);
    expect((await sup.api('GET', '/api/status')).data.supervisor).toBe('ok');
  });

  it('меняющие действия пишутся в лог панели, чтение — нет', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    await sup.api('POST', '/api/people', { action: 'list' });
    await sup.api('POST', '/api/people', { action: 'get', payload: { personId: null } });
    await sup.api('POST', '/api/people', { action: 'deletePerson', payload: { personId: 'p1' } });

    const { data } = await sup.api('GET', '/api/logs?tail=100');
    const text = data.lines.join('\n');
    expect(text).toContain('люди: deletePerson p1 → ok');
    expect(text).not.toContain('люди: list');
    expect(text).not.toContain('люди: get');
  });

  it('status сообщает, есть ли чем править людей', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    const { data } = await sup.api('GET', '/api/status');
    expect(data.peopleReady).toBe(true);
  });

  it('правка людей не останавливает бота (бот остаётся в сети)', async () => {
    const sup = await startSupervisor(aliveBot, stubEnv(peopleStub));
    await sup.api('POST', '/api/start');
    await pollUntil(async () => (await sup.api('GET', '/api/status')).data.bot.online === true);

    await sup.api('POST', '/api/people', { action: 'updatePerson', payload: { personId: 'p1' } });
    const { data } = await sup.api('GET', '/api/status');
    expect(data.bot.state).toBe('running');
    expect(data.bot.online).toBe(true);
    await sup.api('POST', '/api/stop');
  });
});
