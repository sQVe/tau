import { expect, it } from 'vitest';

import {
  decideWorkerFolderRemoval,
  scratchLaunchGrace,
  snapshotFollowUpWindow,
} from './workerFolderDecision.js';
import type {
  WorkerFolder,
  WorkerFolderFacts,
  WorkerFolderRemoval,
  WorkerTerminalFact,
} from './workerFolderDecision.js';

const now = 1_000_000_000_000;
const second = 1000;
const hour = 3_600_000;

const folder = (name: string, age: number): WorkerFolder => ({ name, bornAt: now - age });

const terminal = (
  assignmentId: string,
  running: boolean,
  packageSnapshot: string | null,
): WorkerTerminalFact => ({ kind: 'read', assignmentId, running, packageSnapshot });

const unread = (assignmentPrefix: string | undefined): WorkerTerminalFact => ({
  kind: 'unread',
  assignmentPrefix,
});

const table: { name: string; facts: WorkerFolderFacts; expected: WorkerFolderRemoval }[] = [
  {
    name: 'removes the scratch folder of a finished worker',
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second)],
      snapshots: [],
      terminals: [terminal('assignment-a', false, null)],
    },
    expected: { scratch: ['assignment-a'], snapshots: [] },
  },
  {
    name: 'keeps the scratch folder of a running worker',
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second)],
      snapshots: [],
      terminals: [terminal('assignment-a', true, null)],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'removes the scratch folder of a finished worker inside the launch grace',
    facts: {
      now,
      scratch: [folder('assignment-a', 5 * second)],
      snapshots: [],
      terminals: [terminal('assignment-a', false, null)],
    },
    expected: { scratch: ['assignment-a'], snapshots: [] },
  },
  {
    name: 'keeps a scratch folder inside the launch grace',
    facts: {
      now,
      scratch: [folder('assignment-a', 30 * second)],
      snapshots: [],
      terminals: [],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'removes a scratch folder with no terminal after the grace',
    facts: {
      now,
      scratch: [
        folder('assignment-a', scratchLaunchGrace),
        folder('assignment-b', scratchLaunchGrace + 1),
      ],
      snapshots: [],
      terminals: [],
    },
    expected: { scratch: ['assignment-a', 'assignment-b'], snapshots: [] },
  },
  {
    name: 'removes nothing when terminals are unread',
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second)],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: 'unread',
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'keeps a snapshot a running worker names',
    facts: {
      now,
      scratch: [],
      snapshots: [folder('snapshot-a', 25 * hour), folder('snapshot-b', 25 * hour)],
      terminals: [terminal('assignment-a', true, 'snapshot-a')],
    },
    expected: { scratch: [], snapshots: ['snapshot-b'] },
  },
  {
    name: 'keeps a snapshot inside the follow-up window',
    facts: {
      now,
      scratch: [],
      snapshots: [folder('snapshot-a', hour)],
      terminals: [],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'removes an old unused snapshot',
    facts: {
      now,
      scratch: [],
      snapshots: [folder('snapshot-a', 25 * hour), folder('snapshot-b', snapshotFollowUpWindow)],
      terminals: [terminal('assignment-a', false, 'snapshot-a')],
    },
    expected: { scratch: [], snapshots: ['snapshot-a', 'snapshot-b'] },
  },
  {
    name: "keeps every snapshot when a running worker's assignment is unread",
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second), folder('assignment-b', 120 * second)],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: [terminal('assignment-a', true, 'unread'), terminal('assignment-c', false, null)],
    },
    expected: { scratch: ['assignment-b'], snapshots: [] },
  },
  {
    name: 'keeps every snapshot when a terminal is unread',
    facts: {
      now,
      scratch: [],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: [unread('0123abcd')],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: "keeps the scratch folder an unread terminal's prefix starts",
    facts: {
      now,
      scratch: [
        folder('0123abcd-1111-2222-3333-444455556666', 120 * second),
        folder('fedcba98-1111-2222-3333-444455556666', 120 * second),
      ],
      snapshots: [],
      terminals: [unread('0123abcd')],
    },
    expected: { scratch: ['fedcba98-1111-2222-3333-444455556666'], snapshots: [] },
  },
  {
    name: 'keeps every scratch folder when an unread terminal has no prefix',
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second), folder('assignment-b', 120 * second)],
      snapshots: [],
      terminals: [unread(undefined), terminal('assignment-c', false, null)],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'still removes what read terminals leave when an unread terminal has a prefix',
    facts: {
      now,
      scratch: [folder('0123abcd-aaaa', 120 * second), folder('assignment-a', 120 * second)],
      snapshots: [],
      terminals: [unread('0123abcd'), terminal('assignment-a', false, null)],
    },
    expected: { scratch: ['assignment-a'], snapshots: [] },
  },
  {
    name: 'matches an unread prefix at the start of the dash-free scratch name only',
    facts: {
      now,
      scratch: [
        folder('0123-ab-cd-9999', 120 * second),
        folder('ffff-0123abcd', 120 * second),
        folder('0123abc', 120 * second),
      ],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: [unread('0123abcd')],
    },
    expected: { scratch: ['ffff-0123abcd', '0123abc'], snapshots: [] },
  },
  {
    name: 'keeps every scratch folder and snapshot when an unread terminal has no prefix',
    facts: {
      now,
      scratch: [folder('0123abcd-1111', 120 * second), folder('fedcba98-1111', 120 * second)],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: [unread(undefined)],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'removes a scratch folder that no unread prefix matches and a finished worker names',
    facts: {
      now,
      scratch: [folder('0123abcd-1111', 120 * second), folder('fedcba98-1111', 5 * second)],
      snapshots: [folder('snapshot-a', 25 * hour)],
      terminals: [unread('0123abcd'), terminal('fedcba98-1111', false, null)],
    },
    expected: { scratch: ['fedcba98-1111'], snapshots: [] },
  },
  {
    name: 'keeps a folder born in the future',
    facts: {
      now,
      scratch: [{ name: 'assignment-a', bornAt: now + 120 * second }],
      snapshots: [{ name: 'snapshot-a', bornAt: now + 25 * hour }],
      terminals: [],
    },
    expected: { scratch: [], snapshots: [] },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decideWorkerFolderRemoval(facts)).toEqual(expected);
});
