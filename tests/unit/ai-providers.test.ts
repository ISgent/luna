import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { z } from 'zod';
import { OpenAICompatibleLLM, parseJsonLoose } from '../../src/ai/llm/openai-compatible.js';
import { DashScopeTTS } from '../../src/ai/tts/dashscope.js';
import { OpenAITTS } from '../../src/ai/tts/openai.js';
import { DashScopeSTT } from '../../src/ai/stt/dashscope.js';
import { OpenAISTT } from '../../src/ai/stt/openai.js';
import { OpenAIEmbeddings } from '../../src/ai/embeddings/openai-compatible.js';
import { MockEmbeddingProvider } from '../../src/ai/mock.js';
import { encodeWav } from '../../src/utils/audio.js';
import { ProviderError } from '../../src/ai/errors.js';

type Handler = (req: http.IncomingMessage, body: string) => { status?: number; json?: unknown; raw?: Buffer; sse?: string[] };

let server: http.Server;
let baseUrl: string;
let requests: Array<{ url: string; body: string; headers: http.IncomingHttpHeaders }> = [];
let handler: Handler = () => ({ json: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body, headers: req.headers });
      const out = handler(req, body);
      const status = out.status ?? 200;
      if (out.sse) {
        res.writeHead(status, { 'Content-Type': 'text/event-stream' });
        for (const line of out.sse) res.write(`data: ${line}\n\n`);
        res.end();
        return;
      }
      if (out.raw) {
        res.writeHead(status, { 'Content-Type': 'application/octet-stream' });
        res.end(out.raw);
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

function reset(h: Handler) {
  requests = [];
  handler = h;
}

const wavBuf = () =>
  encodeWav({ sampleRate: 24000, channels: 1, data: Int16Array.from([0, 1000, 2000, 1000, 0, -1000, -2000, -1000]) });

describe('OpenAICompatibleLLM', () => {
  it('generate возвращает текст и usage', async () => {
    reset(() => ({
      json: {
        choices: [{ message: { content: 'привет!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        model: 'qwen-flash',
      },
    }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'qwen-flash', maxRetries: 0 });
    const res = await llm.generate([{ role: 'user', content: 'хай' }]);
    expect(res.text).toBe('привет!');
    expect(res.usage?.promptTokens).toBe(10);
    expect(requests[0]!.headers.authorization).toBe('Bearer k');
  });

  it('HTTP 200 с error в теле — ошибка (ловушка шлюзов)', async () => {
    reset(() => ({ json: { error: { message: 'model not activated' } } }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x', maxRetries: 0 });
    await expect(llm.generate([{ role: 'user', content: 'q' }])).rejects.toThrow(/model not activated/);
  });

  it('ретрит 500 и succeeds', async () => {
    let n = 0;
    reset(() => {
      n++;
      if (n < 3) return { status: 500, json: { error: 'boom' } };
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x', maxRetries: 3 });
    const res = await llm.generate([{ role: 'user', content: 'q' }]);
    expect(res.text).toBe('ok');
    expect(n).toBe(3);
  });

  it('401 не ретраится', async () => {
    reset(() => ({ status: 401, json: { error: 'bad key' } }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x', maxRetries: 3 });
    await expect(llm.generate([{ role: 'user', content: 'q' }])).rejects.toThrow(/401/);
    expect(requests).toHaveLength(1);
  });

  it('generateStream отдаёт дельты до [DONE]', async () => {
    reset(() => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: 'при' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'вет' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      ],
    }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x' });
    const chunks: string[] = [];
    for await (const c of llm.generateStream([{ role: 'user', content: 'q' }])) {
      if (c.kind === 'text') chunks.push(c.text);
    }
    expect(chunks.join('')).toBe('привет');
  });

  it('generateStream: tool_calls собираются из фрагментов и сливаются по index', async () => {
    reset(() => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'join_voice', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ],
    }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x' });
    const collected: unknown[] = [];
    for await (const c of llm.generateStream([{ role: 'user', content: 'го в голос' }], {
      tools: [{ name: 'join_voice', description: 'зайти в голос', parameters: { type: 'object', properties: {} } }],
    })) {
      collected.push(c);
    }
    expect(collected).toHaveLength(1);
    const chunk = collected[0] as { kind: string; toolCalls: Array<{ id: string; name: string; argumentsJson: string }> };
    expect(chunk.kind).toBe('tool_calls');
    expect(chunk.toolCalls).toEqual([{ id: 'call_1', name: 'join_voice', argumentsJson: '{"a":1}' }]);
    // tools реально ушли в запрос
    const body = JSON.parse(requests[0]!.body);
    expect(body.tools[0].function.name).toBe('join_voice');
  });

  it('generateStream: error внутри SSE — исключение', async () => {
    reset(() => ({
      sse: [JSON.stringify({ error: { message: 'quota exceeded' } })],
    }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x' });
    await expect(async () => {
      for await (const _ of llm.generateStream([{ role: 'user', content: 'q' }])) void _;
    }).rejects.toThrow(/quota exceeded/);
  });

  it('generateStructured валидирует схемой и чинит мусор', async () => {
    const schema = z.object({ mood: z.string(), delta: z.number() });
    let n = 0;
    reset(() => {
      n++;
      if (n === 1) return { json: { choices: [{ message: { content: '```json\n{"mood": "радость"}\n```' } }] } };
      return { json: { choices: [{ message: { content: '{"mood": "радость", "delta": 0.2}' } }] } };
    });
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x', maxRetries: 0 });
    const res = await llm.generateStructured([{ role: 'user', content: 'analyze' }], { schema });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.mood).toBe('радость');
      expect(res.value.delta).toBeCloseTo(0.2);
    }
    expect(n).toBe(2); // первый ответ невалиден → ремонт
  });

  it('healthCheck: /models 200 → true', async () => {
    reset(() => ({ json: { data: [] } }));
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'k', model: 'x' });
    expect(await llm.healthCheck()).toBe(true);
  });
});

describe('parseJsonLoose', () => {
  const schema = z.object({ a: z.number() });
  it('достаёт JSON из fence и мусора', () => {
    expect(parseJsonLoose('```json\n{"a": 1}\n```', schema)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonLoose('вот: {"a": 2} надеюсь хватит', schema)).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonLoose('{"a": "не число"}', schema).ok).toBe(false);
  });
});

describe('TTS-адаптеры', () => {
  it('DashScopeTTS: JSON со ссылкой → скачивает WAV → PCM', async () => {
    const wav = wavBuf();
    reset((req) => {
      if (req.url === '/audio.wav') return { raw: wav };
      return { json: { output: { audio: { url: `${baseUrl.replace('/v1', '')}/audio.wav` } } } };
    });
    const tts = new DashScopeTTS({ baseUrl, apiKey: 'k' });
    const pcm = await tts.synthesize({ text: 'привет' });
    expect(pcm.sampleRate).toBe(24000);
    expect(pcm.data.length).toBe(8);
    // проверяем форму запроса из памятки: input.text + input.voice
    const body = JSON.parse(requests[0]!.body);
    expect(body.input.text).toBe('привет');
    expect(body.input.voice).toBe('Cherry');
  });

  it('DashScopeTTS: нет audio.url — внятная ошибка', async () => {
    reset(() => ({ json: { output: {} } }));
    const tts = new DashScopeTTS({ baseUrl, apiKey: 'k', maxRetries: 0 });
    await expect(tts.synthesize({ text: 'привет' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('OpenAITTS: WAV байты сразу', async () => {
    reset(() => ({ raw: wavBuf() }));
    const tts = new OpenAITTS({ baseUrl, apiKey: 'k' });
    const pcm = await tts.synthesize({ text: 'привет' });
    expect(pcm.data.length).toBe(8);
    const body = JSON.parse(requests[0]!.body);
    expect(body.response_format).toBe('wav');
  });
});

describe('STT-адаптеры', () => {
  const audio = { sampleRate: 48000, channels: 2 as const, data: new Int16Array(4800) };

  it('DashScopeSTT: чат с input_audio (data-URL, БЕЗ текстовой части)', async () => {
    reset(() => ({ json: { choices: [{ message: { content: 'привет луна' } }] } }));
    const stt = new DashScopeSTT({ baseUrl, apiKey: 'k' });
    const res = await stt.transcribe({ audio });
    expect(res.text).toBe('привет луна');
    const body = JSON.parse(requests[0]!.body);
    expect(body.model).toBe('qwen3-asr-flash');
    const content = body.messages[0].content;
    // dedicated-задача asr принимает ТОЛЬКО аудио: текстовая часть → HTTP 400 (подтверждено живым probe'ом)
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('input_audio');
    expect(content[0].input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('OpenAISTT: multipart /audio/transcriptions', async () => {
    reset(() => ({ json: { text: '  распознано  ' } }));
    const stt = new OpenAISTT({ baseUrl, apiKey: 'k' });
    const res = await stt.transcribe({ audio });
    expect(res.text).toBe('распознано');
    expect(requests[0]!.url).toBe('/v1/audio/transcriptions');
  });

  it('пустое аудио — пустой текст без запроса', async () => {
    reset(() => ({ json: {} }));
    const stt = new DashScopeSTT({ baseUrl });
    const res = await stt.transcribe({ audio: { sampleRate: 48000, channels: 2, data: new Int16Array(0) } });
    expect(res.text).toBe('');
    expect(requests).toHaveLength(0);
  });
});

describe('OpenAIEmbeddings', () => {
  it('возвращает векторы по числу текстов', async () => {
    reset(() => ({
      json: {
        data: [
          { index: 1, embedding: [0.2, 0.1] },
          { index: 0, embedding: [0.1, 0.9] },
        ],
      },
    }));
    const emb = new OpenAIEmbeddings({ baseUrl, apiKey: 'k', dimensions: 2 });
    const [a, b] = await emb.embed(['первый', 'второй']);
    expect(a![0]).toBeCloseTo(0.1); // сортировка по index
    expect(a![1]).toBeCloseTo(0.9);
    expect(b![0]).toBeCloseTo(0.2);
    expect(b![1]).toBeCloseTo(0.1);
  });

  it('кэш: повторный текст без второго запроса', async () => {
    reset(() => ({ json: { data: [{ index: 0, embedding: [1, 0] }] } }));
    const emb = new OpenAIEmbeddings({ baseUrl, apiKey: 'k', dimensions: 2 });
    await emb.embed(['один']);
    await emb.embed(['один']);
    expect(requests).toHaveLength(1);
  });
});

describe('MockEmbeddingProvider', () => {
  it('похожие тексты ближе, чем разные', async () => {
    const emb = new MockEmbeddingProvider(128);
    const [a, b, c] = await emb.embed([
      'gent любит играть в сталкер',
      'gent любит сталкер',
      'погода вчера была дождливая',
    ]);
    const cos = (x: Float32Array, y: Float32Array) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i]! * y[i]!;
      return s;
    };
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  });
});
