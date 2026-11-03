import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { readWorkerChildren } from './workerDelivery.js';

const manager = 't-manager';

const childRow = { address: 't-child', state: 'live', parent: manager };

afterEach(() => {
  vi.unstubAllEnvs();
});

const stubAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-children-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

const savedAssignment = (directory: string): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal: manager,
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  };
};

const snapshotFiles = (directory: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);

        return [path, readFileSync(path, 'utf8')];
      }),
  );

const readChildWithAssignment = async (path: string) => {
  const hcFake = createHcFake();

  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('get', JSON.stringify({ ...childRow, labels: { 'tau.assignment': path } }));

  const hc: HcRuntime = { exec: hcFake.exec, connect: hcFake.connect, cwd: process.cwd() };
  const children = await readWorkerChildren(hc, manager);

  return { children, hcFake };
};

it('reads a saved assignment and writes nothing', async () => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const before = snapshotFiles(directory);

  const { children, hcFake } = await readChildWithAssignment(path);

  expect(children).toHaveLength(1);

  expect(children[0]?.assignment).toMatchObject({
    kind: 'saved',
    path,
    assignment: { assignmentId: saved.assignmentId },
  });

  expect(snapshotFiles(directory)).toEqual(before);
  expect(hcFake.calls.map((call) => call.commandArguments[0])).toEqual(['ls', 'get']);
  expect(hcFake.messages).toEqual([]);
});

it('reports a missing assignment file and writes nothing', async () => {
  const directory = stubAgentDirectory();
  const path = join(directory, 'assignments', 'missing', 'assignment.json');
  const before = snapshotFiles(directory);

  const { children, hcFake } = await readChildWithAssignment(path);

  expect(children).toHaveLength(1);
  expect(children[0]?.assignment).toEqual({ kind: 'missing', path });

  expect(existsSync(path)).toBe(false);
  expect(snapshotFiles(directory)).toEqual(before);
  expect(hcFake.calls.map((call) => call.commandArguments[0])).toEqual(['ls', 'get']);
  expect(hcFake.messages).toEqual([]);
});

it('reports a malformed assignment file and writes nothing', async () => {
  const directory = stubAgentDirectory();
  const path = join(directory, 'assignment.json');

  writeFileSync(path, JSON.stringify({ version: 2, assignmentId: 'not-a-uuid' }));

  const before = snapshotFiles(directory);

  const { children, hcFake } = await readChildWithAssignment(path);

  expect(children).toHaveLength(1);
  expect(children[0]?.assignment).toMatchObject({ kind: 'malformed', path });

  expect(snapshotFiles(directory)).toEqual(before);
  expect(hcFake.calls.map((call) => call.commandArguments[0])).toEqual(['ls', 'get']);
  expect(hcFake.messages).toEqual([]);
});
