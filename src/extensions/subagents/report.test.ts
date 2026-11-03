import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { assignmentDirectory, readAssignment, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { reportToParent } from './report.js';
import type { ReportInput, ReportTarget } from './report.js';

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const sessionId = '11111111-1111-1111-1111-111111111111';

const setup = () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-report-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';

  const assignment: Assignment = {
    version: 1,
    assignmentId,
    task: 'Do the thing.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: {
      id: sessionId,
      file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`),
    },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal,
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    report: null,
  };

  const fake = createHcFake();

  fake.reply('label', JSON.stringify({ address: workerTerminal, state: 'live' }));
  fake.reply('send', JSON.stringify({ turn: 1 }));

  const target: ReportTarget = {
    hc: { exec: fake.exec, connect: fake.connect, cwd: directory },
    terminal: workerTerminal,
    parent: parentTerminal,
    assignmentPath: join(assignmentDirectory(assignmentId), 'assignment.json'),
    assignment,
    refusal: { incompleteRefused: false, reminderSent: false, remindAfterRefusal: false },
  };

  const report: ReportInput = {
    outcome: 'success',
    summary: 'Done.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: ['src/config.ts'],
  };

  return { assignment, fake, report, target };
};

const reportCommandCalls = (fake: ReturnType<typeof setup>['fake']) =>
  fake.calls.map((call) => call.commandArguments[0]);

it('saves the report, labels it, then notes the parent', async () => {
  const { fake, report, target } = setup();

  await writeAssignment(target.assignment);
  const result = await reportToParent(target, report);

  expect(reportCommandCalls(fake)).toEqual(['label', 'send']);

  const labelCall = fake.calls.find((call) => call.commandArguments[0] === 'label');
  const sendCall = fake.calls.find((call) => call.commandArguments[0] === 'send');

  expect(labelCall?.commandArguments).toContain(`tau.report=${target.assignmentPath}`);
  expect(sendCall?.commandArguments.at(-1)).toBe(`[tau-report] ${target.assignmentPath}`);

  const saved = await readAssignment(target.assignmentPath);

  expect(saved?.report).toEqual({
    outcome: 'success',
    summary: report.summary,
    evidence: report.evidence,
  });

  const content = result.content[0];

  expect(content?.type === 'text' ? content.text : '').toBe(
    'Handover durably accepted. Parent notified. Stop working.',
  );
});

it('keeps the saved report and names the failed note when hc send fails', async () => {
  const { fake, report, target } = setup();

  fake.fail('send', 'send refused', 1);

  await writeAssignment(target.assignment);

  const result = await reportToParent(target, report);
  const content = result.content[0];

  expect(content?.type).toBe('text');
  expect(content?.type === 'text' ? content.text : '').toContain('Report note failed');
  expect(result.terminate).toBe(true);

  expect((await readAssignment(target.assignmentPath))?.report?.outcome).toBe('success');
  expect(reportCommandCalls(fake)).toEqual(['label', 'send']);
});

it('keeps the saved report, names the failed label, and still sends the note', async () => {
  const { fake, report, target } = setup();

  fake.fail('label', 'label refused', 1);

  await writeAssignment(target.assignment);

  const result = await reportToParent(target, report);
  const content = result.content[0];

  expect(content?.type).toBe('text');
  expect(content?.type === 'text' ? content.text : '').toContain('Report label failed');
  expect(reportCommandCalls(fake)).toEqual(['label', 'send']);

  expect((await readAssignment(target.assignmentPath))?.report?.outcome).toBe('success');
});

it('names both failed steps when the label and the note fail', async () => {
  const { fake, report, target } = setup();

  fake.fail('label', 'label refused', 1);
  fake.fail('send', 'send refused', 1);

  await writeAssignment(target.assignment);

  const result = await reportToParent(target, report);
  const content = result.content[0];
  const text = content?.type === 'text' ? content.text : '';

  expect(text).toContain('Report label failed');
  expect(text).toContain('Report note failed');
});

it('accepts an incomplete time blocker only near the deadline', async () => {
  const { fake, target } = setup();

  await writeAssignment(target.assignment);

  const incomplete: ReportInput = {
    outcome: 'incomplete',
    summary: 'Stopped.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: [],
    blocker: 'No time left.',
    blockerKind: 'time',
  };

  target.assignment.deadline = target.assignment.createdAt + 3_600_000;

  await expect(reportToParent(target, incomplete)).rejects.toThrow('Report refused');

  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
  expect(fake.calls).toEqual([]);

  target.assignment.deadline = target.assignment.createdAt + 30_000;

  await reportToParent(target, incomplete);

  expect((await readAssignment(target.assignmentPath))?.report?.outcome).toBe('incomplete');
  expect(reportCommandCalls(fake)).toEqual(['label', 'send']);
});

it('writes nothing and sends nothing for an invalid report', async () => {
  const { fake, target } = setup();

  await writeAssignment(target.assignment);

  await expect(
    reportToParent(target, { outcome: 'success', summary: 'No sections.', evidence: [] }),
  ).rejects.toThrow('missing the');

  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
  expect(fake.calls).toEqual([]);
  expect(target.refusal.remindAfterRefusal).toBe(true);
});
