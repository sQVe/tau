import { expect, it } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { runGit } from '../../git.js';
import {
  commitContext,
  createTemporaryRepository,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';

it('cancels the history scan before staging or committing', async () => {
  const directory = await createTemporaryRepository();
  const controller = new AbortController();

  await writeRepositoryFile(directory, 'file.txt', 'original\n');
  await git(directory, 'add', 'file.txt');
  await git(directory, 'commit', '-m', 'fix: target');
  await writeRepositoryFile(directory, 'file.txt', 'corrected\n');

  const head = await git(directory, 'rev-parse', 'HEAD');
  const index = await git(directory, 'ls-files', '--stage');

  const tool = createCommitTool((cwd, commandArguments, options) => {
    if (commandArguments.includes('--format=%H%x00%s')) {
      controller.abort();
    }

    return runGit(cwd, commandArguments, options);
  });

  await expect(
    tool.execute(
      'cancel',
      {
        groups: [{ files: ['file.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
      },
      controller.signal,
      undefined,
      commitContext(directory),
    ),
  ).rejects.toThrow(/failed/);

  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(head);
  expect(await git(directory, 'ls-files', '--stage')).toBe(index);
});
