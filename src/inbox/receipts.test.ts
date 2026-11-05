import { expect, it } from 'vitest';

import { inboxMessageType } from './receiptDecision.js';
import { createReceiptStore } from './receipts.js';

const receiptEntry = (messageId: string, sessionId: string) => ({
  type: 'custom_message',
  customType: inboxMessageType,
  details: { version: 1, messageId, sessionId, family: 'handover' },
});

it('restores the receipts of this session', () => {
  const store = createReceiptStore('s1');

  store.restore([receiptEntry('m1', 's1'), receiptEntry('m2', 's2')]);

  expect(store.hasReceipt('m1')).toBe(true);
  expect(store.hasReceipt('m2')).toBe(false);
});

it('reports no receipt when the session entries are empty', () => {
  const store = createReceiptStore('s1');

  store.restore([]);

  expect(store.hasReceipt('m1')).toBe(false);
});

it('ignores a malformed receipt entry', () => {
  const store = createReceiptStore('s1');

  store.restore([{ type: 'custom_message', customType: inboxMessageType, details: 'bad' }]);

  expect(store.hasReceipt('m1')).toBe(false);
});

it('clears a queued id once its receipt is saved', () => {
  const store = createReceiptStore('s1');

  store.markQueued('m1');
  store.restore([]);
  expect(store.isQueued('m1')).toBe(true);

  store.restore([receiptEntry('m1', 's1')]);
  expect(store.isQueued('m1')).toBe(false);
});
