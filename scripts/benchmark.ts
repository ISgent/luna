/**
 * benchmark.ts — замер латентности горячего пути (ТЗ §48).
 *
 * Запуск:
 *   npm run benchmark                     — живые провайдеры (нужны ключи)
 *   npm run benchmark -- --mock           — моки (замеряет накладные расходы системы)
 *   npm run benchmark -- --rounds=10 --text="расскажи про новеллы"
 *
 * Печатает по каждому запросу спаны:
 *   retrieval / context / TTFT / llm total / first visible / total
 * и агрегаты p50/avg/max. Цель — на вопрос «почему Luna сегодня отвечала
 * 4 секунды?» отвечать конкретной строкой, а не гаданием.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createSilentLogger } from '../src/logging/logger.js';
import { buildSystem, type LunaSystem } from '../src/system.js';
import { RequestTracer, type TelemetryEntry } from '../src/logging/telemetry.js';
import type { ReplySink } from '../src/core/conversation/conversation-manager.js';

class BenchSink implements ReplySink {
  async onFirstSentence(): Promise<void> {}
  async onSentence(): Promise<void> {}
  async onProgress(): Promise<void> {}
  async onComplete(): Promise<void> {}
  async onError(e: unknown): Promise<void> {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

function parseArgs(): { mock: boolean; nobg: boolean; rounds: number; text: string } {
  const args = process.argv.slice(2);
  const get = (name: string, def: string): string => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  return {
    mock: args.includes('--mock'),
    nobg: args.includes('--nobg'),
    rounds: Number(get('rounds', '5')),
    text: get('text', 'Привет! Как настроение?'),
  };
}

const pct = (values: number[], p: number): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
};

async function main(): Promise<void> {
  const { mock, nobg, rounds, text } = parseArgs();
  const baseCfg = loadConfig();
  const cfg = mock
    ? { ...baseCfg, llm: { ...baseCfg.llm, provider: 'mock' as const, apiKey: undefined }, tts: { ...baseCfg.tts, provider: 'mock' as const } }
    : baseCfg;

  if (!mock && !cfg.llm.apiKey) {
    console.log('Нет ключей — запускаю в режиме --mock (накладные расходы системы).\n');
    return main2(true, nobg, rounds, text, baseCfg);
  }
  await main2(mock, nobg, rounds, text, cfg);
}

async function main2(mock: boolean, nobg: boolean, rounds: number, text: string, cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const dbPath = path.resolve(process.cwd(), 'data', mock ? 'bench-mock.db' : 'bench.db');
  rmSync(dbPath, { force: true });

  console.log(`═══ Luna latency benchmark ═══`);
  console.log(
    `режим: ${mock ? 'MOCK (только накладные системы)' : `LIVE (${cfg.llm.model} @ ${cfg.llm.baseUrl})`}, ` +
      `фон: ${nobg ? 'ВЫКЛЮЧЕН (--nobg)' : 'включён'}, раундов: ${rounds}\n`,
  );

  const sys: LunaSystem = buildSystem(cfg, {
    dbPath,
    logger: createSilentLogger(),
    // по умолчанию фон включён: он не должен влиять на горячий путь — бенчмарк это проверяет;
    // --nobg выключает фоновый пайплайн (диагностика конкуренции за лимиты провайдера)
    withoutBackground: nobg,
  });

  // прогрев: первый запрос может тянуть инициализацию соединений
  await runOnce(sys, 'прогрев', 0);

  const entries: TelemetryEntry[] = [];
  for (let i = 1; i <= rounds; i++) {
    const entry = await runOnce(sys, `${text} (#${i})`, i);
    entries.push(entry);
    const m = entry.metrics;
    console.log(
      `#${String(i).padStart(2)}  retrieval=${fmt(m.memoryRetrievalMs)} ctx=${fmt(m.contextBuildMs)} ttft=${fmt(m.ttftMs)} llm=${fmt(m.llmTotalMs)} first_visible=${fmt(m.firstVisibleMs)} total=${fmt(m.totalMs)}`,
    );
  }

  const col = (pick: (e: TelemetryEntry) => number | undefined): number[] =>
    entries.map(pick).filter((v): v is number => v !== undefined);

  const ttft = col((e) => e.metrics.ttftMs);
  const firstVisible = col((e) => e.metrics.firstVisibleMs);
  const retrieval = col((e) => e.metrics.memoryRetrievalMs);
  const total = col((e) => e.metrics.totalMs);

  console.log('\n─── Агрегаты (мс) ───');
  console.log(`метрика           p50    avg    max`);
  printRow('retrieval', retrieval);
  printRow('TTFT', ttft);
  printRow('first_visible', firstVisible);
  printRow('total', total);

  const bg = sys.repos.telemetry.recent(rounds + 1);
  console.log(`\nТелеметрия записана в БД: ${bg.length} строк (SELECT * FROM telemetry).`);
  if (!mock && pct(firstVisible, 50) > 3000) {
    console.log('\n⚠ first_visible p50 > 3с — смотри строки выше: где именно деградация (retrieval? ttft?).');
  }

  await sys.shutdown();
}

function printRow(name: string, values: number[]): void {
  if (values.length === 0) return;
  const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  console.log(`${name.padEnd(17)} ${String(Math.round(pct(values, 50))).padStart(5)} ${String(avg).padStart(6)} ${String(Math.max(...values)).padStart(6)}`);
}

const fmt = (v: number | undefined): string => (v === undefined ? '-' : `${Math.round(v)}мс`);

async function runOnce(sys: LunaSystem, text: string, idx: number): Promise<TelemetryEntry> {
  const tracer = new RequestTracer({ kind: 'text', userId: 'bench', channelId: 'bench-ch' });
  const res = await sys.manager.handle(
    {
      personId: 'bench',
      personName: 'Бенч',
      isOwner: false,
      channelId: 'bench-ch',
      channelKind: 'dm',
      text,
      at: Date.now(),
    },
    new BenchSink(),
    { tracer },
  );
  if (!res.ok) throw new Error(`round ${idx} failed: ${res.error}`);
  // фон не ждём — он вне горячего пути
  return tracer.toEntry();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
