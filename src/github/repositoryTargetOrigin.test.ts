import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import type { Exec } from '../command.js';
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
  const directory = await mkdtemp(`${tmpdir()}/tau-no-repository-`);
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  expect(await readOriginRepository({ exec: sshAlias, cwd: directory })).toEqual({
    status: 'missing',
  });
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
