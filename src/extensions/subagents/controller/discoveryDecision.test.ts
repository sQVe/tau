import { expect, it } from 'vitest';

import {
  discoverTask,
  publicationWindow,
  retriesPending,
  rootSettled,
  stampMargin,
} from './discoveryDecision.js';
import type { TaskRecordFact } from './discoveryDecision.js';

const now = 10 * publicationWindow;

it.each<{ case: string; record: TaskRecordFact; discovery: ReturnType<typeof discoverTask> }>([
  {
    case: 'a published record of this task',
    record: { kind: 'published', taskId: 'task', parentSessionId: 'parent' },
    discovery: { kind: 'session', parentSessionId: 'parent' },
  },
  {
    case: 'a published record that names another task',
    record: { kind: 'published', taskId: 'other', parentSessionId: 'parent' },
    discovery: { kind: 'ignored' },
  },
  { case: 'an unreadable record', record: { kind: 'unreadable' }, discovery: { kind: 'ignored' } },
  {
    case: 'a missing record in a new directory',
    record: { kind: 'missing', changedAt: now - 1 },
    discovery: { kind: 'pending', changedAt: now - 1 },
  },
  {
    case: 'a missing record in a directory just inside the window',
    record: { kind: 'missing', changedAt: now - publicationWindow + 1 },
    discovery: { kind: 'pending', changedAt: now - publicationWindow + 1 },
  },
  {
    case: 'a missing record in a directory at the end of the window',
    record: { kind: 'missing', changedAt: now - publicationWindow },
    discovery: { kind: 'abandoned' },
  },
  {
    case: 'a missing record in a vanished directory',
    record: { kind: 'missing', changedAt: undefined },
    discovery: { kind: 'gone' },
  },
])('discovers $case', ({ record, discovery }) => {
  expect(discoverTask('task', record, now)).toEqual(discovery);
});

it.each([
  { case: 'a new pending directory', changedAt: now, retried: true },
  {
    case: 'a pending directory just inside the window',
    changedAt: now - publicationWindow + 1,
    retried: true,
  },
  {
    case: 'a pending directory at the end of the window',
    changedAt: now - publicationWindow,
    retried: false,
  },
])('decides a retry of $case', ({ changedAt, retried }) => {
  expect(retriesPending(changedAt, now)).toBe(retried);
});

const listed = { change: now - 2 * stampMargin, at: now - stampMargin + 1 };

it.each([
  { case: 'a root never listed', listed: undefined, change: listed.change, settled: false },
  { case: 'a missing root', listed, change: undefined, settled: false },
  { case: 'an unchanged settled root', listed, change: listed.change, settled: true },
  { case: 'a changed root', listed, change: listed.change + 1, settled: false },
  {
    case: 'a root listed within the stamp margin of its change',
    listed: { change: listed.change, at: listed.change + stampMargin },
    change: listed.change,
    settled: false,
  },
])('decides whether $case is settled', ({ listed: listing, change, settled }) => {
  expect(rootSettled(listing, change)).toBe(settled);
});
