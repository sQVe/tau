import { readFile } from 'node:fs/promises';

import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { historyRecord, readSnippetHistory, snippetHistoryType, typedTextFor } from './history.js';

const fixture = async (name: string): Promise<SessionEntry> => {
  const content = await readFile(new URL(`./fixtures/historyRecords/${name}`, import.meta.url));

  return JSON.parse(content.toString()) as SessionEntry;
};

const sent = 'Push back before you agree.\n\nShip it.';

const savedEntry = (data: unknown): SessionEntry => ({
  type: 'custom',
  customType: snippetHistoryType,
  data,
  id: 'saved',
  parentId: null,
  timestamp: '2026-10-01T12:00:00.000Z',
});

it('reads the typed text for the sent text of a saved record', async () => {
  const history = readSnippetHistory([await fixture('current.json')]);

  expect(typedTextFor(history, sent)).toBe('#push-back Ship it.');
  expect(typedTextFor(history, `\n${sent}  `)).toBe('#push-back Ship it.');
  expect(typedTextFor(history, 'Ship it.')).toBeUndefined();
});

it('reads back a record it writes', () => {
  const history = readSnippetHistory([savedEntry(historyRecord(sent, '#push-back Ship it.'))]);

  expect(typedTextFor(history, sent)).toBe('#push-back Ship it.');
});

it('reads no history from a session without records', () => {
  const message: SessionEntry = {
    type: 'custom',
    customType: 'other-extension',
    data: { version: 1, sentHash: 'x', typed: 'y' },
    id: 'other',
    parentId: null,
    timestamp: '2026-10-01T12:00:00.000Z',
  };

  expect(readSnippetHistory([]).size).toBe(0);
  expect(readSnippetHistory([message]).size).toBe(0);
});

it('skips newer and malformed records without hiding a readable one', async () => {
  const entries = [
    await fixture('newer.json'),
    await fixture('malformed.json'),
    savedEntry('not a record'),
    await fixture('current.json'),
  ];

  const history = readSnippetHistory(entries);

  expect(history.size).toBe(1);
  expect(typedTextFor(history, sent)).toBe('#push-back Ship it.');
});

it('keeps the record out of the model context', async () => {
  expect(sessionEntryToContextMessages(await fixture('current.json'))).toEqual([]);
});
