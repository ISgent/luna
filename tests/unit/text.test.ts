import { describe, it, expect } from 'vitest';
import {
  TextPreprocessor,
  SentenceSplitter,
  splitSentences,
  splitForMessage,
  truncate,
} from '../../src/utils/text.js';

describe('TextPreprocessor.forSpeech', () => {
  const tp = new TextPreprocessor();

  it('убирает markdown-разметку, сохраняет пунктуацию', () => {
    const out = tp.forSpeech('**Привет!** Как _дела_? ~~норм~~');
    expect(out).toBe('Привет! Как дела? норм');
  });

  it('вырезает код целиком', () => {
    const out = tp.forSpeech('смотри:\n```js\nconst a = 1;\n```\nкруто же?');
    expect(out).not.toContain('const');
    expect(out).toContain('круто же?');
  });

  it('ссылки: текст остаётся, URL исчезает', () => {
    const out = tp.forSpeech('вот [гайд](https://example.com) и https://foo.bar/x?q=1');
    expect(out).toBe('вот гайд и');
  });

  it('discord-упоминания и кастомные emoji исчезают', () => {
    const out = tp.forSpeech('эй <@!123456789012345678> <#123456789012345678> <:pepe:123456789012345678>');
    expect(out).toBe('эй');
  });

  it('unicode emoji убираются, смысл остаётся', () => {
    const out = tp.forSpeech('ЧЕГО 💀🔥 ахах');
    expect(out).toBe('ЧЕГО ахах');
  });

  it('заголовки, цитаты, списки', () => {
    const out = tp.forSpeech('# Заголовок\n> цитата\n- пункт 1\n- пункт 2');
    expect(out).toBe('Заголовок\nцитата\nпункт 1\nпункт 2'.replace(/\n/g, '. '));
  });
});

describe('TextPreprocessor.cleanTranscript', () => {
  const tp = new TextPreprocessor();
  it('схлопывает пробелы и пунктуационный мусор', () => {
    expect(tp.cleanTranscript('  привет,,   мир!!!!!!  ')).toBe('привет, мир!!');
  });
});

describe('SentenceSplitter (потоковый)', () => {
  it('отдаёт предложение только когда оно закончилось', () => {
    const s = new SentenceSplitter();
    expect(s.feed('Привет. Как де')).toEqual(['Привет.']);
    // "Как дела?" держится: терминатор на конце стрима ещё не подтверждён продолжением
    expect(s.feed('ла?')).toEqual([]);
    // следующее сообщение подтверждает границу — либо это делает flush
    expect(s.feed(' Ага')).toEqual(['Как дела?']);
    expect(s.flush()).toEqual(['Ага']);
  });

  it('множественные терминаторы и закрывающие кавычки', () => {
    const s = new SentenceSplitter();
    const out = s.feed('Он сказал «пока!» и ушёл. Да. ');
    expect(out).toEqual(['Он сказал «пока!» и ушёл.']);
    expect(s.flush()).toEqual(['Да.']);
  });

  it('терминатор в кавычках перед строчной буквой не режет предложение', () => {
    const s = new SentenceSplitter();
    const out = s.feed('Он сказал «пока!» и ушёл домой. Потом вернулся. ');
    expect(out).toEqual(['Он сказал «пока!» и ушёл домой.']);
  });

  it('аббревиатуры не режут', () => {
    const out = splitSentences('Мы болтали о всяком т.д. и т.п. Потом разошлись.');
    expect(out).toEqual(['Мы болтали о всяком т.д. и т.п. Потом разошлись.']);
  });

  it('десятичные дроби не режут', () => {
    const out = splitSentences('Пи равно 3.14 примерно. Окей?');
    expect(out).toEqual(['Пи равно 3.14 примерно.', 'Окей?']);
  });

  it('инициалы не режут', () => {
    const out = splitSentences('Это А. С. Пушкин писал. Да.');
    expect(out).toEqual(['Это А. С. Пушкин писал.', 'Да.']);
  });

  it('flush возвращает хвост одним куском', () => {
    const s = new SentenceSplitter();
    s.feed('привет как');
    expect(s.flush()).toEqual(['привет как']);
  });

  it('многоточие — терминатор', () => {
    const out = splitSentences('Ну ты даёшь… Я даже не знаю. Честно.');
    expect(out).toEqual(['Ну ты даёшь…', 'Я даже не знаю.', 'Честно.']);
  });
});

describe('splitForMessage', () => {
  it('короткий текст без изменений', () => {
    expect(splitForMessage('привет')).toEqual(['привет']);
  });

  it('длинный текст режется по лимиту без потери слов', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Предложение номер ${i} про разные вещи.`).join(' ');
    const chunks = splitForMessage(text, 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join(' ')).toContain('Предложение номер 49');
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('одно огромное «слово» режется жёстко', () => {
    const text = 'а'.repeat(500);
    const chunks = splitForMessage(text, 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('truncate', () => {
  it('короткий не трогает, длинный режет с многоточием', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});
