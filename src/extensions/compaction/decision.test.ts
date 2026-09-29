import { expect, it } from 'vitest';

import { chooseFirstKeptEntry, shouldCompact } from './decision.js';
import type { CompactionFacts, ContextEntryFacts } from './decision.js';

const due: CompactionFacts = {
  outcome: 'completed',
  aborted: false,
  compactionPending: false,
  contextTokens: 250_000,
  thresholdTokens: 200_000,
  failedAtTokens: undefined,
};

it.each([
  { facts: due, compact: true },
  { facts: { ...due, contextTokens: 200_000 }, compact: false },
  { facts: { ...due, contextTokens: 150_000 }, compact: false },
  { facts: { ...due, contextTokens: undefined }, compact: false },
  { facts: { ...due, outcome: 'aborted' as const }, compact: false },
  { facts: { ...due, outcome: 'error' as const }, compact: false },
  { facts: { ...due, aborted: true }, compact: false },
  { facts: { ...due, compactionPending: true }, compact: false },
  { facts: { ...due, thresholdTokens: 300_000 }, compact: false },
  { facts: { ...due, failedAtTokens: 240_000 }, compact: false },
  { facts: { ...due, failedAtTokens: 230_001 }, compact: false },
  { facts: { ...due, failedAtTokens: 230_000 }, compact: true },
  { facts: { ...due, failedAtTokens: 210_000 }, compact: true },
])('compacts $compact for $facts', ({ facts, compact }) => {
  expect(shouldCompact(facts)).toBe(compact);
});

const entry = (
  id: string,
  roles: string[],
  tokens: number,
  entryType = 'message',
): ContextEntryFacts => ({ id, entryType, roles, tokens });

it.each([
  {
    name: 'cuts at the user entry where the recent tail reaches the budget',
    entries: [
      entry('old-user', ['user'], 30),
      entry('old-assistant', ['assistant'], 30),
      entry('recent-user', ['user'], 10),
      entry('recent-assistant', ['assistant'], 10),
    ],
    kept: 'recent-user',
  },
  {
    name: 'moves a cut that lands on a tool result to the next assistant entry',
    entries: [
      entry('user', ['user'], 30),
      entry('call', ['assistant'], 5),
      entry('result', ['toolResult'], 30),
      entry('answer', ['assistant'], 5),
    ],
    kept: 'answer',
  },
  {
    name: 'keeps more than the budget when no cut entry follows the tail start',
    entries: [
      entry('user', ['user'], 30),
      entry('call', ['assistant'], 5),
      entry('result', ['toolResult'], 30),
    ],
    kept: 'call',
  },
  {
    name: 'skips state-only entries and custom messages as cut points',
    entries: [
      entry('user', ['user'], 30),
      entry('model-change', [], 0, 'model_change'),
      entry('notice', ['custom'], 30),
      entry('answer', ['assistant'], 5),
    ],
    kept: 'answer',
  },
  {
    name: 'summarizes the previous summary together with newer messages',
    entries: [
      entry('previous', ['compactionSummary'], 10, 'compaction'),
      entry('user', ['user'], 30),
      entry('recent', ['user'], 25),
    ],
    kept: 'recent',
  },
  {
    name: 'returns nothing when only the previous summary precedes the cut',
    entries: [
      entry('previous', ['compactionSummary'], 10, 'compaction'),
      entry('user', ['user'], 30),
    ],
    kept: undefined,
  },
  {
    name: 'returns nothing when only system messages precede the cut',
    entries: [entry('system', ['system'], 30), entry('user', ['user'], 30)],
    kept: undefined,
  },
  {
    name: 'returns nothing when the whole context fits in the recent tail',
    entries: [entry('user', ['user'], 5), entry('assistant', ['assistant'], 5)],
    kept: undefined,
  },
  {
    name: 'returns nothing when no entry can start the kept part',
    entries: [entry('result', ['toolResult'], 30), entry('other', ['toolResult'], 30)],
    kept: undefined,
  },
])('$name', ({ entries, kept }) => {
  expect(chooseFirstKeptEntry(entries, 20)).toBe(kept);
});
