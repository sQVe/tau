import { expect, it } from 'vitest';

import {
  expiredWorkers,
  followUpMilliseconds,
  followUpRefusal,
  retentionMilliseconds,
} from './retentionDecision.js';
import type { SavedWorker } from './retentionDecision.js';

const now = 10 * retentionMilliseconds;
const old = now - retentionMilliseconds - 1;

const worker = (taskId: string, saved: Partial<SavedWorker> = {}): SavedWorker => ({
  taskId,
  lastWrite: old,
  stopped: true,
  currentSession: false,
  predecessorTaskId: undefined,
  nativeSessionTaskId: undefined,
  complete: true,
  links: 'known',
  ...saved,
});

it.each([
  { case: 'an old stopped worker', workers: [worker('a')], expired: ['a'] },
  {
    case: 'an old stopped worker that holds its own conversation file',
    workers: [worker('a', { nativeSessionTaskId: 'a' })],
    expired: ['a'],
  },
  {
    case: 'an old stopped worker whose predecessor is already gone',
    workers: [worker('a', { predecessorTaskId: 'gone' }), worker('b')],
    expired: ['a', 'b'],
  },
  {
    case: 'a stopped worker written exactly 14 days ago',
    workers: [worker('a', { lastWrite: now - retentionMilliseconds })],
    expired: [],
  },
  {
    case: 'an old worker without a confirmed stop',
    workers: [worker('a', { stopped: false })],
    expired: [],
  },
  {
    case: 'an old stopped worker of the running session',
    workers: [worker('a', { currentSession: true })],
    expired: [],
  },
  {
    case: 'the predecessor chain of a recent follow-up',
    workers: [
      worker('a'),
      worker('b', { predecessorTaskId: 'a' }),
      worker('c', { predecessorTaskId: 'b', lastWrite: now }),
    ],
    expired: [],
  },
  {
    case: 'the holder of a running follow-up native session',
    workers: [worker('a'), worker('b', { nativeSessionTaskId: 'a', stopped: false })],
    expired: [],
  },
  {
    case: 'an old predecessor of an expired follow-up, follow-up first',
    workers: [worker('a'), worker('b', { predecessorTaskId: 'a', nativeSessionTaskId: 'a' })],
    expired: ['b', 'a'],
  },
  {
    case: 'an expired chain, each task before the one it points to',
    workers: [
      worker('a'),
      worker('c', { predecessorTaskId: 'b', nativeSessionTaskId: 'a' }),
      worker('b', { predecessorTaskId: 'a', nativeSessionTaskId: 'a' }),
    ],
    expired: ['c', 'b', 'a'],
  },
  {
    case: 'a link cycle and the conversation holder it points to, beside an unrelated task',
    workers: [
      worker('source'),
      worker('a', { predecessorTaskId: 'b', nativeSessionTaskId: 'source' }),
      worker('b', { predecessorTaskId: 'a', nativeSessionTaskId: 'source' }),
      worker('unrelated'),
    ],
    expired: ['unrelated'],
  },
  {
    case: 'an old stopped worker read while its files changed',
    workers: [worker('a', { complete: false })],
    expired: [],
  },
  {
    case: 'the source of a successor read while its files changed',
    workers: [worker('a'), worker('b', { predecessorTaskId: 'a', complete: false })],
    expired: [],
  },
  {
    case: 'any old worker while a recent worker has unknown links',
    workers: [worker('a'), worker('b', { stopped: false, links: 'malformed', lastWrite: now })],
    expired: [],
  },
  {
    case: 'any old worker while an old unconfirmed worker could not be read',
    workers: [worker('a'), worker('b', { stopped: false, links: 'unreadable' })],
    expired: [],
  },
  {
    case: 'any old worker while an old stopped worker could not be read',
    workers: [worker('a'), worker('b', { links: 'unreadable' })],
    expired: [],
  },
  {
    case: 'an unconfirmed worker with unknown links written over 14 days ago',
    workers: [worker('a'), worker('b', { stopped: false, links: 'malformed' })],
    expired: ['a', 'b'],
  },
  {
    case: 'an unconfirmed worker with unknown links written exactly 14 days ago',
    workers: [
      worker('a'),
      worker('b', { stopped: false, links: 'malformed', lastWrite: now - retentionMilliseconds }),
    ],
    expired: [],
  },
  {
    case: 'an old current-session worker with unknown links',
    workers: [worker('a'), worker('b', { currentSession: true, links: 'malformed' })],
    expired: ['a'],
  },
  {
    case: 'an old worker beside an expired worker with unknown links',
    workers: [worker('a'), worker('b', { links: 'malformed' })],
    expired: ['a', 'b'],
  },
  {
    case: 'a running follow-up of a deleted predecessor',
    workers: [worker('b', { predecessorTaskId: 'a', stopped: false })],
    expired: [],
  },
])('decides deletion for $case', ({ workers, expired }) => {
  expect(expiredWorkers(workers, now)).toEqual(expired);
});

it.each([
  { case: 'a source written just now', age: 0, refused: false },
  { case: 'a source written exactly 13 days ago', age: followUpMilliseconds, refused: false },
  { case: 'a source written over 13 days ago', age: followUpMilliseconds + 1, refused: true },
])('decides a follow-up of $case', ({ age, refused }) => {
  expect(followUpRefusal(now - age, now) !== undefined).toBe(refused);
});
