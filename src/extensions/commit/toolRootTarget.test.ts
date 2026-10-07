import { expect, it } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

it('folds a fixup into a root target without a base commit', async () => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(directory, 'file.txt', 'original\n');
  await git(directory, ['add', 'file.txt']);
  await git(directory, ['commit', '-m', 'root']);
  await writeRepositoryFile(directory, 'file.txt', 'corrected\n');

  await executeCommit(directory, {
    groups: [{ files: ['file.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
  });

  const result = await runCommand(
    'env',
    [
      'GIT_EDITOR=true',
      'GIT_SEQUENCE_EDITOR=true',
      'git',
      'rebase',
      '-i',
      '--autosquash',
      '--root',
    ],
    directory,
  );

  expect(result.code, result.stderr).toBe(0);
  expect((await git(directory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  expect(await git(directory, ['show', 'HEAD:file.txt'])).toBe('corrected\n');
});
