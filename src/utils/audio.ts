/**
 * Аудио-утилиты: WAV encode/decode, ресемплинг, RMS, энергетический VAD.
 * FFmpeg на машине нет и не нужен: TTS отдаёт WAV/PCM, Discord voice
 * принимает сырой s16le 48 кГц стерео (StreamType.Raw).
 */

export interface AudioPCM {
  sampleRate: number;
  channels: 1 | 2;
  /** interleaved s16le */
  data: Int16Array;
}

export function encodeWav(pcm: AudioPCM): Buffer {
  const bitsPerSample = 16;
  const byteRate = pcm.sampleRate * pcm.channels * (bitsPerSample / 8);
  const blockAlign = pcm.channels * (bitsPerSample / 8);
  const dataSize = pcm.data.byteLength;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(pcm.channels, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm.data.buffer, pcm.data.byteOffset, dataSize).copy(buf, 44);
  return buf;
}

export class WavDecodeError extends Error {}

/** Декодирует 16-bit PCM / 24-bit PCM / 32-bit float WAV в s16le. */
export function decodeWav(input: Buffer | Uint8Array): AudioPCM {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavDecodeError('не WAV-файл (нет RIFF/WAVE)');
  }
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new WavDecodeError('в WAV нет fmt/data чанков');
  if (![1, 3].includes(fmt.format)) throw new WavDecodeError(`неподдерживаемый WAV-формат ${fmt.format} (нужен PCM/float)`);
  if (fmt.channels !== 1 && fmt.channels !== 2) throw new WavDecodeError(`неподдерживаемое число каналов: ${fmt.channels}`);

  let samples: Int16Array;
  if (fmt.format === 1 && fmt.bits === 16) {
    const aligned = data.subarray(0, data.length - (data.length % 2));
    samples = new Int16Array(aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength));
  } else if (fmt.format === 1 && fmt.bits === 24) {
    const n = Math.floor(data.length / 3);
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = data[i * 3]! | (data[i * 3 + 1]! << 8) | (data[i * 3 + 2]! << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[i] = v >> 8;
    }
  } else if (fmt.format === 3 && fmt.bits === 32) {
    const n = Math.floor(data.length / 4);
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const f = data.readFloatLE(i * 4);
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
    }
  } else {
    throw new WavDecodeError(`неподдерживаемая разрядность: ${fmt.bits} (fmt=${fmt.format})`);
  }

  return { sampleRate: fmt.sampleRate, channels: fmt.channels as 1 | 2, data: samples };
}

/** Линейный ресемплинг (для голоса качество достаточное). */
export function resampleLinear(data: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || data.length === 0) return data;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(data.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = Math.round(data[i0]! * (1 - frac) + data[i1]! * frac);
  }
  return out;
}

/**
 * Приводит любой PCM к формату Discord voice: s16le, 48 кГц, стерео interleaved.
 */
export function toDiscordPCM(pcm: AudioPCM): Int16Array {
  const resampled = resampleLinear(pcm.data, pcm.sampleRate, 48000);
  if (pcm.channels === 2) return resampled;
  const stereo = new Int16Array(resampled.length * 2);
  for (let i = 0; i < resampled.length; i++) {
    stereo[i * 2] = resampled[i]!;
    stereo[i * 2 + 1] = resampled[i]!;
  }
  return stereo;
}

export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; pcm: Int16Array; durationMs: number };

export interface VadOptions {
  /** Абсолютный порог RMS старта речи. */
  startRms: number;
  /** Сколько тишины закрывает фразу, мс. */
  endSilenceMs: number;
  /** Короче — считаем мусором и выбрасываем, мс. */
  minSpeechMs: number;
  /** Принудительно закрываем фразу, мс. */
  maxUtteranceMs: number;
  sampleRate: number;
  channels: number;
}

/**
 * Энергетический VAD с гистерезисом и адаптивным порогом шума.
 * push() получает PCM-кадры (например, 20 мс opus-пакеты из Discord voice)
 * и возвращает события speech_start / speech_end (с накопленным PCM).
 */
export class EnergyVad {
  private speaking = false;
  private frames: Int16Array[] = [];
  private speechMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private noiseFloor = 1;
  private readonly opts: VadOptions;

  constructor(opts: VadOptions) {
    this.opts = opts;
  }

  private frameMs(frame: Int16Array): number {
    return (frame.length / (this.opts.sampleRate * this.opts.channels)) * 1000;
  }

  push(frame: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    const level = rms(frame);
    const ms = this.frameMs(frame);
    // адаптивный порог: шумовой пол * 3, но не ниже абсолютного минимума
    const threshold = Math.max(this.opts.startRms, this.noiseFloor * 3);

    if (!this.speaking) {
      if (level >= threshold) {
        this.speaking = true;
        this.frames = [Int16Array.from(frame)];
        this.speechMs = ms;
        this.silenceMs = 0;
        events.push({ type: 'speech_start' });
      } else {
        this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      }
      return events;
    }

    this.frames.push(Int16Array.from(frame));
    this.speechMs += ms;
    if (level < threshold * 0.7) {
      this.silenceMs += ms;
    } else {
      this.silenceMs = 0;
      this.voicedMs += ms;
    }

    const tooLong = this.speechMs >= this.opts.maxUtteranceMs;
    if (this.silenceMs >= this.opts.endSilenceMs || tooLong) {
      const pcm = concatFrames(this.frames);
      const duration = this.speechMs;
      const voiced = this.voicedMs;
      this.reset();
      if (voiced >= this.opts.minSpeechMs) {
        events.push({ type: 'speech_end', pcm, durationMs: duration });
      }
    }
    return events;
  }

  /** Принудительно закрыть фразу (дисконнект, смена канала). */
  forceEnd(): VadEvent[] {
    if (!this.speaking) return [];
    const pcm = concatFrames(this.frames);
    const duration = this.speechMs;
    const voiced = this.voicedMs;
    this.reset();
    return voiced >= this.opts.minSpeechMs ? [{ type: 'speech_end', pcm, durationMs: duration }] : [];
  }

  reset(): void {
    this.speaking = false;
    this.frames = [];
    this.speechMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}

function concatFrames(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((s, f) => s + f.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
