import { createHash } from 'node:crypto';

import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

/** Custom session entry type that links a sent message to the text the user typed. */
export const snippetHistoryType = 'snippet-history';

const historyRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    // A hash keeps the session from storing the expanded message twice.
    sentHash: Type.String(),
    typed: Type.String(),
  },
  { additionalProperties: false },
);

type HistoryRecord = Static<typeof historyRecordSchema>;

// Pi trims text before it adds it to history, so the key ignores surrounding whitespace.
const hashSent = (text: string) => createHash('sha256').update(text.trim()).digest('hex');

export const historyRecord = (sent: string, typed: string): HistoryRecord => ({
  version: 1,
  sentHash: hashSent(sent),
  typed,
});

/** Maps sent-text hashes to typed text. Skips records it cannot read. */
export const readSnippetHistory = (entries: readonly SessionEntry[]): Map<string, string> => {
  const history = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== snippetHistoryType) {
      continue;
    }

    if (Value.Check(historyRecordSchema, entry.data)) {
      history.set(entry.data.sentHash, entry.data.typed);
    }
  }

  return history;
};

export const rememberTypedText = (history: Map<string, string>, record: HistoryRecord): void => {
  history.set(record.sentHash, record.typed);
};

export const typedTextFor = (history: ReadonlyMap<string, string>, sent: string) =>
  history.get(hashSent(sent));

const userText = (message: ReturnType<typeof sessionEntryToContextMessages>[number]) => {
  if (message.role !== 'user') {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
};

/**
 * Lists the text of each user message in `entries`, oldest first, the way
 * Pi's `renderInitialMessages` adds them to editor history.
 */
export const sentPromptTexts = (entries: readonly SessionEntry[]): string[] =>
  entries
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .map((message) => userText(message))
    .filter((text) => text !== '');
