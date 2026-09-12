import type { ToolCall, ToolDef } from '../../ai/types.js';
import type { Logger } from '../../logging/logger.js';

/**
 * ToolRegistry — инструменты Luna (tool calling, ТЗ-гибрид «вариант B»).
 *
 * Модель САМА решает вызвать действие по любой человеческой формулировке.
 * Все инструменты идемпотентны: локальный quick-action-парсер мог уже
 * выполнить действие — повторное выполнение безопасно.
 *
 * Ошибка инструмента не роняет ответ: модель получает текст ошибки
 * и отвечает по-человечески.
 */

export interface ToolExecContext {
  personId: string;
  personName: string;
  channelId: string;
  channelKind: 'text' | 'voice' | 'dm';
  guildId?: string | null;
  /** Голосовой канал, в котором сейчас находится автор сообщения. */
  authorVoiceChannelId?: string | null;
}

export interface LunaTool {
  def: ToolDef;
  /** Возвращает строку-результат для модели (не для пользователя). */
  execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, LunaTool>();

  constructor(private logger?: Logger) {}

  register(tool: LunaTool): void {
    this.tools.set(tool.def.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get definitions(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  get size(): number {
    return this.tools.size;
  }

  async execute(call: ToolCall, ctx: ToolExecContext): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return `Инструмент ${call.name} не существует.`;
    let args: Record<string, unknown> = {};
    if (call.argumentsJson.trim()) {
      try {
        args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
      } catch {
        return `Не удалось разобрать аргументы: ${call.argumentsJson.slice(0, 100)}`;
      }
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      this.logger?.warn({ err: String(e), tool: call.name }, 'tool execution failed');
      return `Не получилось выполнить: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
