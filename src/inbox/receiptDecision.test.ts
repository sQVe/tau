import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  decideCandidate,
  decideEnvelopeSession,
  inboxMessageType,
  readInboxReceipt,
} from './receiptDecision.js';
import type { ReceiptEntryFact } from './receiptDecision.js';

const readTable = [
  {
    name: 'a version 1 receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
  },
  {
    name: 'a version 2 answer receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' },
  },
  {
    name: 'a version 1 answer receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, messageId: 'm1', sessionId: 's1', family: 'answer' },
    },
    receipt: undefined,
  },
  {
    name: 'a version 2 receipt of an unknown family',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'other' },
    },
    receipt: undefined,
  },
  {
    name: 'an entry of another custom type',
    entry: { type: 'custom_message', customType: 'other', details: { version: 1 } },
    receipt: undefined,
  },
  {
    name: 'an entry without details',
    entry: { type: 'custom_message', customType: inboxMessageType },
    receipt: undefined,
  },
  {
    name: 'a version 3 receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt without a message id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt without a session id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, messageId: 'm1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt of an unknown family',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, messageId: 'm1', sessionId: 's1', family: 'other' },
    },
    receipt: undefined,
  },
] as const;

it.each(readTable.map((row) => [row.name, row] as const))('reads %s', (_name, row) => {
  expect(readInboxReceipt(row.entry)).toEqual(row.receipt);
});

const receiptFixture = (name: string): ReceiptEntryFact =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'receipt', name), 'utf8'),
  ) as ReceiptEntryFact;

const fixtureMessageId = '11111111-1111-4111-8111-111111111111';

it.each([
  {
    fixture: 'v1.json',
    receipt: {
      version: 2,
      messageId: fixtureMessageId,
      sessionId: 'session-1',
      family: 'handover',
    },
  },
  {
    fixture: 'v2.json',
    receipt: { version: 2, messageId: fixtureMessageId, sessionId: 'session-1', family: 'answer' },
  },
  { fixture: 'newer.json', receipt: undefined },
  { fixture: 'malformed.json', receipt: undefined },
])('reads the frozen receipt fixture $fixture', ({ fixture, receipt }) => {
  expect(readInboxReceipt(receiptFixture(fixture))).toEqual(receipt);
});

const candidateTable = [
  {
    name: 'cleanup when the own receipt is saved',
    facts: { hasOwnReceipt: true, queued: false },
    step: 'cleanup',
  },
  {
    name: 'cleanup even while queued',
    facts: { hasOwnReceipt: true, queued: true },
    step: 'cleanup',
  },
  {
    name: 'pending while queued without a receipt',
    facts: { hasOwnReceipt: false, queued: true },
    step: 'pending',
  },
  {
    name: 'read without a receipt or queue',
    facts: { hasOwnReceipt: false, queued: false },
    step: 'read',
  },
] as const;

it.each(candidateTable.map((row) => [row.name, row] as const))('decides %s', (_name, row) => {
  expect(decideCandidate(row.facts)).toBe(row.step);
});

const sessionTable = [
  { name: 'delivery to the own session', target: 's1', own: 's1', step: 'deliver' },
  { name: 'deferral to another session', target: 's2', own: 's1', step: 'defer' },
] as const;

it.each(sessionTable.map((row) => [row.name, row] as const))('decides %s', (_name, row) => {
  expect(decideEnvelopeSession(row.target, row.own)).toBe(row.step);
});
