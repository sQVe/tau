import { expect, it } from 'vitest';

import {
  decideUnreadListRemoval,
  decideWorkerFolderRemoval,
  isWorkerCandidate,
  scratchLaunchGrace,
  snapshotFollowUpWindow,
} from './workerFolderDecision.js';
import type {
  SnapshotFolder,
  StartingWorker,
  WorkerFolder,
  WorkerFolderFacts,
  WorkerFolderRemoval,
  WorkerTerminalFact,
} from './workerFolderDecision.js';

const now = 1_000_000_000_000;
const second = 1000;
const hour = 3_600_000;

const folder = (name: string, age: number): WorkerFolder => ({
  name,
  bornAt: now - age,
});

const snapshot = (name: string, unusedFor: number | undefined): SnapshotFolder => ({
  name,
  unusedSince: unusedFor === undefined ? undefined : now - unusedFor,
});

const terminal = (
  assignmentId: string,
  running: boolean,
  packageSnapshot: string | null,
): WorkerTerminalFact => ({
  kind: 'read',
  assignmentId,
  running,
  packageSnapshot,
});

const unread = (assignmentPrefix: string | undefined): WorkerTerminalFact => ({
  kind: 'unread',
  assignmentPrefix,
});

const starting = (
  assignmentId: string,
  packageSnapshot: string | null,
  terminalAddress: string,
): StartingWorker => ({
  kind: 'read',
  assignmentId,
  running: true,
  packageSnapshot,
  terminalAddress,
});

const finished = (terminalAddress: string): WorkerTerminalFact => ({
  kind: 'finished',
  terminalAddress,
});

const table: {
  name: string;
  facts: WorkerFolderFacts;
  expected: Partial<WorkerFolderRemoval>;
}[] = [
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
      snapshots: [snapshot('snapshot-a', 25 * hour), snapshot('snapshot-b', undefined)],
      terminals: 'unread',
    },
    expected: {},
  },
  {
    name: 'keeps a snapshot a running worker names',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', 25 * hour), snapshot('snapshot-b', 25 * hour)],
      terminals: [terminal('assignment-a', true, 'snapshot-a')],
    },
    expected: { snapshots: ['snapshot-b'], clearUnused: ['snapshot-a'] },
  },
  {
    name: 'keeps a snapshot inside the follow-up window',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour)],
      terminals: [],
    },
    expected: {},
  },
  {
    name: 'removes an old unused snapshot',
    facts: {
      now,
      scratch: [],
      snapshots: [
        snapshot('snapshot-a', 25 * hour),
        snapshot('snapshot-b', snapshotFollowUpWindow),
        snapshot('snapshot-c', snapshotFollowUpWindow - 1),
      ],
      terminals: [terminal('assignment-a', false, 'snapshot-a')],
    },
    expected: { snapshots: ['snapshot-a', 'snapshot-b'] },
  },
  {
    name: "keeps every snapshot when a running worker's assignment is unread",
    facts: {
      now,
      scratch: [folder('assignment-a', 120 * second), folder('assignment-b', 120 * second)],
      snapshots: [snapshot('snapshot-a', 25 * hour), snapshot('snapshot-b', undefined)],
      terminals: [terminal('assignment-a', true, 'unread'), terminal('assignment-c', false, null)],
    },
    expected: { scratch: ['assignment-b'] },
  },
  {
    name: 'keeps every snapshot when a terminal is unread',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', 25 * hour), snapshot('snapshot-b', undefined)],
      terminals: [unread('0123abcd')],
    },
    expected: {},
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
    expected: {
      scratch: ['fedcba98-1111-2222-3333-444455556666'],
      snapshots: [],
    },
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
      snapshots: [snapshot('snapshot-a', 25 * hour)],
      terminals: [unread('0123abcd')],
    },
    expected: { scratch: ['ffff-0123abcd', '0123abc'] },
  },
  {
    name: 'keeps every scratch folder and snapshot when an unread terminal has no prefix',
    facts: {
      now,
      scratch: [folder('0123abcd-1111', 120 * second), folder('fedcba98-1111', 120 * second)],
      snapshots: [snapshot('snapshot-a', 25 * hour)],
      terminals: [unread(undefined)],
    },
    expected: {},
  },
  {
    name: 'removes a scratch folder that no unread prefix matches and a finished worker names',
    facts: {
      now,
      scratch: [folder('0123abcd-1111', 120 * second), folder('fedcba98-1111', 5 * second)],
      snapshots: [snapshot('snapshot-a', 25 * hour)],
      terminals: [unread('0123abcd'), terminal('fedcba98-1111', false, null)],
    },
    expected: { scratch: ['fedcba98-1111'], snapshots: [] },
  },
  {
    name: 'keeps a folder born in the future',
    facts: {
      now,
      scratch: [{ name: 'assignment-a', bornAt: now + 120 * second }],
      snapshots: [snapshot('snapshot-a', -25 * hour)],
      terminals: [],
    },
    expected: { scratch: [], snapshots: [] },
  },
  {
    name: 'keeps a day-old snapshot that a worker used until now',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', undefined)],
      terminals: [terminal('assignment-a', false, 'snapshot-a')],
    },
    expected: { markUnused: ['snapshot-a'] },
  },
  {
    name: 'marks an unnamed snapshot even when its folder is old',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', undefined), snapshot('snapshot-b', hour)],
      terminals: [],
    },
    expected: { markUnused: ['snapshot-a'] },
  },
  {
    name: 'clears the marker of a snapshot a running worker names',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour), snapshot('snapshot-b', undefined)],
      terminals: [terminal('assignment-a', true, 'snapshot-a')],
    },
    expected: { markUnused: ['snapshot-b'], clearUnused: ['snapshot-a'] },
  },
  {
    name: 'clears the marker of a named snapshot while another terminal is unread',
    facts: {
      now,
      scratch: [],
      snapshots: [
        snapshot('snapshot-a', hour),
        snapshot('snapshot-b', 25 * hour),
        snapshot('snapshot-c', undefined),
      ],
      terminals: [terminal('assignment-a', true, 'snapshot-a'), unread('0123abcd')],
    },
    expected: { clearUnused: ['snapshot-a'] },
  },
  {
    name: "clears the marker of a named snapshot while a running worker's assignment is unread",
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour), snapshot('snapshot-b', 25 * hour)],
      terminals: [
        terminal('assignment-a', true, 'snapshot-a'),
        terminal('assignment-b', true, 'unread'),
      ],
    },
    expected: { clearUnused: ['snapshot-a'] },
  },
  {
    name: 'does not clear a marker that is not set',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', undefined)],
      terminals: [terminal('assignment-a', true, 'snapshot-a')],
    },
    expected: {},
  },
  {
    name: 'removes a snapshot exactly one window after its marker',
    facts: {
      now,
      scratch: [],
      snapshots: [
        snapshot('snapshot-a', snapshotFollowUpWindow),
        snapshot('snapshot-b', snapshotFollowUpWindow - 1),
      ],
      terminals: [],
    },
    expected: { snapshots: ['snapshot-a'] },
  },
  {
    name: 'drops a starting hint whose terminal finished',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', undefined)],
      terminals: [starting('assignment-a', 'snapshot-a', 't-a'), finished('t-a')],
    },
    expected: { markUnused: ['snapshot-a'] },
  },
  {
    name: 'removes a snapshot a finished starting hint no longer uses',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', snapshotFollowUpWindow)],
      terminals: [starting('assignment-a', 'snapshot-a', 't-a'), finished('t-a')],
    },
    expected: { snapshots: ['snapshot-a'] },
  },
  {
    name: 'keeps a starting hint when another terminal finished',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour)],
      terminals: [starting('assignment-a', 'snapshot-a', 't-a'), finished('t-b')],
    },
    expected: { clearUnused: ['snapshot-a'] },
  },
  {
    name: 'keeps a starting hint when nothing finished',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour)],
      terminals: [starting('assignment-a', 'snapshot-a', 't-a')],
    },
    expected: { clearUnused: ['snapshot-a'] },
  },
  {
    name: 'keeps a snapshot a live worker names when the starting hint finished',
    facts: {
      now,
      scratch: [],
      snapshots: [snapshot('snapshot-a', hour)],
      terminals: [
        starting('assignment-a', 'snapshot-a', 't-a'),
        finished('t-a'),
        terminal('assignment-b', true, 'snapshot-a'),
      ],
    },
    expected: { clearUnused: ['snapshot-a'] },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decideWorkerFolderRemoval(facts)).toEqual({
    scratch: [],
    snapshots: [],
    markUnused: [],
    clearUnused: [],
    ...expected,
  });
});

const candidateTable: {
  name: string;
  listed: { state: string; name?: string | null };
  expected: boolean;
}[] = [
  {
    name: 'skips a finished terminal',
    listed: { state: 'finished' },
    expected: false,
  },
  {
    name: 'skips a finished terminal with a worker name',
    listed: { state: 'finished', name: 'scout-027f77a4' },
    expected: false,
  },
  {
    name: 'reads a live unnamed terminal',
    listed: { state: 'live' },
    expected: true,
  },
  {
    name: 'reads a live terminal named null',
    listed: { state: 'live', name: null },
    expected: true,
  },
  {
    name: 'reads a live terminal with a worker name',
    listed: { state: 'live', name: 'scout-027f77a4' },
    expected: true,
  },
  {
    name: 'skips a live terminal named shell',
    listed: { state: 'live', name: 'shell' },
    expected: false,
  },
];

it.each(candidateTable.map((row) => [row.name, row] as const))(
  '%s',
  (_name, { listed, expected }) => {
    expect(isWorkerCandidate(listed)).toBe(expected);
  },
);

it('clears only the markers of snapshots a starting worker names when the list is unread', () => {
  const snapshots = [
    snapshot('snapshot-a', hour),
    snapshot('snapshot-b', hour),
    snapshot('snapshot-c', undefined),
  ];

  const hints = [starting('assignment-a', 'snapshot-a', 't-a'), starting('x', 'snapshot-c', 't-x')];

  expect(decideUnreadListRemoval(snapshots, hints)).toEqual({
    scratch: [],
    snapshots: [],
    markUnused: [],
    clearUnused: ['snapshot-a'],
  });
});

it('clears no marker when no starting worker names a snapshot', () => {
  const hints = [
    starting('a', null, 't-a'),
    starting('b', 'unread', 't-b'),
    starting('c', 'snapshot-b', 't-c'),
  ];

  expect(decideUnreadListRemoval([snapshot('snapshot-a', hour)], hints)).toEqual({
    scratch: [],
    snapshots: [],
    markUnused: [],
    clearUnused: [],
  });
});
