import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { readInboxReceipt } from '../../inbox/receiptDecision.js';
import { isRecord } from '../../schema.js';

interface InboxMessage {
  customType: string;
  content: unknown;
  details?: unknown;
}

const messageRecord = (entry: SessionEntry): Record<string, unknown> | undefined => {
  if (entry.type !== 'message') {
    return undefined;
  }

  const message: unknown = entry.message;

  return isRecord(message) ? message : undefined;
};

const contentText = (content: unknown): string | undefined => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    }
  }

  return texts.join('\n');
};

const userMessageText = (entry: SessionEntry): string | undefined => {
  const message = messageRecord(entry);

  return message?.role === 'user' ? contentText(message['content']) : undefined;
};

export const handoverMessageText = (message: InboxMessage): string | undefined => {
  const entry = {
    type: 'custom_message',
    customType: message.customType,
    content: message.content,
    details: message.details,
  };

  if (readInboxReceipt(entry)?.family !== 'handover') {
    return undefined;
  }

  return contentText(message.content);
};

export const senderMessages = (entries: readonly SessionEntry[]): string[] => {
  const messages: string[] = [];
  let firstUserMessage = true;

  for (const entry of entries) {
    const userText = firstUserMessage ? userMessageText(entry) : undefined;

    if (userText !== undefined) {
      firstUserMessage = false;
      messages.push(userText);
    }

    const receiptText = entry.type === 'custom_message' ? handoverMessageText(entry) : undefined;

    if (receiptText !== undefined) {
      messages.push(receiptText);
    }
  }

  return messages;
};
