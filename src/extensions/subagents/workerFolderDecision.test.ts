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
): WorkerTerminalFact => ({ assignmentId, running, packageSnapshot });

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
