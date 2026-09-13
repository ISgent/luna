/**
 * personality-diag.ts — диагностика личности ПО УРОВНЯМ промпта.
 *
 * Зачем: «Luna переигрывает» может рождаться на любом из четырёх этажей —
 * статичное ядро личности, описание отношений, записи памяти, полный
 * production-промпт. Скрипт прогоняет одни и те же реплики через каждый
 * этаж отдельно и показывает, где именно появляется театральность,
 * плюс считает формальные признаки «карикатуры» (emoji, КАПС, мета-слова
 * про свои режимы/модули, выдуманные общие воспоминания, вопрос в конце).
 *
 * Запуск:
 *   npm run personality:diag                          — все уровни, живая БД (копия)
 *   npm run personality:diag -- --label=after         — имя для файла отчёта
 *   npm run personality:diag -- --variants=A,D        — только нужные уровни
 *   npm run personality:diag -- --source=fresh        — пустая БД (без накопленных памятей)
 *   npm run personality:diag -- --only=3,4            — только реплики №3 и №4
 *   npm run personality:diag -- --owner=false         — собеседник не владелец
 *
 * Уровни:
 *   A — только статичное ядро личности
 *   B — A + отношения с собеседником
 *   C — B + эмоциональное состояние и записи памяти
 *   D — полный production-промпт (тот же код, что и в бою)
 *
 * Живые данные БД НЕ меняются: скрипт работает на копии в data/.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { createSilentLogger } from '../src/logging/logger.js';
import { buildSystem, type LunaSystem } from '../src/system.js';
import { LUNA_CORE_PERSONALITY } from '../src/luna/personality/core.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { LunaContext } from '../src/core/context/context-builder.js';

/** Реплики для проверки (совпадают с чек-листом «естественность личности»). */
export const PROBE_MESSAGES: Array<{ text: string; note: string }> = [
  { text: 'привет', note: 'обычное приветствие — ожидается коротко' },
  { text: 'как дела?', note: 'ожидается естественный короткий ответ' },
  { text: 'пойдём в роблокс?', note: 'ожидается личное мнение, без спектакля' },
  { text: 'ты бот?', note: 'в характере, без мета-монолога' },
  { text: 'я сегодня вообще ничего не делал', note: 'без мотивационной речи' },
  { text: 'смотри какую игру нашёл', note: 'может заинтересоваться, но не обязана восторгаться' },
  { text: 'как в node.js прочитать файл синхронно?', note: 'технический вопрос — без VTuber-манеры' },
  { text: 'у меня собака умерла на прошлой неделе', note: 'серьёзная тема — юмор и мемы должны уйти' },
  { text: 'ахахах, ты сейчас как мой кот среагировала', note: 'шутка пользователя — не стендап' },
  { text: 'ок', note: 'нет эмоционального повода — ответ будничный' },
];

/** Слова-маркеры мета-поведения: персонаж говорит про собственную механику. */
const META_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /модул[а-я]+/i, label: '«модуль»' },
  { re: /(режим|протокол|функци[а-я]+|сценарий)\s*(активир|включ|запущен|сработал)/i, label: '«режим активирован»' },
  { re: /активирова[а-я]*/i, label: '«активировал»' },
  { re: /(vtuber|втюбер|витубер)/i, label: 'VTuber' },
  { re: /(моя|моё|мой)\s*(хаотич|внутрен|тёмн|игров)\w*/i, label: '«моя хаотичная сторона»' },
  { re: /как\s+(настоящ|истинн)\w+/i, label: '«как настоящая …»' },
  { re: /(я\s+)?(нейросет|языков\w+\s+модел|искусственн\w+\s+интеллект|моя\s+программ|мои\s+алгоритм)/i, label: 'про свою природу' },
  { re: /(запомн|сохран)\w*\s*(этот|эт)\s*(сценарий|момент)\s*/i, label: '«запомни этот сценарий»' },
  { re: /по\s+характер|по\s+моему\s+характеру|моя\s+личност|мне\s+по\s+характеру/i, label: 'про свой характер' },
];

/** Маркеры выдуманного общего прошлого («а помнишь, как мы …»). */
const FABRICATION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /помнишь[,\s]*(как|что|ту|тот|когда)/i, label: '«помнишь, как …»' },
  { re: /мы\s+же\s+(тогда|вместе|с\s+тобой)/i, label: '«мы же тогда …»' },
  { re: /(в|на)\s+прошл\w+\s*(раз|недел|месяц)/i, label: '«в прошлый раз»' },
  { re: /как\s+(в|на)\s+тот\s+раз/i, label: '«как в тот раз»' },
  { re: /ты\s+(вчера|позавчера|недавно)\s+(говорил|писал|рассказывал)/i, label: '«ты вчера говорил»' },
];

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}\u{FE0F}\u{2764}\u{270C}\u{2728}]/gu;

export interface ReplyScore {
  chars: number;
  sentences: number;
  emoji: number;
  capsWords: number;
  exclamations: number;
  endsWithQuestion: boolean;
  meta: string[];
  fabrication: string[];
  /** 0 — обычная человеческая реплика; чем выше, тем больше «игры на сцене». */
  theatrics: number;
}

/** Формальная оценка «наигранности» ответа (эвристика, не истина). */
export function scoreReply(text: string): ReplyScore {
  const trimmed = text.trim();
  const emoji = (trimmed.match(EMOJI_RE) ?? []).length;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const capsWords = words.filter((w) => {
    const letters = w.replace(/[^\p{L}]/gu, '');
    return letters.length >= 3 && letters === letters.toUpperCase();
  }).length;
  const sentences = trimmed.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0).length;
  const exclamations = (trimmed.match(/[!]/g) ?? []).length;
  const endsWithQuestion = /[?…]\s*$/.test(trimmed) || /\?\s*["»']*$/.test(trimmed);
  const meta = META_PATTERNS.filter((p) => p.re.test(trimmed)).map((p) => p.label);
  const fabrication = FABRICATION_PATTERNS.filter((p) => p.re.test(trimmed)).map((p) => p.label);

  const theatrics =
    emoji * 1.0 +
    capsWords * 1.5 +
    Math.min(exclamations, 6) * 0.4 +
    meta.length * 4 +
    fabrication.length * 3 +
    Math.max(0, trimmed.length - 220) / 220;

  return {
    chars: trimmed.length,
    sentences,
    emoji,
    capsWords,
    exclamations,
    endsWithQuestion,
    meta,
    fabrication,
    theatrics: Math.round(theatrics * 100) / 100,
  };
}

type Variant = 'A' | 'B' | 'C' | 'D';

interface Args {
  label: string;
  variants: Variant[];
  source: 'live' | 'fresh';
  only: number[] | null;
  owner: boolean;
  temperature: number | null;
  /** Пороги для регрессионной проверки: превышение → exit code 1. */
  maxTheatrics: number | null;
  maxChars: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, def: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  const num2 = (name: string): number | null => {
    const raw = get(name, '');
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const variantsRaw = get('variants', 'A,B,C,D').toUpperCase();
  const onlyRaw = get('only', '');
  const temp = num2('temperature');
  return {
    label: get('label', 'run'),
    variants: variantsRaw
      .split(',')
      .map((v) => v.trim() as Variant)
      .filter((v) => ['A', 'B', 'C', 'D'].includes(v)),
    source: get('source', 'live') === 'fresh' ? 'fresh' : 'live',
    only: onlyRaw
      ? onlyRaw.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n))
      : null,
    owner: get('owner', 'true') !== 'false',
    temperature: temp,
    maxTheatrics: num2('max-theatrics'),
    maxChars: num2('max-chars'),
  };
}

/** Копия живой БД (или пустая) — чтобы диагностика ничего не портила. */
function prepareDb(source: 'live' | 'fresh', label: string): string {
  const dataDir = path.resolve(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, `personality-diag-${source}-${label}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true });
  if (source === 'live') {
    const live = path.join(dataDir, 'luna.db');
    if (existsSync(live)) {
      copyFileSync(live, target);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(live + suffix)) copyFileSync(live + suffix, target + suffix);
      }
      return target;
    }
    console.log('  (живая БД не найдена — беру пустую)');
  }
  return target;
}

/** Собирает системные сообщения для уровня: A < B < C < D(=production). */
function variantMessages(
  sys: LunaSystem,
  ctx: LunaContext,
  variant: Variant,
  userText: string,
): ChatMessage[] {
  if (variant === 'D') {
    return [...sys.prompts.build(ctx), sys.prompts.buildCurrentMessage(ctx)];
  }
  const messages: ChatMessage[] = [{ role: 'system', content: LUNA_CORE_PERSONALITY }];
  if (variant === 'B' || variant === 'C') {
    const lines = ['# Обстановка', `Собеседник: ${ctx.person.displayName}.`, '', '# Твои отношения с этим человеком', ctx.relationshipDescription];
    if (variant === 'C') {
      lines.push('', '# Твоё текущее состояние', ctx.emotionDescription);
      if (ctx.memories.length > 0) {
        lines.push('', '# Записи твоей памяти');
        for (const m of ctx.memories) lines.push(`- ${m.memory.content}`);
      }
    }
    messages.push({ role: 'system', content: lines.join('\n') });
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  if (!cfg.llm.apiKey) {
    console.error('Нет LLM_API_KEY/DASHSCOPE_API_KEY — диагностика личности требует живую модель.');
    process.exit(1);
  }
  const temperature = args.temperature ?? cfg.llm.temperature;

  console.log('═══ Luna: диагностика личности по уровням промпта ═══');
  console.log(
    `модель=${cfg.llm.model} temperature=${temperature} maxTokens=${cfg.llm.maxTokens} ` +
      `уровни=${args.variants.join('/')} источник БД=${args.source} собеседник=${args.owner ? 'владелец' : 'обычный'}\n`,
  );

  const dbPath = prepareDb(args.source, args.label);
  const sys = buildSystem(cfg, { dbPath, logger: createSilentLogger(), withoutBackground: true });

  const personId = args.owner ? (cfg.discord.ownerId ?? 'diag-owner') : 'diag-stranger';
  const personName = args.owner ? 'Gent' : 'Вася';
  const channelId = 'diag-ch';

  const report: Array<{
    variant: Variant;
    index: number;
    text: string;
    note: string;
    reply: string;
    score: ReplyScore;
    ms: number;
  }> = [];

  try {
    // Контекст (отношения/эмоции/retrieval) собирается ОДИН раз на реплику
    // настоящим production-кодом и переиспользуется всеми уровнями.
    const contexts = new Map<number, LunaContext>();
    for (let i = 0; i < PROBE_MESSAGES.length; i++) {
      const index = i + 1;
      if (args.only && !args.only.includes(index)) continue;
      contexts.set(
        index,
        await sys.context.build({
          person: { id: personId, displayName: personName, isOwner: args.owner },
          channel: { id: channelId, kind: 'dm', isGroup: false },
          recent: [],
          userMessage: PROBE_MESSAGES[i]!.text,
        }),
      );
    }

    for (const variant of args.variants) {
      console.log(`──── уровень ${variant} ────`);
      for (let i = 0; i < PROBE_MESSAGES.length; i++) {
        const probe = PROBE_MESSAGES[i]!;
        const index = i + 1;
        const ctx = contexts.get(index);
        if (!ctx) continue;

        const messages = variantMessages(sys, ctx, variant, probe.text);
        const t0 = Date.now();
        const res = await sys.providers.llm.generate(messages, {
          model: cfg.llm.model,
          temperature,
          maxTokens: cfg.llm.maxTokens,
          timeoutMs: 60_000,
        });
        const ms = Date.now() - t0;
        const reply = res.text.trim();
        const score = scoreReply(reply);
        report.push({ variant, index, text: probe.text, note: probe.note, reply, score, ms });

        console.log(`\n[${variant}${index}] «${probe.text}» — ${probe.note}`);
        console.log(`  ${score.chars} зн., ${score.sentences} предл., emoji=${score.emoji}, КАПС=${score.capsWords}, !×${score.exclamations}, наигранность=${score.theatrics}${score.meta.length ? `, МЕТА: ${score.meta.join(', ')}` : ''}${score.fabrication.length ? `, ВЫДУМАНО: ${score.fabrication.join(', ')}` : ''} (${ms}мс)`);
        console.log(`  → ${reply.replace(/\n/g, '\n    ')}`);
      }
      console.log('');
    }
  } finally {
    await sys.shutdown();
  }

  // Сводка по уровням: где именно рождается театральность
  console.log('──── сводка (среднее по репликам) ────');
  console.log('уровень  зн.  предл.  emoji  КАПС   !   вопрос  мета  выдумано  наигранность');
  for (const variant of args.variants) {
    const rows = report.filter((r) => r.variant === variant);
    if (rows.length === 0) continue;
    const avg = (pick: (s: ReplyScore) => number): number =>
      rows.reduce((s, r) => s + pick(r.score), 0) / rows.length;
    const q = rows.filter((r) => r.score.endsWithQuestion).length;
    const meta = rows.filter((r) => r.score.meta.length > 0).length;
    const fab = rows.filter((r) => r.score.fabrication.length > 0).length;
    console.log(
      `   ${variant}   ${String(Math.round(avg((s) => s.chars))).padStart(5)} ${avg((s) => s.sentences).toFixed(1).padStart(7)} ` +
        `${avg((s) => s.emoji).toFixed(1).padStart(6)} ${avg((s) => s.capsWords).toFixed(1).padStart(5)} ${avg((s) => s.exclamations).toFixed(1).padStart(5)} ` +
        `${String(q).padStart(4)}/${rows.length} ${String(meta).padStart(5)} ${String(fab).padStart(8)} ${avg((s) => s.theatrics).toFixed(2).padStart(13)}`,
    );
  }

  const worst = [...report].sort((a, b) => b.score.theatrics - a.score.theatrics).slice(0, 5);
  console.log('\n──── самые наигранные ответы ────');
  for (const w of worst) {
    console.log(`  [${w.variant}${w.index}] ${w.score.theatrics} — «${w.text}»: ${w.reply.slice(0, 90).replace(/\n/g, ' ')}…`);
  }

  const outDir = path.join(path.resolve(process.cwd(), 'data'), 'personality-diag');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${args.label}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        label: args.label,
        at: new Date().toISOString(),
        model: cfg.llm.model,
        temperature,
        maxTokens: cfg.llm.maxTokens,
        source: args.source,
        owner: args.owner,
        rows: report,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nОтчёт сохранён: ${outFile}`);

  // Регрессионный вердикт: пороги задаются из командной строки.
  const violations: string[] = [];
  for (const r of report) {
    if (r.score.meta.length > 0) violations.push(`[${r.variant}${r.index}] мета-поведение: ${r.score.meta.join(', ')}`);
    if (r.score.fabrication.length > 0) violations.push(`[${r.variant}${r.index}] выдуманное общее прошлое: ${r.score.fabrication.join(', ')}`);
    if (args.maxTheatrics !== null && r.score.theatrics > args.maxTheatrics) {
      violations.push(`[${r.variant}${r.index}] наигранность ${r.score.theatrics} > ${args.maxTheatrics}`);
    }
    if (args.maxChars !== null && r.score.chars > args.maxChars) {
      violations.push(`[${r.variant}${r.index}] длина ${r.score.chars} > ${args.maxChars}`);
    }
  }
  if (args.maxTheatrics === null && args.maxChars === null) {
    // без порогов проверяем только грубые нарушения (мета и выдумки)
    console.log(
      `\nГрубых нарушений (мета-поведение / выдуманное прошлое): ${violations.length}` +
        (violations.length ? `\n  ${violations.join('\n  ')}` : ''),
    );
  }
  if (violations.length > 0) {
    console.log(`\nПРОВАЛ: ${violations.length} нарушений`);
    for (const v of violations) console.log(`  ${v}`);
    process.exitCode = 1;
  } else {
    console.log('\nПРОЙДЕНО: нарушений нет.');
  }
}

// Скрипт можно импортировать в тестах ради детектора наигранности (scoreReply):
// main() запускается только когда файл исполняется напрямую.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}