import { readdir } from 'node:fs/promises';

import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakeCheck, GhFake } from './fixtures/ghFake.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

interface ChecksResult {
  pr: number;
  checks: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
}

const jobLink = (run: number, job: number, host = 'github.com') =>
  `https://${host}/sQVe/tau/actions/runs/${run}/job/${job}`;

const check = (overrides: Partial<FakeCheck> & { name: string }): FakeCheck => ({
  workflow: 'CI',
  bucket: 'pass',
  state: 'SUCCESS',
  link: jobLink(11, 21),
  ...overrides,
});

const failingCheck = check({ name: 'test', bucket: 'fail', state: 'FAILURE' });

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();

  const readChecks = async (input: Partial<PrFeedbackInput> = {}) => {
    const tool = createPrFeedbackTool(fake.exec);

    const result = await tool.execute(
      'call',
      { action: 'checks', repository: 'github.com/sQVe/tau', pr: 7, head: 'abc123', ...input },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details as unknown as ChecksResult;
  };

  return { root, fake, readChecks };
};

const logLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`);

const checksCommand =
  'gh pr checks 7 --repo github.com/sQVe/tau --json name,bucket,link,workflow,state';

const runViewCalls = (fake: GhFake) =>
  fake.calls.filter((call) => call.commandArguments.slice(0, 2).join(' ') === 'run view');

describe('checks', () => {
  it('returns a bounded log excerpt for a failing check while gh pr checks exits 1', async () => {
    const { fake, readChecks } = await setUp();
    const lines = logLines(5000);

    fake.checks = [failingCheck];
    fake.checksExitCode = 1;
    fake.jobLogs = { '21': { log: `${lines.join('\n')}\n` } };

    const result = await readChecks();

    expect(result.checks).toEqual([
      {
        name: 'test',
        workflow: 'CI',
        bucket: 'fail',
        state: 'FAILURE',
        link: jobLink(11, 21),
        log: { excerpt: lines.slice(-200).join('\n'), omittedLines: 4800 },
      },
    ]);

    expect(result.gaps).toEqual([]);
  });

  it.each([0, 1, 8])(
    'returns passing, pending, and failing checks while gh pr checks exits %i',
    async (exitCode) => {
      const { root, fake, readChecks } = await setUp();

      fake.checks = [
        check({ name: 'lint' }),
        check({ name: 'build', bucket: 'pending', state: 'IN_PROGRESS', link: jobLink(12, 22) }),
        check({ name: 'docs', bucket: 'skipping', state: 'SKIPPED', link: jobLink(13, 23) }),
        check({ name: 'test', bucket: 'fail', state: 'FAILURE', link: jobLink(14, 24) }),
      ];

      fake.checksExitCode = exitCode;
      fake.jobLogs = { '24': { log: 'test\tRun tests\tError: expected 1\n' } };

      expect(await readChecks()).toEqual({
        pr: 7,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: jobLink(11, 21) },
          {
            name: 'build',
            workflow: 'CI',
            bucket: 'pending',
            state: 'IN_PROGRESS',
            link: jobLink(12, 22),
          },
          {
            name: 'docs',
            workflow: 'CI',
            bucket: 'skipping',
            state: 'SKIPPED',
            link: jobLink(13, 23),
          },
          {
            name: 'test',
            workflow: 'CI',
            bucket: 'fail',
            state: 'FAILURE',
            link: jobLink(14, 24),
            log: { excerpt: 'test\tRun tests\tError: expected 1', omittedLines: 0 },
          },
        ],
        gaps: [],
      });

      expect(runViewCalls(fake).map((call) => call.commandArguments)).toEqual([
        ['run', 'view', '14', '--repo', 'github.com/sQVe/tau', '--job', '24', '--log-failed'],
      ]);

      expect(await readdir(root)).not.toContain('.tau');
    },
  );

  it('reads failed logs one at a time in check order', async () => {
    const { fake, readChecks } = await setUp();
    const events: string[] = [];
    const exec = fake.exec;

    fake.exec = async (command, commandArguments, options) => {
      const job = commandArguments.at(-2) ?? '';
      const isRunView = commandArguments.slice(0, 2).join(' ') === 'run view';

      if (isRunView) {
        events.push(`start ${job}`);
      }

      const result = await exec(command, commandArguments, options);

      if (isRunView) {
        events.push(`end ${job}`);
      }

      return result;
    };

    fake.checks = [
      check({ name: 'test', bucket: 'fail', state: 'FAILURE', link: jobLink(11, 21) }),
      check({ name: 'lint', bucket: 'cancel', state: 'CANCELLED', link: jobLink(12, 22) }),
      check({ name: 'build', bucket: 'fail', state: 'FAILURE', link: jobLink(13, 23) }),
    ];

    fake.jobLogs = {
      '21': { log: 'Error: test\n' },
      '22': { log: 'Error: lint\n' },
      '23': { log: 'Error: build\n' },
    };

    const result = await readChecks();

    expect(result.gaps).toEqual([]);
    expect(events).toEqual(['start 21', 'end 21', 'start 22', 'end 22', 'start 23', 'end 23']);
  });
});

describe('checks gaps', () => {
  it.each([
    {
      name: 'an empty check list',
      arrange: (fake: GhFake) => {
        fake.checks = [];
      },
      code: 0,
      stderr: '',
      reason: 'The pull request has no checks.',
    },
    {
      name: 'output that is not JSON',
      arrange: (fake: GhFake) => {
        fake.overrideOutput('pr checks', 'HTTP 401: Unauthorized');
        fake.checksExitCode = 1;
      },
      code: 1,
      stderr: '',
      reason: `${checksCommand} printed output that is not JSON: HTTP 401: Unauthorized`,
    },
    {
      name: 'JSON of another shape',
      arrange: (fake: GhFake) => {
        fake.overrideOutput('pr checks', JSON.stringify([{ name: 'lint', state: 'SUCCESS' }]));
      },
      code: 0,
      stderr: '',
      reason: `${checksCommand} printed unexpected output: /0 must have required properties`,
    },
    {
      name: 'a check with an unknown bucket',
      arrange: (fake: GhFake) => {
        fake.checks = [check({ name: 'test', bucket: '', state: 'FAILURE' })];
        fake.checksExitCode = 1;
      },
      code: 1,
      stderr: '',
      reason: `${checksCommand} printed unexpected output: /0/bucket`,
    },
    {
      name: 'a failing gh pr checks that prints nothing',
      arrange: (fake: GhFake) => {
        fake.failCommand('pr checks');
      },
      code: 1,
      stderr: 'HTTP 502: Bad Gateway',
      reason: `${checksCommand} printed no output`,
    },
  ])('returns one gap and no checks on $name', async ({ arrange, code, stderr, reason }) => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck];
    arrange(fake);

    const result = await readChecks();

    expect(result.checks).toEqual([]);

    expect(result.gaps).toEqual([
      {
        check: null,
        command: checksCommand,
        code,
        stderr,
        reason: expect.stringContaining(reason) as unknown,
      },
    ]);

    expect(runViewCalls(fake)).toEqual([]);
  });

  it('returns one gap and no checks when gh pr checks prints valid JSON but exits 4', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck];
    fake.checksExitCode = 4;

    expect(await readChecks()).toEqual({
      pr: 7,
      checks: [],
      gaps: [
        {
          check: null,
          command: checksCommand,
          code: 4,
          stderr: '',
          reason: `${checksCommand} exited with code 4.`,
        },
      ],
    });

    expect(runViewCalls(fake)).toEqual([]);
  });

  it.each([
    { bucket: 'fail', link: 'https://buildkite.com/sqve/tau/builds/9' },
    { bucket: 'cancel', link: '' },
    { bucket: 'fail', link: 'https://github.com/other/tau/actions/runs/11/job/21' },
  ])('returns a gap for a $bucket check with link "$link"', async ({ bucket, link }) => {
    const { fake, readChecks } = await setUp();

    fake.checks = [check({ name: 'test', bucket, state: 'FAILURE', link })];

    const result = await readChecks();

    const gap = {
      check: 'test',
      command: null,
      code: null,
      stderr: null,
      reason: expect.stringContaining(
        'is not a GitHub Actions job of github.com/sQVe/tau',
      ) as unknown,
    };

    expect(result.checks).toEqual([
      { name: 'test', workflow: 'CI', bucket, state: 'FAILURE', link, gap },
    ]);

    expect(result.gaps).toEqual([gap]);
    expect(runViewCalls(fake)).toEqual([]);
  });

  it.each([
    {
      name: 'an empty log',
      jobLog: { log: '\n' },
      code: 0,
      stderr: '',
      reason: 'The failed-step log is empty.',
    },
    {
      name: 'a failing gh run view',
      jobLog: { code: 1, stderr: 'HTTP 404: Not Found' },
      code: 1,
      stderr: 'HTTP 404: Not Found',
      reason: 'gh run view 11 --repo github.com/sQVe/tau --job 21 --log-failed failed.',
    },
  ])('returns a gap, not a log, for $name', async ({ jobLog, code, stderr, reason }) => {
    const { fake, readChecks } = await setUp();

    fake.checks = [check({ name: 'lint' }), failingCheck];
    fake.jobLogs = { '21': jobLog };

    const result = await readChecks();

    const gap = {
      check: 'test',
      command: 'gh run view 11 --repo github.com/sQVe/tau --job 21 --log-failed',
      code,
      stderr,
      reason: expect.stringContaining(reason) as unknown,
    };

    expect(result.checks).toEqual([
      { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: jobLink(11, 21) },
      {
        name: 'test',
        workflow: 'CI',
        bucket: 'fail',
        state: 'FAILURE',
        link: jobLink(11, 21),
        gap,
      },
    ]);

    expect(result.gaps).toEqual([gap]);
  });
});

describe('checks killed commands', () => {
  it('returns one gap and no checks when Pi stops gh pr checks after it printed JSON', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [check({ name: 'lint' })];
    fake.checksKilled = true;

    expect(await readChecks()).toEqual({
      pr: 7,
      checks: [],
      gaps: [
        {
          check: null,
          command: checksCommand,
          code: 0,
          stderr: '',
          reason: `${checksCommand} was stopped.`,
        },
      ],
    });
  });

  it('returns a gap, not a log, when Pi stops gh run view after it printed a log', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck];
    fake.jobLogs = { '21': { log: 'Error: boom\n', killed: true } };

    const command = 'gh run view 11 --repo github.com/sQVe/tau --job 21 --log-failed';
    const gap = { check: 'test', command, code: 0, stderr: '', reason: `${command} was stopped.` };

    expect(await readChecks()).toEqual({
      pr: 7,
      checks: [{ ...failingCheck, gap }],
      gaps: [gap],
    });
  });
});

describe('checks head', () => {
  it.each([
    { name: 'before', nextHeads: ['def456'] },
    { name: 'during', nextHeads: ['abc123', 'def456'] },
  ])('refuses and reads no log when the head moves $name gh pr checks', async ({ nextHeads }) => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck];
    fake.checksExitCode = 1;
    fake.jobLogs = { '21': { log: 'Error: boom\n' } };
    fake.nextHeads = nextHeads;

    await expect(readChecks()).rejects.toThrow(
      'The pull request head is def456, not abc123. The checks may belong to another head.',
    );

    expect(runViewCalls(fake)).toEqual([]);
  });

  it('reads the head before and after the check list', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [check({ name: 'lint' })];

    const result = await readChecks();

    expect(result.checks).toEqual([
      { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: jobLink(11, 21) },
    ]);

    expect(fake.calls.map((call) => call.commandArguments.slice(0, 2).join(' '))).toEqual([
      'pr view',
      'pr checks',
      'pr view',
    ]);
  });
});

describe('checks input', () => {
  it('passes a non-github.com host in --repo to every gh call', async () => {
    const { fake, readChecks } = await setUp();
    const link = jobLink(11, 21, 'ghe.example.com');

    fake.checks = [check({ name: 'test', bucket: 'fail', state: 'FAILURE', link })];
    fake.jobLogs = { '21': { log: 'Error: boom\n' } };

    const result = await readChecks({ repository: 'ghe.example.com/sQVe/tau' });

    expect(result.gaps).toEqual([]);
    expect(result.checks[0]?.log).toEqual({ excerpt: 'Error: boom', omittedLines: 0 });

    const view = [
      'pr',
      'view',
      '7',
      '--repo',
      'ghe.example.com/sQVe/tau',
      '--json',
      'number,url,state,author,headRefOid',
    ];

    expect(fake.calls.map((call) => call.commandArguments)).toEqual([
      view,
      [
        'pr',
        'checks',
        '7',
        '--repo',
        'ghe.example.com/sQVe/tau',
        '--json',
        'name,bucket,link,workflow,state',
      ],
      view,
      ['run', 'view', '11', '--repo', 'ghe.example.com/sQVe/tau', '--job', '21', '--log-failed'],
    ]);
  });

  it.each([
    { repository: undefined, pr: 7, error: 'checks needs repository.' },
    { repository: 'sQVe/tau', pr: 7, error: 'repository must be <host>/<owner>/<name>' },
    { repository: 'github.com/sQVe/tau', pr: undefined, error: 'checks needs pr.' },
    { repository: 'github.com/sQVe/tau', pr: 0, error: 'pr must be a pull request number' },
    { repository: 'github.com/sQVe/tau', pr: 7, head: undefined, error: 'checks needs head.' },
  ])('rejects repository $repository with pr $pr and head $head', async (row) => {
    const { repository, pr, error } = row;
    const head = 'head' in row ? row.head : 'abc123';
    const { fake } = await setUp();
    const tool = createPrFeedbackTool(fake.exec);
    const root = await createTemporaryRepository(onTestFinished);

    const input = {
      action: 'checks' as const,
      ...(repository === undefined ? {} : { repository }),
      ...(pr === undefined ? {} : { pr }),
      ...(head === undefined ? {} : { head }),
    };

    await expect(
      tool.execute('call', input, undefined, undefined, noUiContext(root)),
    ).rejects.toThrow(error);

    expect(fake.calls).toEqual([]);
  });
});
