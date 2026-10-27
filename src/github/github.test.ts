import { expect, it } from 'vitest';

import type { Exec } from '../command.js';
import { pullRequestListArguments, runOutcome } from './github.js';

type ExecResult = Awaited<ReturnType<Exec>>;

const runtimeReturning = (result: ExecResult) => ({
  exec: (() => Promise.resolve(result)) as Exec,
  cwd: process.cwd(),
});

it('returns the exit code and output of a gh run that fails', async () => {
  const runtime = runtimeReturning({ code: 2, killed: false, stdout: 'out', stderr: 'err' });

  expect(await runOutcome(runtime, ['pr', 'view'])).toEqual({
    exitCode: 2,
    cancelled: false,
    stdout: 'out',
    stderr: 'err',
  });
});

it('marks a killed gh run as cancelled', async () => {
  const runtime = runtimeReturning({ code: 143, killed: true, stdout: '', stderr: '' });

  expect(await runOutcome(runtime, ['pr', 'view'])).toMatchObject({ cancelled: true });
});

it('builds a gh pr list that asks for the guarded number of pull requests', () => {
  const commandArguments = pullRequestListArguments({
    repository: 'github.com/sQVe/tau',
    filter: ['--head', 'feature'],
    state: 'open',
    fields: 'number,url',
  });

  expect(commandArguments).toEqual([
    'pr',
    'list',
    '--repo',
    'github.com/sQVe/tau',
    '--head',
    'feature',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,url',
  ]);
});
