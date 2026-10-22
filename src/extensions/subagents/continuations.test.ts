import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { refuseLiveNativeWriter } from './continuations.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import type { Task } from './types.js';

const sessionFixture = () => {
  const directory = temporaryDirectory(afterTest, 'tau-live-writers-');

  const nativeSessionFile = join(directory, 'native.jsonl');
  const linkedSessionFile = join(directory, 'linked.jsonl');
  const otherSessionFile = join(directory, 'other.jsonl');
  writeFileSync(nativeSessionFile, '');
  writeFileSync(otherSessionFile, '');
  symlinkSync(nativeSessionFile, linkedSessionFile);

  const task: Task = {
    version: 11,
    taskId: 'task-one',
    task: 'Inspect source.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-one',
    nativeSessionId: 'native-one',
    nativeSessionFile,
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    monotonicDeadline: 20000,
    loadout: fixtureLoadout(directory),
  };

  return { directory, task, linkedSessionFile, otherSessionFile };
};

type SessionFixture = ReturnType<typeof sessionFixture>;

const pane = (agentSession: unknown) => [
  { pane_id: 'other-pane', agent_session: null },
  { pane_id: 'live-pane', agent_session: agentSession },
];

const refuse = (fixture: SessionFixture, agentSession: unknown) => () => {
  refuseLiveNativeWriter(pane(agentSession), fixture.task);
};

it.each([
  {
    name: 'session id',
    session: ({ task }: SessionFixture) => ({ kind: 'id', value: task.nativeSessionId }),
  },
  {
    name: 'session file reported as an id',
    session: ({ task }: SessionFixture) => ({ kind: 'id', value: task.nativeSessionFile }),
  },
  {
    name: 'session file path',
    session: ({ task }: SessionFixture) => ({ kind: 'path', value: task.nativeSessionFile }),
  },
  {
    name: 'session file through another path',
    session: (fixture: SessionFixture) => ({ kind: 'path', value: fixture.linkedSessionFile }),
  },
])('refuses a follow-up while a pane writes the native $name', ({ session }) => {
  const fixture = sessionFixture();

  expect(refuse(fixture, session(fixture))).toThrow('live-pane');
});

it.each([
  { name: 'no session', session: () => undefined },
  { name: 'another session id', session: () => ({ kind: 'id', value: 'native-two' }) },
  {
    name: 'an id that names a path to the native session',
    session: (fixture: SessionFixture) => ({ kind: 'id', value: fixture.linkedSessionFile }),
  },
  {
    name: 'another existing session file',
    session: (fixture: SessionFixture) => ({ kind: 'path', value: fixture.otherSessionFile }),
  },
  {
    name: 'a session file that no longer exists',
    session: (fixture: SessionFixture) => ({
      kind: 'path',
      value: join(fixture.directory, 'removed.jsonl'),
    }),
  },
])('allows a follow-up beside a pane with $name', ({ session }) => {
  const fixture = sessionFixture();

  expect(refuse(fixture, session(fixture))).not.toThrow();
});

it.each([
  { name: 'relative', value: () => 'native.jsonl', error: 'relative' },
  {
    name: 'unreadable',
    value: (fixture: SessionFixture) => join(fixture.otherSessionFile, 'child.jsonl'),
    error: 'ENOTDIR',
  },
])('refuses a follow-up when a $name live session path cannot be verified', ({ value, error }) => {
  const fixture = sessionFixture();

  expect(refuse(fixture, { kind: 'path', value: value(fixture) })).toThrow(error);
});
