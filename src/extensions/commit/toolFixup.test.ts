import { expect, it } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  getStoredCommitMessage,
  git,
  runCommand,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import type { CommitInput } from './validation.js';

const prepareRepository = async () => {
  const directory = await createTemporaryRepository();

  await git(directory, ['commit', '--allow-empty', '-m', 'base']);
  await writeRepositoryFile(directory, 'file.txt', 'original\n');
  await git(directory, ['add', 'file.txt']);
  await git(directory, ['commit', '-m', 'target subject\ncontinued subject']);
  await writeRepositoryFile(directory, 'file.txt', 'corrected\n');

  return directory;
};

it.each(['fixup', 'squash', 'amend'] as const)('creates an autosquash %s message', async (kind) => {
  const directory = await prepareRepository();
  const targetSubject = await git(directory, ['log', '-1', '--format=%s']);
  const body = 'fix: replacement\n\nExplanation';

  const result = await executeCommit(directory, {
    groups: [{ files: ['file.txt'], fixup: { target: 'HEAD', kind }, body }],
  });

  expect(await getStoredCommitMessage(directory)).toBe(
    `${kind}! ${targetSubject.trim()}\n\n${body}\n`,
  );

  expect(result.details.groups[0]?.hookChanges?.message).toBe(false);
});

it.each([
  { kind: 'fixup', message: 'target subject\ncontinued subject\n' },
  {
    kind: 'squash',
    message: 'target subject\ncontinued subject\n\nfix: replacement\n\nExplanation\n',
  },
  { kind: 'amend', message: 'fix: replacement\n\nExplanation\n' },
] as const)('folds a $kind into its target with autosquash', async ({ kind, message }) => {
  const directory = await prepareRepository();
  const base = (await git(directory, ['rev-parse', 'HEAD~1'])).trim();

  await executeCommit(directory, {
    groups: [
      {
        files: ['file.txt'],
        fixup: { target: 'HEAD', kind },
        body: 'fix: replacement\n\nExplanation',
      },
    ],
  });

  const result = await runCommand(
    'env',
    ['GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'git', 'rebase', '-i', '--autosquash', base],
    directory,
  );

  expect(result.code, result.stderr).toBe(0);
  expect((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()).toBe('1');
  expect(await git(directory, ['show', 'HEAD:file.txt'])).toBe('corrected\n');
  expect(await getStoredCommitMessage(directory)).toBe(message);
});

const invalidGroups: { name: string; group: CommitInput['groups'][number]; error: RegExp }[] = [
  {
    name: 'both message choices',
    group: {
      files: ['file.txt'],
      subject: 'fix: change',
      fixup: { target: 'HEAD', kind: 'fixup' },
    },
    error: /both subject and fixup/,
  },
  {
    name: 'neither message choice',
    group: { files: ['file.txt'] },
    error: /subject or fixup is required/,
  },
  {
    name: 'unknown target',
    group: { files: ['file.txt'], fixup: { target: 'missing', kind: 'fixup' } },
    error: /does not resolve to a commit/,
  },
  {
    name: 'option-like target',
    group: { files: ['file.txt'], fixup: { target: '--help', kind: 'fixup' } },
    error: /does not resolve to a commit/,
  },
  {
    name: 'amend without body',
    group: { files: ['file.txt'], fixup: { target: 'HEAD', kind: 'amend' } },
    error: /amend requires a non-empty body/,
  },
];

const expectUnchangedFailure = async (
  directory: string,
  groups: CommitInput['groups'],
  error: RegExp,
) => {
  const head = await git(directory, ['rev-parse', 'HEAD']);
  const index = await git(directory, ['ls-files', '--stage']);

  await expect(executeCommit(directory, { groups })).rejects.toThrow(error);

  expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(directory, ['ls-files', '--stage'])).toBe(index);
};

it.each(invalidGroups)('rejects $name without changing HEAD or index', async ({ group, error }) => {
  expect.assertions(3);

  const directory = await prepareRepository();

  await git(directory, ['add', 'file.txt']);
  await expectUnchangedFailure(directory, [group], error);
});

it('rejects a target outside HEAD history', async () => {
  expect.assertions(3);

  const directory = await prepareRepository();
  const tree = (await git(directory, ['rev-parse', 'HEAD^{tree}'])).trim();
  const target = (await git(directory, ['commit-tree', tree, '-m', 'other history'])).trim();

  await expectUnchangedFailure(
    directory,
    [{ files: ['file.txt'], fixup: { target, kind: 'fixup' } }],
    /not an ancestor of HEAD/,
  );
});

it('rejects a merge target', async () => {
  expect.assertions(3);

  const directory = await prepareRepository();
  const tree = (await git(directory, ['rev-parse', 'HEAD^{tree}'])).trim();
  const other = (await git(directory, ['commit-tree', tree, '-m', 'other history'])).trim();

  const merge = (
    await git(directory, ['commit-tree', tree, '-p', 'HEAD', '-p', other, '-m', 'merge'])
  ).trim();

  await git(directory, ['update-ref', 'HEAD', merge]);

  await expectUnchangedFailure(
    directory,
    [{ files: ['file.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
    /merge commit/,
  );
});

it('resolves later targets before committing any group', async () => {
  expect.assertions(3);

  const directory = await prepareRepository();

  await writeRepositoryFile(directory, 'second.txt', 'second\n');

  await expectUnchangedFailure(
    directory,
    [
      { files: ['file.txt'], subject: 'fix: first' },
      { files: ['second.txt'], fixup: { target: 'missing', kind: 'fixup' } },
    ],
    /does not resolve to a commit/,
  );
});
