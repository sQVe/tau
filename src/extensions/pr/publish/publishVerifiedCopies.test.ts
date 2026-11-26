import { expect, it } from 'vitest';

import { verifiedCopyArguments } from './publish.js';

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
