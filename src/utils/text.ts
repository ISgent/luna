/**
 * Текстовые утилиты Luna:
 * - TextPreprocessor: очистка текста для TTS (markdown, мусор, emoji)
 * - SentenceSplitter: потоковая нарезка ответа на предложения (стриминг TTS/Discord)
 * - splitForMessage: нарезка длинного текста под лимит сообщения Discord
 */

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
const DISCORD_MENTION_RE = /<[@#][!&]?\d{15,25}>/g;
const DISCORD_CUSTOM_EMOJI_RE = /<(a?):[A-Za-z0-9_]{2,}:\d{15,25}>/g;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const RAW_URL_RE = /https?:\/\/\S+/g;
const SPOILER_RE = /\|\|([\s\S]*?)\|\|/g;

export interface SpeechCleanOptions {
  /** drop = emoji удаляются; name = читаются их discord-имена (для кастомных). */
  emoji?: 'drop' | 'name';
}

export class TextPreprocessor {
  constructor(private opts: SpeechCleanOptions = {}) {}

  /**
   * Готовит текст к озвучке: убирает markdown, код, URL, упоминания,
   * emoji; сохраняет естественную пунктуацию.
   */
  forSpeech(text: string): string {
    let t = text;
    t = t.replace(CODE_FENCE_RE, ' ');
    t = t.replace(MARKDOWN_LINK_RE, '$1');
    t = t.replace(RAW_URL_RE, ' ');
    t = t.replace(SPOILER_RE, '$1');
    t = t.replace(DISCORD_CUSTOM_EMOJI_RE, this.opts.emoji === 'name' ? ' $1' : ' ');
    t = t.replace(DISCORD_MENTION_RE, ' ');
    t = t.replace(EMOJI_RE, ' ');
    t = t.replace(/`/g, ' ');
    t = t.replace(/^#{1,6}\s*/gm, '');
    t = t.replace(/^\s*>\s?/gm, '');
    t = t.replace(/^\s*[-*+]\s+/gm, '');
    t = t.replace(/[*_~]{1,3}/g, '');
    t = t.replace(/\|/g, ' ');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\s*\n\s*/g, '. ');
    t = t.replace(/\.{2,}(\s|$)/g, '.$1');
    return t.trim();
  }

  /** Лёгкая очистка для STT-результата (без LLM): пробелы, повторения пунктуации. */
  cleanTranscript(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/([.!?])\1{2,}/g, '$1$1')
      .replace(/,\s*,/g, ',')
      .trim();
  }
}

// Аббревиатуры, после которых точка НЕ заканчивает предложение
const ABBREVIATIONS = [
  'т.д.', 'т.п.', 'и т.д.', 'и т.п.', 'т.е.', 'т.к.', 'н.э.', 'г.', 'гг.', 'ул.', 'д.',
  'ст.', 'руб.', 'мес.', 'мин.', 'сек.', 'см.', 'др.', 'пр.', 'ч.', 'км.', 'кг.', 'мл.',
  'шт.', 'чел.', 'напр.', 'обр.', 'б.', 'с.', 'в.', 'о.', 'р.', 'м.', 'л.', 'к.', 'а.',
];

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['»', '"', "'", '”', '’', ')', ']', '}', '…']);

function isAbbrevDot(buf: string, dotIdx: number): boolean {
  // цифра.цифра — десятичная дробь
  const before = buf[dotIdx - 1];
  const after = buf[dotIdx + 1];
  if (before && after && /\d/.test(before) && /[\d]/.test(after)) return true;
  // инициал: "А." одиночная буква перед точкой после пробела/начала/скобки
  if (before && /[A-Za-zА-Яа-яЁё]/.test(before)) {
    const prev = buf[dotIdx - 2];
    if (dotIdx === 1 || (prev !== undefined && /[\s(«["']/.test(prev))) return true;
  }
  const head = buf.slice(0, dotIdx + 1).toLowerCase();
  return ABBREVIATIONS.some((a) => {
    if (!head.endsWith(a)) return false;
    // перед аббревиатурой должна быть граница (пробел/скобка/начало),
    // иначе "минус." ложно совпадёт с "с."
    const beforeIdx = head.length - a.length - 1;
    return beforeIdx < 0 || /[\s(«["']/.test(head[beforeIdx]!);
  });
}

/**
 * Потоковая нарезка на предложения для стриминга.
 * feed() возвращает законченные предложения; хвост держит до подтверждения.
 */
export class SentenceSplitter {
  private buf = '';

  feed(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const end = this.findSentenceEnd();
      if (end < 0) break;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, '');
      if (sentence.length > 0) out.push(sentence);
    }
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    for (;;) {
      const end = this.findSentenceEnd(true);
      if (end < 0) break;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, '');
      if (sentence.length > 0) out.push(sentence);
    }
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) out.push(rest);
    return out;
  }

  /**
   * Ищет конец первого законченного предложения в buf.
   * Требование: терминатор (+ закрывающие) + пробел/перевод строки после.
   * Терминатор внутри кавычек перед строчной буквой концом НЕ считается
   * («Он сказал "пока!" и ушёл» — одно предложение).
   * atEnd=true (flush): конец буфера тоже считается границей.
   * Возвращает индекс ГРАНИЦЫ (exclusive) или -1.
   */
  private findSentenceEnd(atEnd = false): number {
    const s = this.buf;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (!TERMINATORS.has(ch)) continue;
      if (ch === '.' && isAbbrevDot(s, i)) continue;
      // съедаем повторные терминаторы и закрывающие
      let j = i + 1;
      let hadCloser = false;
      while (j < s.length && (TERMINATORS.has(s[j]!) || CLOSERS.has(s[j]!))) {
        if (CLOSERS.has(s[j]!) && !TERMINATORS.has(s[j]!)) hadCloser = true;
        j++;
      }
      if (j >= s.length) return atEnd ? s.length : -1; // ждём продолжения стрима
      if (!/\s/.test(s[j]!)) {
        i = j - 1;
        continue;
      }
      // следующий непробельный символ
      let k = j;
      while (k < s.length && /\s/.test(s[k]!)) k++;
      if (k >= s.length) return atEnd ? j : -1;
      const next = s[k]!;
      const insideQuote = hadCloser && hasUnclosedQuote(s.slice(0, i));
      if (insideQuote && /[a-zа-яё]/.test(next)) {
        i = j - 1; // цитата закрыта, предложение продолжается
        continue;
      }
      return j; // граница — сразу за терминаторами/кавычками
    }
    return -1;
  }
}

function hasUnclosedQuote(text: string): boolean {
  const open = (text.match(/[«"“]/g) ?? []).length;
  const close = (text.match(/[»"”]/g) ?? []).length;
  return open > close;
}

/** Нарезает готовый текст на предложения (не потоково). */
export function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.feed(text), ...splitter.flush()];
}

/**
 * Режет длинный текст на части под лимит Discord (2000, у нас дефолт 1800):
 * сначала по абзацам, затем по предложениям, в крайнем случае по словам.
 */
export function splitForMessage(text: string, limit = 1800): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;

  const pushPiece = (piece: string) => {
    if (piece.length <= limit) {
      chunks.push(piece);
      return;
    }
    for (const s of splitSentences(piece)) {
      if (s.length <= limit) {
        chunks.push(s);
        continue;
      }
      // длиннющее предложение — по словам
      let word = '';
      for (const w of s.split(/(\s+)/)) {
        if (w.length > limit) {
          // слово длиннее лимита — режем жёстко
          if (word.trim()) chunks.push(word.trimEnd());
          word = '';
          for (let i = 0; i < w.length; i += limit) chunks.push(w.slice(i, i + limit));
          continue;
        }
        if ((word + w).length > limit) {
          if (word.trim()) chunks.push(word.trimEnd());
          word = w;
        } else {
          word += w;
        }
      }
      if (word.trim()) chunks.push(word.trimEnd());
    }
  };

  const paragraphs = rest.split(/\n{2,}/);
  rest = '';
  let current = '';
  for (let idx = 0; idx < paragraphs.length; idx++) {
    const p = paragraphs[idx]! + (idx < paragraphs.length - 1 ? '\n\n' : '');
    if (current.length + p.length <= limit) {
      current += p;
    } else {
      if (current.trim()) pushPiece(current.trim());
      current = p.length > limit ? '' : p;
      if (p.length > limit) pushPiece(p.trim());
    }
  }
  if (current.trim()) pushPiece(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** Обрезать текст доmaxLength с многоточием. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)) + '…';
}
