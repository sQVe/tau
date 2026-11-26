import { expect, it } from 'vitest';

import { verifiedCopyArguments } from './publishExecution.js';

const directory = '/tmp/tau-publish-test';
const first = { file: 'body.md', path: '/run/a/body.md', bytes: Buffer.from('First.\n') };
const second = { file: 'body.md', path: '/run/b/body.md', bytes: Buffer.from('Second.\n') };

it('rewrites every file argument to a unique verified copy', () => {
  const result = verifiedCopyArguments(
    ['--body-file', first.path, '--input', second.path],
    [first, second],
    directory,
  );

  expect(result.commandArguments).toEqual([
    '--body-file',
    `${directory}/0-body.md`,
    '--input',
    `${directory}/2-body.md`,
  ]);

  expect(result.copies).toEqual([
    { path: `${directory}/0-body.md`, bytes: first.bytes },
    { path: `${directory}/2-body.md`, bytes: second.bytes },
  ]);
});

it('refuses a file flag with no value after it', () => {
  expect(() => verifiedCopyArguments(['--input'], [first], directory)).toThrow(
    'The publication command has no file after --input.',
  );
});

it('refuses a file flag whose value the plan did not verify', () => {
  expect(() => verifiedCopyArguments(['--body-file', '/run/other.md'], [first], directory)).toThrow(
    'The publication command reads a file the plan did not verify.',
  );
});

it('refuses a command that names no file', () => {
  expect(() => verifiedCopyArguments(['gh', 'pr', 'view'], [first], directory)).toThrow(
    'The publication command names no file to read.',
  );
});
