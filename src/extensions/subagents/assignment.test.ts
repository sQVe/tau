import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import {
  assignmentDirectory,
  assignmentPath,
  checkoutFolder,
  readAssignment,
  saveQuestion,
  saveReport,
  seedSession,
  writeAssignment,
  writeFollowUpAssignment,
} from './assignment.js';
import type { Assignment } from './assignment.js';

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

const assignmentWithSessionInFolder = (): Assignment => {
  const fixture = JSON.parse(readFileSync(fixturePath('valid.json'), 'utf8')) as Assignment;
  const session = { id: fixture.session.id, file: '' };

  session.file = join(assignmentDirectory(fixture.assignmentId), `${session.id}.jsonl`);

  return { ...fixture, session };
};

it('reads version 3 assignment unchanged', async () => {
  const path = fixturePath('valid.json');
  const before = readFileSync(path);

  expect(await readAssignment(path)).toMatchObject({
    version: 3,
    assignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f',
    profile: 'scout',
    previousAssignmentId: null,
    extensionPackages: [
      {
        source: 'npm:review-package',
        path: '/agent/tmp/tau-worker-packages/3f9a2c1d/review-package',
      },
    ],
    questions: [],
    report: null,
  });

  expect(readFileSync(path)).toEqual(before);
});

it('reads version 2 as version 3', async () => {
  const path = fixturePath('version2.json');
  const before = readFileSync(path);

  expect(await readAssignment(path)).toMatchObject({
    version: 3,
    assignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f',
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  });

  expect(readFileSync(path)).toEqual(before);
});

it('keeps the saved questions of a version 2 assignment', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const path = join(directory, 'assignment.json');

  const saved = JSON.parse(readFileSync(fixturePath('version2.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  const question = {
    questionId: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    text: 'Which config file wins?',
    askedAt: 1_700_000_000_500,
  };

  writeFileSync(path, JSON.stringify({ ...saved, questions: [question] }));

  expect((await readAssignment(path))?.questions).toEqual([question]);
});

it('reads version 1 as version 3', async () => {
  const path = fixturePath('previous.json');
  const before = readFileSync(path);

  expect(await readAssignment(path)).toMatchObject({
    version: 3,
    assignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f',
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  });

  expect(readFileSync(path)).toEqual(before);
});

it('reads a missing assignment file as absent and creates nothing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const path = join(directory, 'assignment.json');

  expect(await readAssignment(path)).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

it('refuses a malformed assignment file without changing it', async () => {
  const path = fixturePath('malformed.json');
  const before = readFileSync(path);

  await expect(readAssignment(path)).rejects.toThrow('Malformed assignment');

  expect(readFileSync(path)).toEqual(before);
});

it('refuses an assignment file in a newer format without changing it', async () => {
  const path = fixturePath('newer.json');
  const before = readFileSync(path);

  await expect(readAssignment(path)).rejects.toThrow('newer format');

  expect(readFileSync(path)).toEqual(before);
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

const followUpId = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';

const followUpFor = (original: Assignment, file: string): Assignment => ({
  ...original,
  assignmentId: followUpId,
  previousAssignmentId: original.assignmentId,
  session: { ...original.session, file },
});

it('follow-up reuses saved session file', async () => {
  useAgentDirectory();
  const original = assignmentWithSessionInFolder();

  await writeAssignment(original);
  const sessionBefore = readFileSync(original.session.file);

  const followUp = followUpFor(original, original.session.file);

  await writeFollowUpAssignment(followUp);

  expect(await readAssignment(assignmentPath(original.assignmentId))).toEqual(original);
  expect(await readAssignment(assignmentPath(followUpId))).toEqual(followUp);
  expect(readFileSync(original.session.file)).toEqual(sessionBefore);
});

it('follow-up refuses a missing session', async () => {
  useAgentDirectory();
  const original = assignmentWithSessionInFolder();
  const missing = join(assignmentDirectory(original.assignmentId), 'missing.jsonl');
  const followUp = followUpFor(original, missing);

  await expect(writeFollowUpAssignment(followUp)).rejects.toThrow(
    `Follow-up assignment ${followUpId} session file is missing: ${missing}.`,
  );

  expect(existsSync(assignmentPath(followUpId))).toBe(false);
  expect(existsSync(missing)).toBe(false);
});

it('follow-up needs a previous ID', async () => {
  useAgentDirectory();
  const original = assignmentWithSessionInFolder();

  await writeAssignment(original);

  const followUp = { ...followUpFor(original, original.session.file), previousAssignmentId: null };

  await expect(writeFollowUpAssignment(followUp)).rejects.toThrow('previous assignment ID');

  expect(existsSync(assignmentPath(followUpId))).toBe(false);
});

it('refuses a malformed follow-up', async () => {
  useAgentDirectory();
  const original = assignmentWithSessionInFolder();

  await writeAssignment(original);

  const followUp = { ...followUpFor(original, original.session.file), task: '' };

  await expect(writeFollowUpAssignment(followUp)).rejects.toThrow('Malformed assignment');

  expect(existsSync(assignmentPath(followUpId))).toBe(false);
});

const question = {
  questionId: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  text: 'Which config file wins?',
  askedAt: 1_700_000_000_500,
};

it('saves a question into the assignment and reads it back', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();

  await writeAssignment(assignment);
  await saveQuestion(assignmentPath(assignment.assignmentId), question);

  expect((await readAssignment(assignmentPath(assignment.assignmentId)))?.questions).toEqual([
    question,
  ]);
});

it('keeps earlier questions and the report when it saves another question', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();
  const later = { ...question, questionId: '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a' };
  const report = { outcome: 'success' as const, summary: 'Found it.', evidence: [] };

  await writeAssignment(assignment);
  await saveQuestion(assignmentPath(assignment.assignmentId), question);
  await saveReport(assignmentPath(assignment.assignmentId), report);
  await saveQuestion(assignmentPath(assignment.assignmentId), later);

  const saved = await readAssignment(assignmentPath(assignment.assignmentId));

  expect(saved?.questions).toEqual([question, later]);
  expect(saved?.report).toEqual(report);
});

it('refuses an invalid question and keeps the saved file', async () => {
  useAgentDirectory();
  const assignment = assignmentWithSessionInFolder();

  await writeAssignment(assignment);

  await expect(
    saveQuestion(assignmentPath(assignment.assignmentId), { ...question, text: '' }),
  ).rejects.toThrow('Malformed question');

  expect((await readAssignment(assignmentPath(assignment.assignmentId)))?.questions).toEqual([]);
});

it('refuses to save a question for a missing assignment and creates no file', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-assignment-');
  const path = join(directory, 'assignment.json');

  await expect(saveQuestion(path, question)).rejects.toThrow('Missing assignment');

  expect(existsSync(path)).toBe(false);
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
