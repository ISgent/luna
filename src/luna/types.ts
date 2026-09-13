/**
 * Доменные типы Luna (используются и в storage, и в luna/*).
 */

export type MemoryKind =
  | 'fact'          // факт о человеке/мире
  | 'preference'    // предпочтение
  | 'event'         // событие (совместное или нет)
  | 'joke'          // recurring joke / внутренняя шутка
  | 'promise'       // обещание
  | 'open_thread'   // незаконченная тема
  | 'impression'    // впечатление Luna о человеке
  | 'consolidated'; // результат консолидации

export type MemoryStatus = 'active' | 'merged' | 'deleted';

/** SUBJECTIVE-часть памяти: что Luna думает/почувствовала. Отдельно от objective. */
export interface SubjectiveImpression {
  opinion: string;
  emotion: string;
  intensity: number; // 0..1
}

export interface MemoryRecord {
  id: string;
  personId: string | null;
  channelId: string | null;
  kind: MemoryKind;
  content: string;
  /** OBJECTIVE-часть: что произошло (факты). */
  objectiveFacts: string[];
  subjective: SubjectiveImpression | null;
  /** Эмоция СОБЫТИЯ. Не текущее настроение Luna — они разделены. */
  emotion: string | null;
  emotionIntensity: number;
  importance: number;    // 0..1
  confidence: number;    // 0..1
  embedding: Float32Array | null;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt: number | null;
  recallCount: number;
  sourceConversationId: string | null;
  supersededBy: string | null;
  status: MemoryStatus;
}

export interface RelationshipState {
  personId: string;
  familiarity: number;  // 0..1
  trust: number;        // 0..1
  closeness: number;    // 0..1
  respect: number;      // 0..1
  affection: number;    // 0..1
  sharedXp: number;     // число значимых совместных событий
  interactions: number;
  summary: string;      // естественное описание (обновляется фоном)
  updatedAt: number;
}

/**
 * ТЕКУЩЕЕ эмоциональное состояние Luna.
 * Отдельная сущность от эмоций событий в памяти (см. ТЗ §14).
 */
export interface EmotionalState {
  mood: number;          // -1..1
  energy: number;        // 0..1
  playfulness: number;   // 0..1
  irritation: number;    // 0..1
  warmth: number;        // 0..1
  socialEnergy: number;  // 0..1
  updatedAt: number;
}

/**
 * Базовая линия настроения — «обычная Luna», к которой состояние стягивается
 * со временем. Намеренно нейтральная: playfulness и socialEnergy ниже
 * порогов, при которых описание состояния советует шутить и болтать.
 * Раньше базовая линия была близка к этим порогам, и любой положительный
 * сдвиг от фона превращал каждый ответ в выступление.
 */
export const EMOTION_BASELINE: Omit<EmotionalState, 'updatedAt'> = {
  mood: 0.2,
  energy: 0.6,
  playfulness: 0.45,
  irritation: 0,
  warmth: 0.5,
  socialEnergy: 0.6,
};

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ConversationSummary {
  id: string;
  channelId: string;
  periodStart: number;
  periodEnd: number;
  summary: string;
  createdAt: number;
}

export interface RetrievedMemory {
  memory: MemoryRecord;
  score: number;
  components: {
    semantic: number;
    recency: number;
    importance: number;
    emotion: number;
    recall: number;
    personBoost: number;
  };
}
