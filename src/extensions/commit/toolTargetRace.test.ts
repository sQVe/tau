import { expect, it } from 'vitest';

import {
  commitContext,
  createTemporaryRepository,
  executeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';

it('rejects a target removed from history before the snapshot and restores the index', async () => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(directory, 'file.txt', 'original\n');
  await git(directory, ['add', 'file.txt']);
  await git(directory, ['commit', '-m', 'fix: target']);

  const tree = (await git(directory, ['rev-parse', 'HEAD^{tree}'])).trim();
  const unrelated = (await git(directory, ['commit-tree', tree, '-m', 'unrelated'])).trim();
  const index = await git(directory, ['ls-files', '--stage']);

  await writeRepositoryFile(directory, 'file.txt', 'corrected\n');

  const tool = createCommitTool({
    async exec(command, commandArguments, options) {
      if (commandArguments[0] === 'write-tree') {
        await git(directory, ['update-ref', 'HEAD', unrelated]);
      }

      return runCommand(command, commandArguments, options?.cwd ?? directory);
    },
  });

  await expect(
    tool.execute(
      'race',
      {
        groups: [{ files: ['file.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
      },
      undefined,
      undefined,
      commitContext(directory),
    ),
  ).rejects.toThrow(/target is no longer an ancestor of the snapshot HEAD/);

  expect((await git(directory, ['rev-parse', 'HEAD'])).trim()).toBe(unrelated);
  expect(await git(directory, ['ls-files', '--stage'])).toBe(index);
});

it('allows earlier groups to advance HEAD before a fixup snapshot', async () => {
  const directory = await createTemporaryRepository();

  await git(directory, ['commit', '--allow-empty', '-m', 'base']);
  await writeRepositoryFile(directory, 'first.txt', 'first\n');
  await writeRepositoryFile(directory, 'second.txt', 'second\n');

  const result = await executeCommit(directory, {
    groups: [
      { files: ['first.txt'], subject: 'fix: first' },
      { files: ['second.txt'], fixup: { target: 'HEAD', kind: 'fixup' } },
    ],
  });

  expect(result.details.groups).toHaveLength(2);
  expect((await git(directory, ['log', '-1', '--format=%s'])).trim()).toBe('fixup! base');
});
