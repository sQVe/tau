import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import {
  assignmentDirectory,
  assignmentPath,
  readAssignment,
  saveReport,
  seedSession,
  writeAssignment,
} from './assignment.js';
import type { Assignment } from './assignment.js';
import { checkoutFolder } from './records.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/assignment/${name}`, import.meta.url));

const useAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

// The fixture's session file names a path outside the assignment folder, so tests place it inside.
const assignmentWithSessionInFolder = (): Assignment => {
  const fixture = JSON.parse(readFileSync(fixturePath('valid.json'), 'utf8')) as Assignment;
  const session = { id: fixture.session.id, file: '' };

  session.file = join(assignmentDirectory(fixture.assignmentId), `${session.id}.jsonl`);

  return { ...fixture, session };
};

it('reads a valid version 1 assignment file', async () => {
  expect(await readAssignment(fixturePath('valid.json'))).toMatchObject({
    version: 1,
    assignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f',
    profile: 'scout',
    report: null,
  });
});

it('reads a missing assignment file as absent', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');

  expect(await readAssignment(join(directory, 'assignment.json'))).toBeUndefined();
});

it('refuses a malformed assignment file', async () => {
  await expect(readAssignment(fixturePath('malformed.json'))).rejects.toThrow(
    'Malformed assignment',
  );
});

it('refuses an assignment file in a newer format', async () => {
  await expect(readAssignment(fixturePath('newer.json'))).rejects.toThrow('newer format');
});

it('writes the assignment in a private folder and reads it back', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();

  await writeAssignment(assignment);

  expect(statSync(assignmentDirectory(assignment.assignmentId)).mode & 0o777).toBe(0o700);
  expect(await readAssignment(assignmentPath(assignment.assignmentId))).toEqual(assignment);
});

it('refuses a malformed assignment before it writes any file', async () => {
  useAgentDirectory();
  const assignment = { ...assignmentWithSessionInFolder(), task: '' };

  await expect(writeAssignment(assignment)).rejects.toThrow('Malformed assignment');

  expect(existsSync(assignment.session.file)).toBe(false);
  expect(await readAssignment(assignmentPath(assignment.assignmentId))).toBeUndefined();
});

it('places the assignment file under the agent directory', () => {
  const directory = useAgentDirectory();
  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';

  expect(assignmentPath(assignmentId)).toBe(
    join(directory, 'tau', checkoutFolder, 'assignments', assignmentId, 'assignment.json'),
  );
});

it('refuses to save a report for a missing assignment and creates no file', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const path = join(directory, 'assignment.json');
  const report = { outcome: 'success' as const, summary: 'Found it.', evidence: [] };

  await expect(saveReport(path, report)).rejects.toThrow('Missing assignment');

  expect(existsSync(path)).toBe(false);
});

it('refuses a session ID that is not a UUID and creates no file', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const outsideFile = join(assignmentDirectory(assignment.assignmentId), '..', 'outside.jsonl');

  const escaping = {
    ...assignment,
    session: { id: '../outside', file: outsideFile },
  };

  await expect(writeAssignment(escaping)).rejects.toThrow('Malformed assignment');

  expect(existsSync(outsideFile)).toBe(false);
  expect(await readAssignment(assignmentPath(assignment.assignmentId))).toBeUndefined();
});

it('refuses an assignment whose session file is outside its folder', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const outside = { ...assignment, session: { ...assignment.session, file: '/tmp/outside.jsonl' } };

  await expect(writeAssignment(outside)).rejects.toThrow('session file');

  expect(await readAssignment(assignmentPath(assignment.assignmentId))).toBeUndefined();
});

it('saves a report into the assignment and reads it back', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const report = { outcome: 'success' as const, summary: 'Found it.', evidence: ['src/config.ts'] };

  await writeAssignment(assignment);
  await saveReport(assignmentPath(assignment.assignmentId), report);

  expect((await readAssignment(assignmentPath(assignment.assignmentId)))?.report).toEqual(report);
});

it('refuses an invalid report and keeps the saved file', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const invalid = { outcome: 'maybe', summary: 'Found it.', evidence: [] };

  await writeAssignment(assignment);

  await expect(
    saveReport(assignmentPath(assignment.assignmentId), invalid as never),
  ).rejects.toThrow('Malformed report');

  expect((await readAssignment(assignmentPath(assignment.assignmentId)))?.report).toBeNull();
});

it('refuses a report that names a task and keeps the saved file', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const withTask = { outcome: 'success', summary: 'Found it.', evidence: [], taskId: 'task-one' };

  await writeAssignment(assignment);

  await expect(
    saveReport(assignmentPath(assignment.assignmentId), withTask as never),
  ).rejects.toThrow('Malformed report');

  expect((await readAssignment(assignmentPath(assignment.assignmentId)))?.report).toBeNull();
});

it('saves the session header readable by its owner only', () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const file = join(directory, 'session.jsonl');

  seedSession({
    file,
    id: 'session-one',
    cwd: '/repository',
    parentSession: '/tmp/parent.jsonl',
    createdAt: 1_700_000_000_000,
  });

  expect(statSync(file).mode & 0o777).toBe(0o600);

  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    type: 'session',
    id: 'session-one',
    cwd: '/repository',
    parentSession: '/tmp/parent.jsonl',
  });
});

it('refuses to overwrite an existing session file', () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const file = join(directory, 'session.jsonl');

  writeFileSync(file, 'existing\n');

  expect(() => {
    seedSession({
      file,
      id: 'session-one',
      cwd: '/repository',
      parentSession: '/tmp/parent.jsonl',
      createdAt: 1_700_000_000_000,
    });
  }).toThrow('EEXIST');

  expect(readFileSync(file, 'utf8')).toBe('existing\n');
});
