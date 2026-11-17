import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { initializeRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { saveCheckRecord } from '../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../checkRecord/identity.js';
import { assignmentDirectory, readAssignment, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { reportToParent } from './report.js';
import type { ReportInput, ReportTarget } from './report.js';

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const sessionId = '11111111-1111-1111-1111-111111111111';
const checkArgv = ['pnpm', 'check'];

const setup = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-report-');

  await initializeRepository(directory);
  await writeFile(join(directory, '.gitignore'), '.tau/\n');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';

  const assignment: Assignment = {
    version: 3,
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
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  };

  const fake = createHcFake();

  fake.reply('label', JSON.stringify({ address: workerTerminal, state: 'live' }));

  const target: ReportTarget = {
    hc: { exec: fake.exec, connect: fake.connect, cwd: directory },
    terminal: workerTerminal,
    assignmentPath: join(assignmentDirectory(assignmentId), 'assignment.json'),
    assignment,
    refusal: { incompleteRefused: false, reminderSent: false, remindAfterRefusal: false },
  };

  const report: ReportInput = {
    outcome: 'success',
    summary: 'Done.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: ['src/config.ts'],
  };

  const deadlineWarning = { clears: 0, clear: () => undefined };

  deadlineWarning.clear = () => {
    deadlineWarning.clears += 1;
  };

  return { assignment, deadlineWarning, fake, report, target };
};

const checkFacts = (target: ReportTarget) => ({ root: target.assignment.cwd, argv: checkArgv });

const savePassingCheck = async (root: string): Promise<void> => {
  const identity = await readCheckIdentity(root, checkArgv);
  const directory = join(root, '.tau/checks');
  const logPath = join(directory, 'run.log');

  await mkdir(directory, { recursive: true });
  await writeFile(logPath, 'output');
  await saveCheckRecord(logPath, identity, true);
};

const writeCheckedAssignment = async (target: ReportTarget): Promise<void> => {
  await writeAssignment(target.assignment);
  await savePassingCheck(target.assignment.cwd);
};

const reportCommandCalls = (fake: Awaited<ReturnType<typeof setup>>['fake']) =>
  fake.calls.map((call) => call.commandArguments[0]);

it('saves the report then labels it for the manager', async () => {
  const { deadlineWarning, fake, report, target } = await setup();

  await writeCheckedAssignment(target);
  const result = await reportToParent(target, report, deadlineWarning, checkFacts(target));

  expect(reportCommandCalls(fake)).toEqual(['label']);

  const labelCall = fake.calls.find((call) => call.commandArguments[0] === 'label');

  expect(labelCall?.commandArguments).toContain(`tau.report=${target.assignmentPath}`);

  const saved = await readAssignment(target.assignmentPath);

  expect(saved?.report).toEqual({
    outcome: 'success',
    summary: report.summary,
    evidence: report.evidence,
  });

  const content = result.content[0];

  const reportText = content?.type === 'text' ? content.text : '';
  expect(reportText).toBe('Handover durably accepted. Report label set. Stop working.');
});

it('keeps the saved report and names the failed label', async () => {
  const { deadlineWarning, fake, report, target } = await setup();

  fake.fail('label', 'label refused', 1);

  await writeCheckedAssignment(target);

  const result = await reportToParent(target, report, deadlineWarning, checkFacts(target));
  const content = result.content[0];

  expect(content?.type).toBe('text');
  const reportText = content?.type === 'text' ? content.text : '';
  expect(reportText).toContain('Report label failed');
  expect(reportCommandCalls(fake)).toEqual(['label']);

  expect((await readAssignment(target.assignmentPath))?.report?.outcome).toBe('success');
});

it('accepts an incomplete time blocker only near the deadline', async () => {
  const { deadlineWarning, fake, target } = await setup();

  await writeCheckedAssignment(target);

  const incomplete: ReportInput = {
    outcome: 'incomplete',
    summary: 'Stopped.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: [],
    blocker: 'No time left.',
    blockerKind: 'time',
  };

  target.assignment.deadline = target.assignment.createdAt + 3_600_000;

  await expect(
    reportToParent(target, incomplete, deadlineWarning, checkFacts(target)),
  ).rejects.toThrow('Report refused');

  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
  expect(fake.calls).toEqual([]);

  target.assignment.deadline = target.assignment.createdAt + 30_000;

  await reportToParent(target, incomplete, deadlineWarning, checkFacts(target));

  expect((await readAssignment(target.assignmentPath))?.report?.outcome).toBe('incomplete');
  expect(reportCommandCalls(fake)).toEqual(['label']);
});

it('accepts an over-long summary and saves the full text to a file', async () => {
  const { deadlineWarning, report, target } = await setup();
  const details = `${'x'.repeat(99)}\n`.repeat(35);
  const summary = `${report.summary}\n\n${details}`;

  await writeCheckedAssignment(target);
  await reportToParent(target, { ...report, summary }, deadlineWarning, checkFacts(target));

  const summaryFile = join(dirname(target.assignmentPath), 'summary.md');
  const saved = await readAssignment(target.assignmentPath);

  expect(summary.length).toBeGreaterThan(3500);
  expect(await readFile(summaryFile, 'utf8')).toBe(summary);
  expect(saved?.report?.evidence).toEqual([...report.evidence, summaryFile]);
  expect(saved?.report?.summary.length).toBeLessThanOrEqual(3000);
  expect(saved?.report?.summary).toContain(summaryFile);
});

it('a success report without a passing record is refused', async () => {
  const { deadlineWarning, fake, report, target } = await setup();

  await writeAssignment(target.assignment);

  await expect(reportToParent(target, report, deadlineWarning, checkFacts(target))).rejects.toThrow(
    'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
  );

  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
  expect(fake.calls).toEqual([]);
});

it('writes nothing and labels nothing for an invalid report', async () => {
  const { deadlineWarning, fake, target } = await setup();

  await writeCheckedAssignment(target);

  await expect(
    reportToParent(
      target,
      { outcome: 'success', summary: 'No sections.', evidence: [] },
      deadlineWarning,
      checkFacts(target),
    ),
  ).rejects.toThrow('missing the');

  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
  expect(fake.calls).toEqual([]);
  expect(target.refusal.remindAfterRefusal).toBe(true);
});

it('refuses an over-long summary without the headings and saves no file', async () => {
  const { deadlineWarning, target } = await setup();

  await writeCheckedAssignment(target);

  await expect(
    reportToParent(
      target,
      { outcome: 'success', summary: 'x'.repeat(3500), evidence: [] },
      deadlineWarning,
      checkFacts(target),
    ),
  ).rejects.toThrow('missing the');

  expect(await readdir(dirname(target.assignmentPath))).not.toContain('summary.md');
  expect((await readAssignment(target.assignmentPath))?.report).toBeNull();
});

it('clears the deadline warning once the report is saved, even when the label fails', async () => {
  const { deadlineWarning, fake, report, target } = await setup();

  fake.fail('label', 'label refused', 1);

  await writeCheckedAssignment(target);
  await reportToParent(target, report, deadlineWarning, checkFacts(target));

  expect(deadlineWarning.clears).toBe(1);
});

it('keeps the deadline warning when the report is refused', async () => {
  const { deadlineWarning, target } = await setup();

  await writeCheckedAssignment(target);

  await expect(
    reportToParent(
      target,
      { outcome: 'success', summary: 'No sections.', evidence: [] },
      deadlineWarning,
      checkFacts(target),
    ),
  ).rejects.toThrow('missing the');

  expect(deadlineWarning.clears).toBe(0);
});
