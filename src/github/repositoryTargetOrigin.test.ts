import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../command.js';
import { processState } from '../process/process.js';
import { readOriginRepository } from './repositoryTarget.js';
import type { OriginRepository } from './repositoryTarget.js';

const sshAlias: Exec = (_command, commandArguments) =>
  Promise.resolve({
    code: 0,
    killed: false,
    stdout: commandArguments.includes('git@work') ? 'hostname github.com\n' : '',
    stderr: '',
  });

const originOf = async (url: string | undefined, exec: Exec = sshAlias) => {
  const directory = await createTemporaryRepository(onTestFinished);

  if (url !== undefined) {
    await promisify(execFile)('git', ['remote', 'add', 'origin', url], { cwd: directory });
  }

  return readOriginRepository({ exec, cwd: directory });
};

const named = (host: string): OriginRepository => ({
  status: 'named',
  repository: { host, owner: 'sQVe', name: 'tau' },
});

it.each<{ condition: string; url: string | undefined; origin: OriginRepository }>([
  { condition: 'no origin remote', url: undefined, origin: { status: 'missing' } },
  { condition: 'a local path', url: '/srv/tau.git', origin: { status: 'unnamed' } },
  {
    condition: 'a URL with a nested path',
    url: 'https://gitlab.com/a/b/c',
    origin: { status: 'unnamed' },
  },
  {
    condition: 'an HTTPS URL',
    url: 'https://github.com/sQVe/tau.git',
    origin: named('github.com'),
  },
  { condition: 'an SCP-like URL', url: 'git@gitlab.com:sQVe/tau', origin: named('gitlab.com') },
  { condition: 'an SSH Host alias', url: 'git@work:sQVe/tau.git', origin: named('github.com') },
])('reads origin for $condition', async ({ url, origin }) => {
  expect(await originOf(url)).toEqual(origin);
});

it('reads no origin outside a repository', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-no-repository-');

  expect(await readOriginRepository({ exec: sshAlias, cwd: directory })).toEqual({
    status: 'missing',
  });
});

it('stops origin lookup when its caller has cancelled', async () => {
  const directory = await createTemporaryRepository(onTestFinished);

  await promisify(execFile)('git', ['remote', 'add', 'origin', 'git@work:sQVe/tau.git'], {
    cwd: directory,
  });

  const controller = new AbortController();
  const reason = new Error('Origin lookup cancelled.');
  const calls: string[] = [];

  const exec: Exec = async (command, argumentsList, options) => {
    calls.push(command);

    return sshAlias(command, argumentsList, options);
  };

  controller.abort(reason);

  await expect(
    readOriginRepository({ exec, cwd: directory, signal: controller.signal }),
  ).rejects.toBe(reason);

  expect(calls).toEqual([]);
});

it('cancels the origin Git process before it can finish', async () => {
  const directory = await createTemporaryRepository(onTestFinished);
  const executable = join(directory, 'git');
  const startedPath = join(directory, 'started');
  const completedPath = join(directory, 'completed');
  const entered = Promise.withResolvers<number>();
  const controller = new AbortController();
  const reason = new Error('Origin lookup cancelled.');

  const watcher = watch(directory, (_event, name) => {
    if (name === 'started') {
      entered.resolve(Number(readFileSync(startedPath, 'utf8')));
    }
  });

  onTestFinished(() => {
    controller.abort();
    watcher.close();
    vi.unstubAllEnvs();
  });

  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('starting', String(process.pid));
fs.renameSync('starting', 'started');
setTimeout(() => {
  fs.writeFileSync('completed', 'done');
  console.log('https://github.com/sQVe/tau.git');
}, 300);
`,
  );

  chmodSync(executable, 0o755);
  vi.stubEnv('PATH', directory);

  const reading = readOriginRepository({
    exec: sshAlias,
    cwd: directory,
    signal: controller.signal,
  }).catch((error: unknown) => error);

  const processId = await entered.promise;

  controller.abort(reason);
  expect(await reading).toBe(reason);
  await expect.poll(() => processState(processId)).toBe('gone');
  expect(existsSync(completedPath)).toBe(false);
});

it('keeps the URL host when the ssh read is killed, and bounds the read with a timeout', async () => {
  const timeouts: (number | undefined)[] = [];

  const killed: Exec = (_command, _commandArguments, options) => {
    timeouts.push(options?.timeout);

    return Promise.resolve({ code: 0, killed: true, stdout: 'hostname github.com\n', stderr: '' });
  };

  expect(await originOf('git@work:sQVe/tau.git', killed)).toEqual(named('work'));
  expect(timeouts).toEqual([5000]);
});
