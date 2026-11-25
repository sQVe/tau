import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { emptySessionRefusal, installHcCommand } from './hcCommandHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const setup = (prefix = 'tau-hc-command-') => {
  const directory = temporaryDirectory(onTestFinished, prefix);
  const files = installHcCommand(directory);

  const run = (args: string[], session = 'tau-hc-command') =>
    spawnSync(join(files.bin, 'hc'), args, {
      env: {
        HC_SESSION: session,
        HC_FAKE_LOG: files.log,
        HC_FAKE_REPLIES: files.replies,
        PATH: process.env.PATH ?? '',
      },
      encoding: 'utf8',
    });

  return { ...files, run };
};

it('answers an empty terminal list without a reply', () => {
  const { run } = setup();

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[]}\n');
});

it('answers a command with its reply', () => {
  const { reply, run } = setup();

  reply('ls', '{"terminals":[{"address":"t-child"}]}');

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[{"address":"t-child"}]}\n');
});

it('answers a command from a reply directory whose path holds an apostrophe', () => {
  const { reply, run } = setup("tau-hc-command's-");

  reply('ls', '{"terminals":[{"address":"t-child"}]}');

  expect(run(['ls', '--json', '--all']).stdout).toBe('{"terminals":[{"address":"t-child"}]}\n');
});

it('answers a terminal lookup with its own reply before the command reply', () => {
  const { reply, replyGet, run } = setup();

  reply('get', '{"address":"shared"}');
  replyGet('t-child', '{"address":"t-child"}');

  expect(run(['get', '--json', '--', 't-child']).stdout).toBe('{"address":"t-child"}\n');
  expect(run(['get', '--json', '--', 't-other']).stdout).toBe('{"address":"shared"}\n');
});

it('refuses a command with no HC_SESSION', () => {
  const { log, run } = setup();

  const result = run(['ls', '--json', '--all'], '');

  expect(result.status).toBe(64);
  expect(readFileSync(log, 'utf8')).toBe(`${emptySessionRefusal}\n`);
});
