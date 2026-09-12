/**
 * smoke.ts — ЖИВАЯ проверка всех компонентов (ТЗ §47).
 * Запуск: npm run smoke  (нужны ключи в .env или ~/.qwen/.env)
 *
 * Шаги: config → database → LLM (health/generate/stream) → embeddings →
 * TTS (с сохранением WAV, который можно послушать) → STT (round-trip) →
 * end-to-end диалог с телеметрией → Discord login (если есть токен).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createLogger, createSilentLogger } from '../src/logging/logger.js';
import { createProviders } from '../src/ai/registry.js';
import { buildSystem } from '../src/system.js';
import { Database } from '../src/storage/index.js';
import { encodeWav } from '../src/utils/audio.js';
import { RequestTracer } from '../src/logging/telemetry.js';
import type { ReplySink } from '../src/core/conversation/conversation-manager.js';
import { Client, GatewayIntentBits, Events } from 'discord.js';

interface StepResult {
  step: string;
  ok: boolean | 'skip';
  ms: number;
  note?: string;
}

const results: StepResult[] = [];

type StepOutput = string | { note?: string; skip?: boolean } | void;

async function step(name: string, fn: () => StepOutput | Promise<StepOutput>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    if (out && typeof out === 'object' && 'skip' in out && out.skip) {
      results.push({ step: name, ok: 'skip', ms, note: out.note });
      console.log(`  ~ ${name}: пропущено — ${out.note ?? ''}`);
      return true;
    }
    const note = typeof out === 'string' ? out : out?.note;
    results.push({ step: name, ok: true, ms, note });
    console.log(`  ✓ ${name} (${ms}мс)${note ? ` — ${note}` : ''}`);
    return true;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    results.push({ step: name, ok: false, ms, note: msg.slice(0, 300) });
    console.log(`  ✗ ${name} (${ms}мс) — ${msg.slice(0, 300)}`);
    return false;
  }
}

const mask = (s?: string) => (s ? `${s.slice(0, 6)}…${s.slice(-3)}` : '(нет)');

class CollectSink implements ReplySink {
  first = '';
  full = '';
  error: unknown = null;
  async onFirstSentence(s: string) { this.first = s; }
  async onSentence() {}
  async onProgress(f: string) { this.full = f; }
  async onComplete(f: string) { this.full = f; }
  async onError(e: unknown) { this.error = e; }
}

async function main(): Promise<void> {
  console.log('═══ Luna smoke test ═══\n');

  const cfg = loadConfig();
  const hasKey = !!cfg.llm.apiKey;

  await step('config', () => {
    if (!hasKey) throw new Error('нет LLM_API_KEY/DASHSCOPE_API_KEY — заполните .env (см. .env.example)');
    return `llm=${cfg.llm.model}@${cfg.llm.baseUrl} bg=${cfg.llm.backgroundModel} key=${mask(cfg.llm.apiKey)} tts=${cfg.tts.provider}:${cfg.tts.model}:${cfg.tts.voice} stt=${cfg.stt.provider}:${cfg.stt.model} emb=${cfg.embeddings.model}`;
  });
  if (!hasKey) {
    finish(1);
    return;
  }

  const logger = createSilentLogger();
  const providers = createProviders(cfg);

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const smokeDb = path.join(dataDir, 'smoke.db');
  rmSync(smokeDb, { force: true });

  await step('database', () => {
    const db = Database.open(smokeDb);
    db.raw.prepare("INSERT INTO settings (scope, key, value, updated_at) VALUES ('smoke','k','v',1)").run();
    const row = db.raw.prepare("SELECT value FROM settings WHERE scope='smoke' AND key='k'").get() as { value: string };
    const fts = db.ftsAvailable;
    db.close();
    if (row?.value !== 'v') throw new Error('чтение из БД не сошлось');
    return `sqlite ok, fts5=${fts ? 'да' : 'нет (LIKE-фолбэк)'}`;
  });

  await step('llm.healthCheck', async () => {
    const ok = await providers.llm.healthCheck();
    if (!ok) return { note: 'GET /models не прошёл — не критично, проверяю генерацией', skip: false };
    return 'endpoint /models отвечает';
  });

  await step('llm.generate', async () => {
    const res = await providers.llm.generate(
      [{ role: 'user', content: 'Ответь ровно одним словом: ок' }],
      { maxTokens: 16, temperature: 0 },
    );
    if (!res.text.trim()) throw new Error('пустой ответ');
    return `«${res.text.trim().slice(0, 60)}»`;
  });

  await step('llm.generateStream', async () => {
    const t0 = Date.now();
    let chunks = 0;
    let ttft = 0;
    let text = '';
    for await (const delta of providers.llm.generateStream(
      [{ role: 'user', content: 'Сосчитай от 1 до 5 через запятую' }],
      { maxTokens: 60, temperature: 0 },
    )) {
      chunks++;
      if (chunks === 1) ttft = Date.now() - t0;
      text += delta;
    }
    if (chunks === 0) throw new Error('стрим пуст');
    return `чанков=${chunks}, ttft=${ttft}мс, текст=«${text.trim().slice(0, 40)}»`;
  });

  await step('embeddings', async () => {
    const [v] = await providers.embeddings.embed(['проверка связи']);
    if (!v || v.length === 0) throw new Error('пустой вектор');
    return `dim=${v.length}`;
  });

  let ttsPcm: Awaited<ReturnType<typeof providers.tts.synthesize>> | null = null;
  await step('tts.synthesize', async () => {
    ttsPcm = await providers.tts.synthesize({ text: 'Привет! Это проверка голоса Luna. Слышно меня?' });
    if (!ttsPcm || ttsPcm.data.length === 0) throw new Error('пустой аудио-ответ');
    const wavPath = path.join(dataDir, 'smoke-tts.wav');
    writeFileSync(wavPath, encodeWav(ttsPcm));
    const seconds = ttsPcm.data.length / ttsPcm.sampleRate / ttsPcm.channels;
    return `${seconds.toFixed(1)}с аудио, ${ttsPcm.sampleRate}Гц → сохранил в ${wavPath} (послушай!)`;
  });

  await step('stt.transcribe (round-trip)', async () => {
    if (!ttsPcm || ttsPcm.data.length === 0) return { skip: true, note: 'TTS не дал аудио' };
    const res = await providers.stt.transcribe({ audio: ttsPcm, language: 'ru' });
    if (!res.text.trim()) throw new Error('STT вернул пустоту');
    return `услышал: «${res.text.trim().slice(0, 80)}»`;
  });

  const e2eDb = path.join(dataDir, 'smoke-e2e.db');
  rmSync(e2eDb, { force: true });
  await step('end-to-end диалог + телеметрия', async () => {
    const sys = buildSystem(cfg, { dbPath: e2eDb, logger, withoutBackground: false });
    try {
      const tracer = new RequestTracer({ kind: 'text', userId: 'smoke-user', channelId: 'smoke-ch' });
      const sink = new CollectSink();
      const res = await sys.manager.handle(
        {
          personId: 'smoke-user',
          personName: 'Смоук',
          isOwner: false,
          channelId: 'smoke-ch',
          channelKind: 'dm',
          text: 'Привет! Расскажи в двух словах, что ты за персонаж?',
          at: Date.now(),
        },
        sink,
        { tracer },
      );
      if (!res.ok || sink.error) throw new Error(`ответ не получен: ${String(sink.error ?? res.error)}`);
      await new Promise((r) => setTimeout(r, 200));
      await sys.pipeline.drain();
      const m = tracer.metrics;
      const memCount = sys.repos.memories.countActive();
      return [
        `ответ=«${sink.full.trim().slice(0, 60)}…»`,
        `ttft=${m.ttftMs}мс`,
        `first_visible=${m.firstVisibleMs}мс`,
        `mem_retrieval=${m.memoryRetrievalMs}мс`,
        `total=${m.totalMs}мс`,
        `фон сохранил памятей: ${memCount}`,
      ].join(', ');
    } finally {
      await sys.shutdown();
    }
  });

  await step('discord login', async () => {
    if (!cfg.discord.token) return { skip: true, note: 'нет DISCORD_TOKEN — текстовый/голосовой слой проверь вручную после заполнения .env' };
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('login timeout 20s')), 20_000);
        client.once(Events.ClientReady, () => {
          clearTimeout(t);
          resolve();
        });
        client.login(cfg.discord.token).catch((e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      const tag = client.user?.tag;
      await client.destroy();
      return `вошёл как ${tag}`;
    } catch (e) {
      await client.destroy().catch(() => {});
      throw e;
    }
  });

  const failed = results.filter((r) => r.ok === false).length;
  finish(failed > 0 ? 1 : 0);
}

function finish(code: number): void {
  console.log('\n═══ Итог ═══');
  for (const r of results) {
    const mark = r.ok === true ? '✓' : r.ok === 'skip' ? '~' : '✗';
    console.log(`${mark} ${r.step.padEnd(34)} ${String(r.ms).padStart(6)}мс  ${r.note ?? ''}`);
  }
  const failed = results.filter((r) => r.ok === false).map((r) => r.step);
  if (failed.length > 0) {
    console.log(`\nПРОВАЛЕНО: ${failed.join(', ')}`);
  } else {
    console.log('\nВсе проверки пройдены.');
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
