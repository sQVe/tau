import { expect, it } from 'vitest';

import { decideArchitectInbox } from './architectInboxDecision.js';
import type { ArchitectInboxDecision, ArchitectInboxFacts } from './architectInboxDecision.js';

it.for<[string, ArchitectInboxFacts, ArchitectInboxDecision]>([
  [
    'a live terminal with no label decides inboxMissing',
    { state: 'live', inboxLabel: undefined },
    'inboxMissing',
  ],
  [
    'a live terminal with an empty label decides inboxMissing',
    { state: 'live', inboxLabel: '' },
    'inboxMissing',
  ],
  [
    'a live terminal with an inbox label decides send',
    { state: 'live', inboxLabel: 'rpc1:/tmp/a/s.sock' },
    'send',
  ],
  [
    'a live terminal with another protocol decides send',
    { state: 'live', inboxLabel: 'other:x' },
    'send',
  ],
  [
    'a finished terminal with no label decides send',
    { state: 'finished', inboxLabel: undefined },
    'send',
  ],
  [
    'an exited terminal with an empty label decides send',
    { state: 'exited', inboxLabel: '' },
    'send',
  ],
])('%s', ([, facts, expected]) => {
  expect(decideArchitectInbox(facts)).toBe(expected);
});
