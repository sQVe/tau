import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { emptySessionRefusal, installHcCommand } from './hcCommandHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface FakeCommandOptions {
  session?: string;
  log?: string | null;
  replies?: string | null;
}

const installFakeHcCommand = (
  onTestFinished: TestContext['onTestFinished'],
  prefix = 'tau-hc-command-',
) => {
  const directory = temporaryDirectory(onTestFinished, prefix);
  const files = installHcCommand(directory);

  const run = (args: string[], options: FakeCommandOptions = {}) => {
    const log = options.log === undefined ? files.log : options.log;
    const replies = options.replies === undefined ? files.replies : options.replies;

    const env: NodeJS.ProcessEnv = {
      HC_SESSION: options.session ?? 'tau-hc-command',
      PATH: process.env.PATH ?? '',
    };

    if (log !== null) {
      env.HC_FAKE_LOG = log;
    }

    if (replies !== null) {
      env.HC_FAKE_REPLIES = replies;
    }

    return spawnSync(join(files.bin, 'hc'), args, { env, encoding: 'utf8' });
  };

  return { ...files, directory, run };
};

it('answers an empty terminal list without a reply from the hc fake', ({ onTestFinished }) => {
  const { run } = installFakeHcCommand(onTestFinished);

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[]}\n');
});

it('answers a command with its reply from the hc fake', ({ onTestFinished }) => {
  const { reply, run } = installFakeHcCommand(onTestFinished);

  reply('ls', '{"terminals":[{"address":"t-child"}]}');

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[{"address":"t-child"}]}\n');
});

it('answers a command from a reply directory whose path holds a space and an apostrophe', ({
  onTestFinished,
}) => {
  const { log, reply, run } = installFakeHcCommand(onTestFinished, "tau hc command's-");

  reply('ls', '{"terminals":[{"address":"t-child"}]}');

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[{"address":"t-child"}]}\n');
  expect(readFileSync(log, 'utf8')).toBe('ls --json --all\n');
});

it('answers a terminal lookup with its own reply before the command reply', ({
  onTestFinished,
}) => {
  const { reply, replyGet, run } = installFakeHcCommand(onTestFinished);

  reply('get', '{"address":"shared"}');
  replyGet('t-child', '{"address":"t-child"}');

  expect(run(['get', '--json', '--', 't-child']).stdout).toBe('{"address":"t-child"}\n');
  expect(run(['get', '--json', '--', 't-other']).stdout).toBe('{"address":"shared"}\n');
});

it('finds the hc subcommand after a leading flag', ({ onTestFinished }) => {
  const { reply, run } = installFakeHcCommand(onTestFinished);

  reply('ls', '{"terminals":[{"address":"t-child"}]}');

  expect(run(['--json', 'ls']).stdout).toBe('{"terminals":[{"address":"t-child"}]}\n');
});

it('refuses a command with no HC_SESSION in the hc fake', ({ onTestFinished }) => {
  const { log, run } = installFakeHcCommand(onTestFinished);

  const result = run(['ls', '--json', '--all'], { session: '' });

  expect(result.status).toBe(64);
  expect(readFileSync(log, 'utf8')).toBe(`${emptySessionRefusal}\n`);
});

it('fails the hc fake with a clear message when HC_FAKE_LOG is unset', ({ onTestFinished }) => {
  const { run } = installFakeHcCommand(onTestFinished);

  const result = run(['ls'], { log: null });

  expect(result.status).toBe(70);
  expect(result.stderr).toContain('HC_FAKE_LOG');
});

it('fails the hc fake with a clear message when HC_FAKE_REPLIES is unset', ({ onTestFinished }) => {
  const { log, run } = installFakeHcCommand(onTestFinished);

  const result = run(['ls'], { replies: null });

  expect(result.status).toBe(70);
  expect(result.stderr).toContain('HC_FAKE_REPLIES');
  expect(existsSync(log)).toBe(false);
});

it('fails the hc fake with a clear message when HC_FAKE_REPLIES names a missing path', ({
  onTestFinished,
}) => {
  const { directory, log, run } = installFakeHcCommand(onTestFinished);

  const result = run(['ls'], { replies: join(directory, 'missing-replies') });

  expect(result.status).toBe(70);
  expect(result.stderr).toContain('HC_FAKE_REPLIES');
  expect(existsSync(log)).toBe(false);
});

it('fails the hc fake with a clear message when HC_FAKE_LOG cannot be written', ({
  onTestFinished,
}) => {
  const { directory, run } = installFakeHcCommand(onTestFinished);

  const result = run(['ls'], { log: join(directory, 'missing-directory', 'hc.log') });

  expect(result.status).toBe(70);
  expect(result.stderr).toContain('HC_FAKE_LOG');
});

it.skipIf(process.platform !== 'linux')(
  'refuses a command whose log opens but cannot be written',
  ({ onTestFinished }) => {
    const { reply, run } = installFakeHcCommand(onTestFinished);

    reply('ls', '{"terminals":[{"address":"t-child"}]}');

    const result = run(['ls'], { log: '/dev/full' });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain('HC_FAKE_LOG');
  },
);
