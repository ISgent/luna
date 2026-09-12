import { describe, it, expect } from 'vitest';
import {
  encodeWav,
  decodeWav,
  resampleLinear,
  toDiscordPCM,
  rms,
  EnergyVad,
  WavDecodeError,
  type AudioPCM,
  type VadEvent,
} from '../../src/utils/audio.js';

type SpeechEndEvent = Extract<VadEvent, { type: 'speech_end' }>;

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = SAMPLE_RATE * 2 * 0.02; // 20 мс стерео

function silenceFrame(): Int16Array {
  const f = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < f.length; i++) f[i] = Math.round((Math.random() - 0.5) * 10);
  return f;
}

function toneFrame(amplitude = 3000): Int16Array {
  const f = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < f.length; i++) {
    f[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  }
  return f;
}

describe('WAV encode/decode', () => {
  it('round-trip 16-bit stereo', () => {
    const pcm: AudioPCM = {
      sampleRate: 24000,
      channels: 2,
      data: Int16Array.from([-32768, -1, 0, 1, 32767, 12345]),
    };
    const wav = encodeWav(pcm);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(24000);
    expect(back.channels).toBe(2);
    expect(Array.from(back.data)).toEqual(Array.from(pcm.data));
  });

  it('round-trip 16-bit mono', () => {
    const pcm: AudioPCM = { sampleRate: 16000, channels: 1, data: Int16Array.from([100, 200, 300]) };
    const back = decodeWav(encodeWav(pcm));
    expect(Array.from(back.data)).toEqual([100, 200, 300]);
  });

  it('декодирует 32-bit float WAV', () => {
    const buf = Buffer.alloc(44 + 8);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + 8, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(3, 20); // float
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(48000, 24);
    buf.writeUInt32LE(192000, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(32, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(8, 40);
    buf.writeFloatLE(1.0, 44);
    buf.writeFloatLE(-1.0, 48);
    const pcm = decodeWav(buf);
    expect(pcm.data[0]).toBeGreaterThan(32700);
    expect(pcm.data[1]).toBeLessThan(-32700);
  });

  it('не-WAV отклоняется', () => {
    expect(() => decodeWav(Buffer.from('просто байты, а не RIFF заголовок совсем'))).toThrow(WavDecodeError);
    expect(() => decodeWav(Buffer.alloc(10))).toThrow(WavDecodeError);
  });
});

describe('resampleLinear', () => {
  it('24k → 48k удваивает длину', () => {
    const input = Int16Array.from([0, 1000, 2000, 1000]);
    const out = resampleLinear(input, 24000, 48000);
    expect(out.length).toBe(8);
  });

  it('константа сохраняется', () => {
    const input = new Int16Array(100).fill(5000);
    const out = resampleLinear(input, 24000, 48000);
    expect(out.every((v) => Math.abs(v - 5000) <= 1)).toBe(true);
  });

  it('та же частота — без изменений', () => {
    const input = Int16Array.from([1, 2, 3]);
    expect(resampleLinear(input, 48000, 48000)).toBe(input);
  });
});

describe('toDiscordPCM', () => {
  it('mono 24k → stereo 48k (x4 сэмпла)', () => {
    const pcm: AudioPCM = { sampleRate: 24000, channels: 1, data: new Int16Array(240).fill(100) };
    const out = toDiscordPCM(pcm);
    expect(out.length).toBe(240 * 4);
    // стерео: L=R
    for (let i = 0; i < out.length; i += 2) expect(out[i]).toBe(out[i + 1]);
  });
});

describe('rms', () => {
  it('тишина ≈ 0, тон ≈ amplitude/√2', () => {
    expect(rms(new Int16Array(100))).toBe(0);
    const tone = toneFrame(10000);
    expect(rms(tone)).toBeGreaterThan(6000);
    expect(rms(tone)).toBeLessThan(8000);
  });
});

describe('EnergyVad', () => {
  const opts = {
    startRms: 220,
    endSilenceMs: 700,
    minSpeechMs: 250,
    maxUtteranceMs: 20000,
    sampleRate: SAMPLE_RATE,
    channels: 2,
  };

  it('детектирует начало и конец фразы', () => {
    const vad = new EnergyVad(opts);
    const events: string[] = [];
    let ended: SpeechEndEvent | null = null;

    for (let i = 0; i < 10; i++) for (const e of vad.push(silenceFrame())) events.push(e.type);
    for (let i = 0; i < 15; i++) for (const e of vad.push(toneFrame())) { events.push(e.type); if (e.type === 'speech_end') ended = e; }
    expect(events).toContain('speech_start');
    expect(ended).toBeNull(); // фраза ещё не закрыта

    for (let i = 0; i < 50; i++) {
      for (const e of vad.push(silenceFrame())) {
        events.push(e.type);
        if (e.type === 'speech_end') ended = e;
      }
    }
    expect(ended).not.toBeNull();
    expect(ended!.pcm.length).toBeGreaterThan(0);
    expect(ended!.durationMs).toBeGreaterThanOrEqual(300);
  });

  it('короткий всплеск (< minSpeechMs звучной части) отбрасывается', () => {
    const vad = new EnergyVad(opts);
    const events: string[] = [];
    for (let i = 0; i < 5; i++) vad.push(silenceFrame());
    for (let i = 0; i < 5; i++) for (const e of vad.push(toneFrame())) events.push(e.type); // 100 мс
    for (let i = 0; i < 50; i++) for (const e of vad.push(silenceFrame())) events.push(e.type);
    expect(events).toContain('speech_start');
    expect(events).not.toContain('speech_end');
  });

  it('maxUtteranceMs принудительно закрывает фразу', () => {
    const vad = new EnergyVad({ ...opts, maxUtteranceMs: 300, minSpeechMs: 100 });
    const events: string[] = [];
    for (let i = 0; i < 30; i++) for (const e of vad.push(toneFrame())) events.push(e.type);
    expect(events).toContain('speech_end');
  });

  it('forceEnd возвращает накопленное', () => {
    const vad = new EnergyVad(opts);
    for (let i = 0; i < 15; i++) vad.push(toneFrame());
    const forced = vad.forceEnd();
    expect(forced).toHaveLength(1);
    expect(forced[0]!.type).toBe('speech_end');
    expect(vad.isSpeaking).toBe(false);
  });
});
