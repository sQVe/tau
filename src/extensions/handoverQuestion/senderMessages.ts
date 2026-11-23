import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { readInboxReceipt } from '../../inbox/receiptDecision.js';
import { isRecord } from '../../schema.js';

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

const handoverReceiptText = (entry: SessionEntry): string | undefined => {
  if (entry.type !== 'custom_message' || readInboxReceipt(entry)?.family !== 'handover') {
    return undefined;
  }

  return contentText(entry.content);
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

    const receiptText = handoverReceiptText(entry);

    if (receiptText !== undefined) {
      messages.push(receiptText);
    }
  }

  return messages;
};
