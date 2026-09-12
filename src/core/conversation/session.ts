/**
 * Short-term память канала: кольцо последних сообщений + буфер вытесненных
 * (для последующей суммаризации — старые сообщения не просто удаляются, ТЗ §11).
 */

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  authorId?: string;
  authorName?: string;
  at: number;
}

export class ConversationSession {
  private buffer: SessionMessage[] = [];
  private evictedBuf: SessionMessage[] = [];
  private readonly authors = new Set<string>();

  constructor(
    readonly channelId: string,
    private maxSize: number,
  ) {}

  push(m: SessionMessage): void {
    this.buffer.push(m);
    if (m.role === 'user' && m.authorId) this.authors.add(m.authorId);
    while (this.buffer.length > this.maxSize) {
      const old = this.buffer.shift();
      if (old) this.evictedBuf.push(old);
    }
  }

  get recent(): readonly SessionMessage[] {
    return this.buffer;
  }

  /** В канале недавно писал больше чем один человек → префиксы имён в промпте. */
  get isGroup(): boolean {
    return this.authors.size > 1;
  }

  get evictedCount(): number {
    return this.evictedBuf.length;
  }

  /** Забрать вытесненные сообщения для суммаризации (буфер очищается). */
  takeEvicted(): SessionMessage[] {
    const out = this.evictedBuf;
    this.evictedBuf = [];
    return out;
  }

  clear(): void {
    this.buffer = [];
    this.evictedBuf = [];
    this.authors.clear();
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, ConversationSession>();

  constructor(private maxSize: number) {}

  get(channelId: string): ConversationSession {
    let s = this.sessions.get(channelId);
    if (!s) {
      s = new ConversationSession(channelId, this.maxSize);
      this.sessions.set(channelId, s);
    }
    return s;
  }

  delete(channelId: string): void {
    this.sessions.delete(channelId);
  }

  get size(): number {
    return this.sessions.size;
  }
}
