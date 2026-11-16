import { expect, it } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.ts';
import type { Exec } from '../command.js';
import { pullRequestListArguments, readMergedPullRequests, runOutcome } from './github.js';

type ExecResult = Awaited<ReturnType<Exec>>;

const runtimeReturning = (result: ExecResult) => ({
  exec: (() => Promise.resolve(result)) as Exec,
  cwd: process.cwd(),
});

it('returns the exit code and output of a gh run that fails', async () => {
  const runtime = runtimeReturning({
    code: 2,
    killed: false,
    truncated: false,
    stdout: 'out',
    stderr: 'err',
  });

  expect(await runOutcome(runtime, ['pr', 'view'])).toEqual({
    exitCode: 2,
    cancelled: false,
    stdout: 'out',
    stderr: 'err',
  });
});

it('marks a killed gh run as cancelled', async () => {
  const runtime = runtimeReturning({
    code: 143,
    killed: true,
    truncated: false,
    stdout: '',
    stderr: '',
  });

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

const mergedRepository = { host: 'github.com', owner: 'sQVe', name: 'tau' };

const mergedListing = [
  {
    number: 7,
    url: 'https://github.com/sQVe/tau/pull/7',
    headRefName: 'feature',
    createdAt: '2026-11-01T10:00:00Z',
    mergedAt: '2026-11-02T10:00:00Z',
  },
];

const mergedFake = () =>
  createExecFake<'merged'>({
    keyOf: () => 'merged',
    handlerFor: () => () => succeededResult(JSON.stringify(mergedListing)),
  });

it('reads merged pull requests', async () => {
  const fake = mergedFake();
  const runtime = { exec: fake.exec, cwd: process.cwd() };

  const listed = await readMergedPullRequests(runtime, mergedRepository, '2026-11-01');

  expect(fake.calls[0]?.commandArguments).toEqual([
    'pr',
    'list',
    '--repo',
    'github.com/sQVe/tau',
    '--state',
    'merged',
    '--search',
    'merged:>=2026-11-01',
    '--limit',
    '1000',
    '--json',
    'number,url,headRefName,createdAt,mergedAt',
  ]);

  expect(listed).toEqual(mergedListing);
});

it('refuses a merged list at the limit', async () => {
  const fake = mergedFake();
  const runtime = { exec: fake.exec, cwd: process.cwd() };
  const rows = Array.from({ length: 1000 }, () => mergedListing[0]);

  fake.overrideOutput('merged', JSON.stringify(rows));

  await expect(readMergedPullRequests(runtime, mergedRepository, '2026-11-01')).rejects.toThrow(
    /printed 1000 pull requests, the limit, so the list may be incomplete\./u,
  );
});

it('throws when gh fails', async () => {
  const fake = mergedFake();
  const runtime = { exec: fake.exec, cwd: process.cwd() };

  fake.failCommand('merged', 'boom');

  await expect(readMergedPullRequests(runtime, mergedRepository, '2026-11-01')).rejects.toThrow(
    /failed: boom/u,
  );
});
