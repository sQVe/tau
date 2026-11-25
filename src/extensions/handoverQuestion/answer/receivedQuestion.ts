import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { parseHandoverQuestionHeading, readInboxReceipt } from '../../../inbox/receiptDecision.js';

export type ReceivedQuestion =
  | { kind: 'received'; askerTerminal: string; askerSession: string }
  | { kind: 'not-received' }
  | { kind: 'conflict' };

interface Asker {
  askerTerminal: string;
  askerSession: string;
}

const entryContent = (entry: SessionEntry): unknown =>
  entry.type === 'custom_message' ? entry.content : undefined;

const sameAsker = (left: Asker, right: Asker): boolean =>
  left.askerTerminal === right.askerTerminal && left.askerSession === right.askerSession;

export const receivedQuestion = (
  entries: readonly SessionEntry[],
  questionId: string,
  leadSession: string,
): ReceivedQuestion => {
  let asker: Asker | undefined;
  let conflicting = false;

  for (const entry of entries) {
    const receipt = readInboxReceipt(entry);

    if (receipt?.family !== 'handover-question' || receipt.questionId !== questionId) {
      continue;
    }

    if (receipt.sessionId !== leadSession) {
      continue;
    }

    const heading = parseHandoverQuestionHeading(entryContent(entry));

    if (heading === undefined || heading.questionId !== questionId) {
      continue;
    }

    const found = { askerTerminal: heading.askerTerminal, askerSession: heading.askerSession };

    if (asker === undefined) {
      asker = found;

      continue;
    }

    if (!sameAsker(asker, found)) {
      conflicting = true;
    }
  }

  if (conflicting) {
    return { kind: 'conflict' };
  }

  if (asker === undefined) {
    return { kind: 'not-received' };
  }

  return { kind: 'received', ...asker };
};
