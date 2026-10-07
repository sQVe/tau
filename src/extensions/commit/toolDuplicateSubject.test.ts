import { expect, it } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

it('folds a duplicate-subject fix into the later target', async () => {
  const directory = await createTemporaryRepository();

  await git(directory, ['commit', '--allow-empty', '-m', 'base']);

  const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();

  await writeRepositoryFile(directory, 'first.txt', 'first\n');
  await git(directory, ['add', 'first.txt']);
  await git(directory, ['commit', '-m', 'fix: same subject']);
  await writeRepositoryFile(directory, 'second.txt', 'second\n');
  await git(directory, ['add', 'second.txt']);
  await git(directory, ['commit', '-m', 'fix: same subject']);

  const target = (await git(directory, ['rev-parse', 'HEAD'])).trim();

  await writeRepositoryFile(directory, 'first.txt', 'corrected\n');

  await executeCommit(directory, {
    groups: [{ files: ['first.txt'], fixup: { target, kind: 'fixup' } }],
  });

  const result = await runCommand(
    'env',
    ['GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'git', 'rebase', '-i', '--autosquash', base],
    directory,
  );

  expect(result.code, result.stderr).toBe(0);
  expect((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()).toBe('2');
  expect(await git(directory, ['show', 'HEAD~1:first.txt'])).toBe('first\n');
  expect(await git(directory, ['show', 'HEAD:first.txt'])).toBe('corrected\n');
});

it('folds a duplicate-subject fix into the merged sibling target', async () => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(directory, 'shared.txt', 'original\n');
  await git(directory, ['add', 'shared.txt']);
  await git(directory, ['commit', '-m', 'base']);

  const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();

  await git(directory, ['branch', 'side']);
  await writeRepositoryFile(directory, 'main.txt', 'main\n');
  await git(directory, ['add', 'main.txt']);
  await git(directory, ['commit', '-m', 'fix: [same]\ncontinued subject']);
  await git(directory, ['checkout', 'side']);
  await writeRepositoryFile(directory, 'side.txt', 'side\n');
  await git(directory, ['add', 'side.txt']);
  await git(directory, ['commit', '-m', 'fix: [same]\ncontinued subject']);

  const target = (await git(directory, ['rev-parse', 'HEAD'])).trim();

  await git(directory, ['checkout', 'main']);
  await git(directory, ['merge', '--no-ff', 'side', '-m', 'merge']);
  await git(directory, ['config', 'grep.patternType', 'extended']);
  await writeRepositoryFile(directory, 'shared.txt', 'corrected\n');

  await executeCommit(directory, {
    groups: [{ files: ['shared.txt'], fixup: { target, kind: 'fixup' } }],
  });

  const result = await runCommand(
    'env',
    ['GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'git', 'rebase', '-i', '--autosquash', base],
    directory,
  );

  expect(result.code, result.stderr).toBe(0);
  expect((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()).toBe('2');
  expect(await git(directory, ['show', 'HEAD~1:shared.txt'])).toBe('original\n');
  expect(await git(directory, ['show', 'HEAD:side.txt'])).toBe('side\n');
  expect(await git(directory, ['show', 'HEAD:shared.txt'])).toBe('corrected\n');
});

it.each([
  { name: 'wrapped duplicate', earlier: 'fix: same\nsubject', targetMessage: 'fix: same subject' },
  { name: 'padded duplicate', earlier: 'fix: same subject', targetMessage: 'fix: same subject   ' },
  { name: 'empty subject', earlier: 'fix: earlier', targetMessage: '' },
])('folds a $name into the target', async ({ earlier, targetMessage }) => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(directory, 'shared.txt', 'original\n');
  await git(directory, ['add', 'shared.txt']);
  await git(directory, ['commit', '-m', 'base']);

  const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();

  await git(directory, ['commit', '--allow-empty', '-m', earlier]);

  await git(directory, [
    'commit',
    '--allow-empty',
    '--allow-empty-message',
    '--cleanup=verbatim',
    '-m',
    targetMessage,
  ]);

  await writeRepositoryFile(directory, 'shared.txt', 'corrected\n');

  await executeCommit(directory, {
    groups: [{ files: ['shared.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
  });

  const result = await runCommand(
    'env',
    ['GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'git', 'rebase', '-i', '--autosquash', base],
    directory,
  );

  expect(result.code, result.stderr).toBe(0);
  expect((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()).toBe('2');
  expect(await git(directory, ['show', 'HEAD~1:shared.txt'])).toBe('original\n');
  expect(await git(directory, ['show', 'HEAD:shared.txt'])).toBe('corrected\n');
});

it.each(['fixup', 'squash', 'amend'])(
  'folds a fix into a target whose subject starts with %s!',
  async (prefix) => {
    const directory = await createTemporaryRepository();

    await git(directory, ['commit', '--allow-empty', '-m', 'base']);

    const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    await writeRepositoryFile(directory, 'target.txt', 'target\n');
    await git(directory, ['add', 'target.txt']);
    await git(directory, ['commit', '-m', `${prefix}! missing`]);

    const target = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    await writeRepositoryFile(directory, 'target.txt', 'corrected\n');

    await executeCommit(directory, {
      groups: [{ files: ['target.txt'], fixup: { target, kind: 'fixup' } }],
    });

    const result = await runCommand(
      'env',
      ['GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'git', 'rebase', '-i', '--autosquash', base],
      directory,
    );

    expect(result.code, result.stderr).toBe(0);
    expect((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()).toBe('1');
    expect(await git(directory, ['show', 'HEAD:target.txt'])).toBe('corrected\n');
  },
);
