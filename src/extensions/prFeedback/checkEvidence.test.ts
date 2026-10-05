import { expect, it } from 'vitest';

import { checkListEvidence, failedLogEvidence, isFailing, jobOf } from './checkEvidence.js';
import type { CheckItem, CheckListValidation, CommandResult } from './checkEvidence.js';

const repository = { host: 'github.com', owner: 'sQVe', name: 'tau' };

const listCommand =
  'gh pr checks 7 --repo github.com/sQVe/tau --json name,bucket,link,workflow,state';

const logCommand = 'gh run view 11 --repo github.com/sQVe/tau --job 21 --log-failed';

const failingCheck: CheckItem = {
  name: 'test',
  workflow: 'CI',
  bucket: 'fail',
  state: 'FAILURE',
  link: 'https://github.com/sQVe/tau/actions/runs/11/job/21',
};

const result = (command: string, overrides: Partial<CommandResult> = {}): CommandResult => ({
  command,
  code: 0,
  killed: false,
  stdout: '',
  stderr: '',
  ...overrides,
});

const validCheckList: CheckListValidation = (value) =>
  Array.isArray(value)
    ? { checks: value as CheckItem[] }
    : { problem: 'printed unexpected output' };

const listOutput = JSON.stringify([failingCheck]);

it.each([
  { bucket: 'pass', failing: false },
  { bucket: 'pending', failing: false },
  { bucket: 'skipping', failing: false },
  { bucket: 'fail', failing: true },
  { bucket: 'cancel', failing: true },
] as const)('treats bucket $bucket as failing: $failing', ({ bucket, failing }) => {
  expect(isFailing({ ...failingCheck, bucket })).toBe(failing);
});

it.each([
  {
    link: 'https://github.com/sQVe/tau/actions/runs/11/job/21',
    job: { run: '11', job: '21' },
  },
  {
    link: 'https://github.com/sqve/TAU/actions/runs/11/job/21',
    job: { run: '11', job: '21' },
  },
  { link: 'https://github.com/other/tau/actions/runs/11/job/21', job: undefined },
  { link: 'https://ghe.example.com/sQVe/tau/actions/runs/11/job/21', job: undefined },
  { link: 'https://github.com/sQVe/tau/actions/runs/11', job: undefined },
  { link: 'https://github.com/sQVe/tau/actions/runs/11/job/21/attempts/2', job: undefined },
  { link: 'https://buildkite.com/sqve/tau/builds/9', job: undefined },
  { link: '', job: undefined },
])('reads job $job from link "$link"', ({ link, job }) => {
  expect(jobOf(repository, link)).toEqual(job);
});

it.each([
  {
    name: 'exit 0',
    command: result(listCommand, { stdout: listOutput }),
    evidence: { checks: [failingCheck] },
  },
  {
    name: 'exit 1, a failing check',
    command: result(listCommand, { code: 1, stdout: listOutput }),
    evidence: { checks: [failingCheck] },
  },
  {
    name: 'exit 8, a pending check',
    command: result(listCommand, { code: 8, stdout: listOutput }),
    evidence: { checks: [failingCheck] },
  },
  {
    name: 'exit 4 with valid JSON',
    command: result(listCommand, { code: 4, stdout: listOutput, stderr: 'auth required\n' }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 4,
        stderr: 'auth required',
        reason: `${listCommand} exited with code 4.`,
      },
    },
  },
  {
    name: 'a stopped command with valid JSON',
    command: result(listCommand, { killed: true, stdout: listOutput }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 0,
        stderr: '',
        reason: `${listCommand} was stopped.`,
      },
    },
  },
  {
    name: 'no output',
    command: result(listCommand, { code: 1, stdout: '\n', stderr: 'HTTP 502' }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 1,
        stderr: 'HTTP 502',
        reason: `${listCommand} printed no output`,
      },
    },
  },
  {
    name: 'output that is not JSON',
    command: result(listCommand, { code: 1, stdout: 'x'.repeat(300) }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 1,
        stderr: '',
        reason: `${listCommand} printed output that is not JSON: ${'x'.repeat(200)}`,
      },
    },
  },
  {
    name: 'JSON the validation refuses',
    command: result(listCommand, { stdout: '{}' }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 0,
        stderr: '',
        reason: `${listCommand} printed unexpected output`,
      },
    },
  },
  {
    name: 'an empty list',
    command: result(listCommand, { stdout: '[]' }),
    evidence: {
      gap: {
        check: null,
        command: listCommand,
        code: 0,
        stderr: '',
        reason: 'The pull request has no checks.',
      },
    },
  },
])('decides the check list from $name', ({ command, evidence }) => {
  expect(checkListEvidence(command, validCheckList)).toEqual(evidence);
});

const logLines = (count: number, width = 0) =>
  Array.from({ length: count }, (_, index) => String(index + 1).padStart(width, 'x'));

const longLastLine = `${'x'.repeat(100_000)}end`;

it.each([
  {
    name: 'a short log with trailing newlines',
    log: 'Error: boom\n\n',
    excerpt: { excerpt: 'Error: boom', omittedLines: 0 },
  },
  {
    name: 'a log past 200 lines',
    log: `${logLines(5000).join('\n')}\n`,
    excerpt: { excerpt: logLines(5000).slice(-200).join('\n'), omittedLines: 4800 },
  },
  // 20 lines of 999 characters and their 19 line breaks fill 19999 characters.
  {
    name: 'a log past 20000 characters',
    log: logLines(100, 999).join('\n'),
    excerpt: { excerpt: logLines(100, 999).slice(-20).join('\n'), omittedLines: 80 },
  },
  {
    name: 'a last line past 20000 characters',
    log: `first\n${longLastLine}`,
    excerpt: { excerpt: longLastLine.slice(-20_000), omittedLines: 1 },
  },
])('keeps a bounded excerpt of $name', ({ log, excerpt }) => {
  expect(failedLogEvidence(failingCheck, result(logCommand, { stdout: log }))).toEqual({
    log: excerpt,
  });
});

it.each([
  {
    name: 'a failing command',
    command: result(logCommand, { code: 1, stderr: 'HTTP 404: Not Found\n' }),
    gap: { code: 1, stderr: 'HTTP 404: Not Found', reason: `${logCommand} failed.` },
  },
  {
    name: 'a stopped command that printed a log',
    command: result(logCommand, { killed: true, stdout: 'Error: boom\n' }),
    gap: { code: 0, stderr: '', reason: `${logCommand} was stopped.` },
  },
  {
    name: 'an empty log',
    command: result(logCommand, { stdout: '\n' }),
    gap: {
      code: 0,
      stderr: '',
      reason: 'The failed-step log is empty. A cancelled job may have none.',
    },
  },
])('returns a gap, not a log, for $name', ({ command, gap }) => {
  expect(failedLogEvidence(failingCheck, command)).toEqual({
    gap: { check: 'test', command: logCommand, ...gap },
  });
});
