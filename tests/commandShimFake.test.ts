import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { installCommandShim } from './commandShimFake.js';

const runGit = async (...commandArguments: string[]) => {
  try {
    const { stdout, stderr } = await promisify(execFile)('git', commandArguments);

    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };

    return { code, stdout, stderr };
  }
};

it('prints a canned answer and fails a call no rule matches', async () => {
  await installCommandShim('git', {
    otherCalls: 'fail',
    answers: [{ prefix: 'rev-parse HEAD', stdout: 'abc123\n' }],
  });

  const answered = await runGit('rev-parse', 'HEAD');
  const unmatched = await runGit('status');

  expect(answered).toEqual({ code: 0, stdout: 'abc123\n', stderr: '' });
  expect(unmatched).toEqual({ code: 128, stdout: '', stderr: 'fatal: unexpected status\n' });
});

it('uses an answer added after install, and the longest matching prefix wins', async () => {
  const shim = await installCommandShim('git', {
    otherCalls: 'fail',
    answers: [{ prefix: 'rev-parse', code: 1, stderr: 'short\n' }],
  });

  shim.answer({ prefix: 'rev-parse --verify', code: 2, stdout: "it's long\n" });

  expect(await runGit('rev-parse', '--verify', 'HEAD')).toEqual({
    code: 2,
    stdout: "it's long\n",
    stderr: '',
  });
});

it('replaces the answer for a prefix that already has one', async () => {
  const shim = await installCommandShim('git', {
    otherCalls: 'fail',
    answers: [{ prefix: 'remote', stdout: 'first\n' }],
  });

  shim.answer({ prefix: 'remote', stdout: 'second\n' });

  expect(await runGit('remote')).toEqual({ code: 0, stdout: 'second\n', stderr: '' });
});

it('runs an override with the real program in $real and acts after it', async () => {
  const real = await runGit('rev-parse', 'HEAD');

  await installCommandShim('git', {
    otherCalls: 'fail',
    overrides: [{ match: ' rev-parse ', script: '"$real" "$@"; echo after' }],
  });

  expect(await runGit('rev-parse', 'HEAD')).toEqual({
    code: 0,
    stdout: `${real.stdout}after\n`,
    stderr: '',
  });
});

it('runs an override in the process the caller started', async () => {
  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' status ', script: 'kill -9 $$' }],
  });

  await expect(promisify(execFile)('git', ['status'])).rejects.toMatchObject({
    signal: 'SIGKILL',
  });
});

it('runs the real program for a call no rule matches when other calls are real', async () => {
  const real = await runGit('rev-parse', 'HEAD');

  await installCommandShim('git', {
    otherCalls: 'real',
    answers: [{ prefix: 'status', stdout: 'canned\n' }],
  });

  expect(await runGit('rev-parse', 'HEAD')).toEqual(real);
});

const pathBeforeShim = process.env['PATH'];

it('puts the shim first on PATH during the test', async () => {
  await installCommandShim('git', { otherCalls: 'fail' });

  expect(process.env['PATH']).not.toBe(pathBeforeShim);
});

it('restores PATH after the test that installed the shim', () => {
  expect(process.env['PATH']).toBe(pathBeforeShim);
});
