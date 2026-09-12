/**
 * Чистая логика решения «отвечать ли» и преобразования Discord-сообщения
 * в IncomingMessage. Никакого discord.js — тестируется на простых объектах.
 */
import type { IncomingMessage } from '../../core/conversation/conversation-manager.js';

export interface MessageLike {
  id: string;
  authorId: string;
  authorIsBot: boolean;
  authorIsWebhook: boolean;
  authorName: string;
  authorDisplayName?: string | null;
  content: string;
  channelId: string;
  guildId: string | null;
  mentionedUserIds: string[];
  everyoneMentioned: boolean;
  referencedAuthorId?: string | null;
  referencedContent?: string | null;
  createdAtMs: number;
  /** Голосовой канал автора (если он сейчас в голосе). */
  authorVoiceChannelId?: string | null;
}

export interface ShouldRespondInput {
  msg: MessageLike;
  lunaId: string;
  ownerId?: string;
  /** Пользователь отключил обработку (settings). */
  memoryOrResponseDisabled?: boolean;
}

export interface RespondDecision {
  respond: boolean;
  reason: string;
  /** Текст с вырезанным упоминанием Luna. */
  text: string;
}

export function stripLunaMention(content: string, lunaId: string): string {
  return content
    .replace(new RegExp(`<@!?${lunaId}>`, 'g'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function shouldRespond(input: ShouldRespondInput): RespondDecision {
  const { msg, lunaId } = input;

  if (msg.authorIsBot || msg.authorIsWebhook) return { respond: false, reason: 'bot', text: '' };
  if (msg.authorId === lunaId) return { respond: false, reason: 'self', text: '' };
  if (input.memoryOrResponseDisabled) return { respond: false, reason: 'disabled', text: '' };

  const text = stripLunaMention(msg.content, lunaId);
  const mentioned = msg.mentionedUserIds.includes(lunaId) && !msg.everyoneMentioned;

  // DM: отвечаем всегда (даже на пустое — нет, пустое игнорим)
  if (!msg.guildId) {
    if (!text.trim()) return { respond: false, reason: 'empty', text };
    return { respond: true, reason: 'dm', text };
  }

  // Сервер: только упоминание или ответ на сообщение Luna
  if (mentioned) {
    if (!text.trim()) return { respond: false, reason: 'empty', text };
    return { respond: true, reason: 'mention', text };
  }
  if (msg.referencedAuthorId === lunaId) {
    if (!text.trim()) return { respond: false, reason: 'empty', text };
    return { respond: true, reason: 'reply-to-luna', text };
  }
  return { respond: false, reason: 'not-addressed', text };
}

export function toIncomingMessage(msg: MessageLike, text: string, ownerId?: string): IncomingMessage {
  return {
    personId: msg.authorId,
    personName: msg.authorDisplayName || msg.authorName,
    isOwner: !!ownerId && msg.authorId === ownerId,
    channelId: msg.channelId,
    channelKind: msg.guildId ? 'text' : 'dm',
    text,
    at: msg.createdAtMs,
    replyToText: msg.referencedAuthorId && msg.referencedAuthorId !== msg.authorId ? (msg.referencedContent ?? undefined) : undefined,
    guildId: msg.guildId,
    authorVoiceChannelId: msg.authorVoiceChannelId ?? null,
  };
}
