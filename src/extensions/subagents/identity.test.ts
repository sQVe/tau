import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { monotonicNow, reserveTask } from './admission.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { authenticateParent } from './identity.js';
import { seedSession } from './profiles.js';
import { acceptReport, claimSuccessor, publish, recordEvent } from './records.js';
import type { Task } from './types.js';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-nested-identity-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const session = { file: join(root, 'root.jsonl'), id: 'root' };
  writeFileSync(
    session.file,
    `${JSON.stringify({ type: 'session', version: 3, id: session.id, cwd: root })}\n`,
  );
  const directory = join(root, 'worker');
  mkdirSync(directory);
  const loadout = fixtureLoadout(root);
  const task = {
    version: 1,
    taskId: 'worker',
    task: 'Read the assigned file.',
    ownerId: 'controller',
    parentSession: session.file,
    parentSessionId: session.id,
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: Date.now(),
    deadline: Date.now() + 60000,
    cancellationBudget: 5000,
    tree: {
      rootSession: session.file,
      rootSessionId: session.id,
      monotonicDeadline: monotonicNow() + 60000,
    },
    loadout,
  } satisfies Task;
  reserveTask(root, task);
  publish(directory, 'task.json', task);
  seedSession(task);
  const processIdentity = { processId: 4242, startedAt: 'original start' };
  publish(directory, 'owned.json', { ...processIdentity, token: task.nativeSessionFile });
  recordEvent(directory, task.taskId, 'ready', {
    detail: 'Runtime checked.',
    processId: processIdentity.processId,
  });
  recordEvent(directory, task.taskId, 'accepted', 'Task started.');
  const current = { file: task.nativeSessionFile, id: task.nativeSessionId };

  return { root, session, directory, task, processIdentity, current };
};

it('authenticates a nested parent without trusting its environment locator', () => {
  const { root, current, processIdentity, directory, task, session } = setup();

  expect(authenticateParent(root, current, processIdentity).parent).toEqual(task);
  expect(authenticateParent(root, current, processIdentity, directory).tree.parentTaskId).toBe(
    task.taskId,
  );
  expect(() => authenticateParent(root, current, processIdentity, root)).toThrow('locator');
  expect(() => authenticateParent(root, current, processIdentity, join(root, 'missing'))).toThrow(
    'locator',
  );
  expect(() => authenticateParent(root, session, processIdentity)).toThrow(
    'different root identity',
  );
  expect(() =>
    authenticateParent(root, session, { processId: 9000, startedAt: 'root' }, directory),
  ).toThrow('identity');
  expect(() => authenticateParent(root, { ...current, id: 'spoofed' }, processIdentity)).toThrow(
    'identity',
  );
  expect(() => authenticateParent(root, current, { ...processIdentity, processId: 4243 })).toThrow(
    'identity',
  );
  expect(() =>
    authenticateParent(root, current, { ...processIdentity, startedAt: 'reused PID' }),
  ).toThrow('identity');
  writeFileSync(
    join(directory, 'task.json'),
    JSON.stringify({ ...task, tree: { ...task.tree, monotonicDeadline: monotonicNow() - 1 } }),
  );
  expect(() => authenticateParent(root, current, processIdentity)).toThrow('deadline');
});

it('refuses native forks and tree-less saved workers rather than treating them as new root authority', () => {
  const { root, current, processIdentity, directory, task } = setup();
  const fork = { file: join(root, 'fork.jsonl'), id: 'fork' };
  writeFileSync(
    fork.file,
    `${JSON.stringify({ type: 'session', version: 3, id: fork.id, cwd: root, parentSession: current.file })}\n`,
  );

  expect(() => authenticateParent(root, fork, { processId: 9000, startedAt: 'new' })).toThrow(
    'identity',
  );
  const { tree: _tree, ...treeLess } = task;
  writeFileSync(join(directory, 'task.json'), JSON.stringify(treeLess));
  expect(() => authenticateParent(root, current, processIdentity, directory)).toThrow(
    'identity does not match',
  );
});

it('refuses root authority to a live worker whose record uses a retired format', () => {
  const { root, session, directory, task, processIdentity } = setup();
  const { harness: _harness, ...unversioned } = task.loadout;
  writeFileSync(join(directory, 'task.json'), JSON.stringify({ ...task, loadout: unversioned }));

  expect(() => authenticateParent(root, session, processIdentity)).toThrow(
    'different root identity',
  );
  expect(
    authenticateParent(root, session, { processId: 9000, startedAt: 'root' }).tree.rootSessionId,
  ).toBe(session.id);
});

it('authenticates only the active successor while preserving original native ancestry', () => {
  const { root, current, processIdentity, directory, task } = setup();
  acceptReport(directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: [],
  });
  recordEvent(directory, task.taskId, 'cleanup', {
    detail: 'Confirmed stopped.',
    stopped: true,
  });
  const successorDirectory = join(root, 'successor');
  mkdirSync(successorDirectory);
  const successor: Task = {
    ...task,
    taskId: 'successor',
    predecessorTaskId: task.taskId,
    ownerId: 'new-controller',
  };
  reserveTask(root, successor);
  publish(successorDirectory, 'task.json', successor);
  claimSuccessor(directory, successor);
  publish(successorDirectory, 'owned.json', {
    ...processIdentity,
    startedAt: 'new start',
    token: task.nativeSessionFile,
  });
  recordEvent(successorDirectory, successor.taskId, 'ready', {
    detail: 'Runtime checked.',
    processId: processIdentity.processId,
  });
  recordEvent(successorDirectory, successor.taskId, 'accepted', 'Started.');

  expect(() => authenticateParent(root, current, processIdentity)).toThrow('identity');
  expect(
    authenticateParent(
      root,
      current,
      { ...processIdentity, startedAt: 'new start' },
      successorDirectory,
    ).parent,
  ).toEqual(successor);
  expect(() =>
    authenticateParent(root, current, { ...processIdentity, startedAt: 'new start' }, directory),
  ).toThrow('locator');
  recordEvent(successorDirectory, successor.taskId, 'parentClosed', 'Owner exited.');
  expect(() =>
    authenticateParent(root, current, { ...processIdentity, startedAt: 'new start' }),
  ).toThrow('identity');
});

it('disqualifies a candidate with an unreadable ownership record without granting root identity', () => {
  const { root, session, current, processIdentity, directory } = setup();

  expect(authenticateParent(root, current, processIdentity).tree.parentTaskId).toBe('worker');
  writeFileSync(join(directory, 'owned.json'), '{');
  expect(() => authenticateParent(root, current, processIdentity)).toThrow('identity');
  expect(() => authenticateParent(root, session, processIdentity)).toThrow('unreadable');
});
