import type { EmotionalStatesRepo } from '../../storage/index.js';
import { EMOTION_BASELINE, type EmotionalState } from '../types.js';

/**
 * Текущее эмоциональное состояние Luna.
 *
 * Ключевые правила (ТЗ §14–15):
 * - состояние меняется В СЛЕДСТВИЕ разговоров/событий (дельты приходят из фонового анализа),
 *   а не скачет случайно;
 * - эмоция конкретного события в памяти НЕ становится автоматически текущим настроением;
 * - отклонения плавно возвращаются к базовой линии (ленивый decay по периоду полураспада —
 *   никаких таймеров: считаем при чтении от updatedAt);
 * - состояние влияет на формулировки, но не разрушает личность.
 */

export interface EmotionDeltas {
  mood?: number;
  energy?: number;
  playfulness?: number;
  irritation?: number;
  warmth?: number;
  socialEnergy?: number;
}

/** Ограничение дельты за одно событие — настроение не должно прыгать. */
export const MAX_DELTA_PER_EVENT = 0.2;

const DIMS = ['mood', 'energy', 'playfulness', 'irritation', 'warmth', 'socialEnergy'] as const;
type Dim = (typeof DIMS)[number];

const RANGE: Record<Dim, [number, number]> = {
  mood: [-1, 1],
  energy: [0, 1],
  playfulness: [0, 1],
  irritation: [0, 1],
  warmth: [0, 1],
  socialEnergy: [0, 1],
};

export interface EmotionManagerOptions {
  decayHalfLifeMin: number;
  now?: () => number;
}

export class EmotionManager {
  private cache: EmotionalState | null = null;

  constructor(
    private repo: EmotionalStatesRepo,
    private opts: EmotionManagerOptions,
  ) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  /** Текущее состояние с уже применённым ленивым decay (кэшируется в памяти). */
  current(): EmotionalState {
    if (!this.cache) this.cache = this.repo.get();
    return this.decayed(this.cache);
  }

  private decayed(state: EmotionalState): EmotionalState {
    const halfLifeMs = Math.max(1, this.opts.decayHalfLifeMin) * 60_000;
    const dt = Math.max(0, this.now() - state.updatedAt);
    if (dt < 1000) return state;
    const factor = Math.pow(0.5, dt / halfLifeMs);
    const out: EmotionalState = { ...state };
    for (const dim of DIMS) {
      const base = EMOTION_BASELINE[dim];
      out[dim] = base + (state[dim] - base) * factor;
    }
    return out;
  }

  /**
   * Применить дельты от фонового анализа. Каждая дельта ограничивается
   * MAX_DELTA_PER_EVENT; результат зажимается в диапазон измерения.
   */
  applyDeltas(deltas: EmotionDeltas, at = this.now()): EmotionalState {
    const cur = this.current();
    const next: EmotionalState = { ...cur, updatedAt: at };
    for (const dim of DIMS) {
      const d = deltas[dim];
      if (d === undefined || !Number.isFinite(d)) continue;
      const clampedD = Math.max(-MAX_DELTA_PER_EVENT, Math.min(MAX_DELTA_PER_EVENT, d));
      const [lo, hi] = RANGE[dim];
      next[dim] = Math.max(lo, Math.min(hi, cur[dim] + clampedD));
    }
    this.cache = next;
    this.repo.save(next);
    return next;
  }

  /** Естественное описание состояния для промпта (1–3 предложения). */
  describe(state: EmotionalState = this.current()): string {
    const parts: string[] = [];

    if (state.mood > 0.55) parts.push('настроение отличное, её прям распирает');
    else if (state.mood > 0.25) parts.push('настроение хорошее');
    else if (state.mood < -0.55) parts.push('настроение откровенно плохое');
    else if (state.mood < -0.2) parts.push('настроение пониженное');
    else parts.push('настроение ровное');

    if (state.energy < 0.3) parts.push('сил мало — ответы могут быть короче и вялее');
    else if (state.energy > 0.75) parts.push('энергии через край');

    if (state.irritation > 0.65) parts.push('заметно раздражена — лучше не лезть с глупостями');
    else if (state.irritation > 0.35) parts.push('слегка раздражена');

    if (state.playfulness > 0.7 && state.irritation < 0.4) parts.push('очень хочется дурачиться и подкалывать');
    else if (state.playfulness < 0.3) parts.push('не до шуток сейчас');

    if (state.warmth > 0.7) parts.push('расположена тепло и участливо');
    else if (state.warmth < 0.3) parts.push('держится холодновато');

    if (state.socialEnergy < 0.3) parts.push('устала от общения, может отвечать суше');
    else if (state.socialEnergy > 0.8) parts.push('общительная, готова болтать без остановки');

    return `Сейчас Luna: ${parts.join(', ')}.`;
  }
}
