import { expect, it } from 'vitest';

import { inboxMessageType } from './receiptDecision.js';
import { createReceiptStore } from './receipts.js';

const receiptEntry = (messageId: string, sessionId: string) => ({
  type: 'custom_message',
  customType: inboxMessageType,
  details: { version: 2, messageId, sessionId, family: 'handover' },
});

it('restores the receipts of this session', () => {
  const store = createReceiptStore('s1');

  store.restore([receiptEntry('m1', 's1'), receiptEntry('m2', 's2')]);

  expect(store.hasReceipt('m1')).toBe(true);
  expect(store.hasReceipt('m2')).toBe(false);
});

it('keeps the shown content of a restored receipt', () => {
  const store = createReceiptStore('s1');

  store.restore([{ ...receiptEntry('m1', 's1'), content: 'handover text' }]);

  expect(store.receiptedMessage('m1')).toEqual({
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
    content: 'handover text',
  });
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

it('clears a queued id after a failed wake, so a later drain reads the message again', () => {
  const store = createReceiptStore('s1');

  store.markQueued('m1');
  store.clearQueued('m1');

  expect(store.isQueued('m1')).toBe(false);
});

it('drops a receipt the session entries no longer hold', () => {
  const store = createReceiptStore('s1');

  store.restore([receiptEntry('m1', 's1')]);
  store.restore([]);

  expect(store.hasReceipt('m1')).toBe(false);
});

it('releases each queued id without a receipt', () => {
  const store = createReceiptStore('s1');

  store.markQueued('m1');
  store.markQueued('m2');
  store.restore([receiptEntry('m2', 's1')]);

  store.releaseQueued();

  expect(store.isQueued('m1')).toBe(false);
  expect(store.isRecovered('m1')).toBe(true);
});

it('keeps a released id recovered until its receipt is saved', () => {
  const store = createReceiptStore('s1');

  store.markQueued('m1');
  store.releaseQueued();
  store.markQueued('m1');
  store.restore([]);

  expect(store.isRecovered('m1')).toBe(true);

  store.restore([receiptEntry('m1', 's1')]);

  expect(store.isRecovered('m1')).toBe(false);
});
