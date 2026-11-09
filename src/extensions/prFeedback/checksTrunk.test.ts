import { describe, expect, it } from 'vitest';

import { fakePullRequest } from './fixtures/ghFake.js';
import type { FakeCheck, GhFake } from './fixtures/ghFake.js';
import { setUp as setUpTool } from './fixtures/toolSetup.js';
import type { FakeTrunkRun } from './fixtures/trunkRunsFake.js';

const failingCheck = (name: string, job = 21): FakeCheck => ({
  name,
  workflow: 'CI',
  bucket: 'fail',
  state: 'FAILURE',
  link: `https://github.com/sQVe/tau/actions/runs/11/job/${job}`,
});

const trunkRun = (id: number, failedJob: string, branch = 'main'): FakeTrunkRun => ({
  id,
  branch,
  workflow: 'CI',
  conclusion: 'failure',
  headSha: `sha-${id}`,
  jobs: [
    { name: failedJob, conclusion: 'failure' },
    { name: 'build', conclusion: 'success' },
  ],
});

const runUrl = (id: number) => `https://github.com/sQVe/tau/actions/runs/${id}`;

const setUp = async () => {
  const setup = await setUpTool();

  setup.fake.jobLogs = { '21': { log: 'boom' }, '22': { log: 'bang' } };

  return setup;
};

const callsOf = (fake: GhFake, subcommand: string) =>
  fake.calls
    .map((call) => call.commandArguments.join(' '))
    .filter((command) => command.startsWith(subcommand));

describe('checks trunk matches', () => {
  it('returns only the trunk runs where a job with the check name failed', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.trunkRuns = [trunkRun(31, 'test'), trunkRun(32, 'lint')];

    const result = await readChecks();

    expect(result.checks[0]?.trunkMatches).toEqual([{ url: runUrl(31), headSha: 'sha-31' }]);
    expect(result.gaps).toEqual([]);
  });

  it('ignores runs that did not fail and jobs that did not fail', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];

    fake.trunkRuns = [
      { ...trunkRun(31, 'test'), conclusion: 'success' },
      { ...trunkRun(32, 'lint'), jobs: [{ name: 'test', conclusion: 'cancelled' }] },
    ];

    const result = await readChecks();

    expect(result.checks[0]?.trunkMatches).toEqual([]);
    expect(callsOf(fake, 'run view 31')).toEqual([]);
  });

  it('reads the latest five runs of the base branch', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];

    fake.trunkRuns = Array.from({ length: 6 }, (_, index) =>
      trunkRun(31 + index, 'test', 'release'),
    );

    fake.pullRequest = { ...fakePullRequest(), baseRefName: 'release' };

    const result = await readChecks();

    expect(callsOf(fake, 'run list')).toEqual([
      'run list --repo github.com/sQVe/tau --branch release --workflow CI --all --limit 5 --json databaseId,conclusion,headSha,url',
    ]);

    expect(result.checks[0]?.trunkMatches).toHaveLength(5);
  });

  it('matches trunk runs of a workflow that was disabled after they ran', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.trunkRuns = [{ ...trunkRun(31, 'test'), workflowDisabled: true }];

    const result = await readChecks();

    expect(result.checks[0]?.trunkMatches).toEqual([{ url: runUrl(31), headSha: 'sha-31' }]);
  });

  it('uses the trunk parameter over the base branch', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.trunkRuns = [trunkRun(31, 'test', 'main'), trunkRun(32, 'test', 'stack-trunk')];

    const result = await readChecks({ trunk: 'stack-trunk' });

    expect(result.checks[0]?.trunkMatches).toEqual([{ url: runUrl(32), headSha: 'sha-32' }]);
  });

  it('turns a run list that Pi stopped after it printed into a gap on the check', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.trunkRuns = [trunkRun(31, 'test')];
    fake.trunkRunsKilled = true;

    const result = await readChecks();
    const command = `gh ${callsOf(fake, 'run list')[0]}`;
    const gap = { check: 'test', command, code: 0, stderr: '', reason: `${command} was stopped.` };

    expect(result.checks[0]).toMatchObject({ trunkMatches: [], trunkGaps: [gap] });
    expect(result.gaps).toEqual([gap]);
  });

  it('quotes a workflow name with a space in the gap command of a failed run list', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [{ ...failingCheck('test'), workflow: 'CI Tests' }];
    fake.failCommand('run list');

    const result = await readChecks();

    expect(result.gaps).toEqual([
      expect.objectContaining({
        check: 'test',
        command:
          "gh run list --repo github.com/sQVe/tau --branch main --workflow 'CI Tests' --all --limit 5 --json databaseId,conclusion,headSha,url",
      }),
    ]);
  });

  it('turns a failed run list into a gap on the check', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.failCommand('run list', 'HTTP 502: Bad Gateway');

    const result = await readChecks();
    const command = `gh ${callsOf(fake, 'run list')[0]}`;

    const gap = {
      check: 'test',
      command,
      code: 1,
      stderr: 'HTTP 502: Bad Gateway',
      reason: `${command} failed.`,
    };

    expect(result.checks[0]).toMatchObject({
      log: { excerpt: 'boom' },
      trunkMatches: [],
      trunkGaps: [gap],
    });

    expect(result.gaps).toEqual([gap]);
  });

  it('turns malformed run jobs into a gap and keeps the log gap too', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test')];
    fake.jobLogs = {};
    fake.trunkRuns = [trunkRun(31, 'test')];
    fake.overrideOutput('run jobs', '{"jobs": "none"}');

    const result = await readChecks();

    expect(result.checks[0]?.trunkMatches).toEqual([]);

    expect(result.gaps).toEqual([
      expect.objectContaining({
        check: 'test',
        reason: expect.stringContaining('--log-failed') as unknown,
      }),
      expect.objectContaining({
        check: 'test',
        command: 'gh run view 31 --repo github.com/sQVe/tau --json jobs',
        reason: expect.stringContaining('printed unexpected output') as unknown,
      }),
    ]);
  });

  it('reads each workflow and each trunk run once, failed reads included', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [failingCheck('test'), failingCheck('lint', 22)];
    fake.trunkRuns = [trunkRun(31, 'test')];
    fake.failCommand('run jobs');

    const result = await readChecks();

    expect(callsOf(fake, 'run list')).toHaveLength(1);
    expect(callsOf(fake, 'run view 31')).toHaveLength(1);
    expect(result.gaps.map((gap) => gap.check)).toEqual(['test', 'lint']);
  });

  it('reads no trunk runs for a check that is not a GitHub Actions job', async () => {
    const { fake, readChecks } = await setUp();

    fake.checks = [{ ...failingCheck('deploy'), link: 'https://ci.example.com/build/1' }];

    const result = await readChecks();

    expect(callsOf(fake, 'run list')).toEqual([]);
    expect(result.checks[0]).not.toHaveProperty('trunkMatches');
  });
});
