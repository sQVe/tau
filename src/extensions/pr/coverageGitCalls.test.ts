import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { installCommandShim, logCommandCalls } from '../../../tests/commandShimFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createGhFake } from '../../../tests/prGhFake.js';
import { createSavedFix, createSavedReview, savedReviewLink } from '../../../tests/savedReview.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createPrTool } from './tool.js';

const readCalls = async (logPath: string): Promise<string[]> => {
  const text = await readFile(logPath, 'utf8');

  return text.split('\n').filter((line) => line !== '');
};

const countCalls = (calls: string[], command: string): number =>
  calls.filter((call) => call === command).length;

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

const setUpChain = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.ts'), 'a one\n');
  const base = await commitAll(root, 'first');

  await writeFile(join(root, 'a.ts'), 'a two\n');
  const reviewed = await commitAll(root, 'reviewed');
  const review = await createSavedReview(root, { kind: 'range', from: base, to: reviewed });

  await writeFile(join(root, 'a.ts'), 'a three\n');
  const fix = await createSavedFix(root, review, ['a.ts']);

  await commitAll(root, 'fixed');

  return { root, base, review, fix };
};

it('asks Git for the object format once in one standalone coverage read', async () => {
  const { root, base, review, fix } = await setUpChain();
  const copy = join(temporaryDirectory(onTestFinished, 'tau-coverage-cold-'), 'repository');

  await cp(root, copy, { recursive: true });

  const copied = (path: string) => join(copy, relative(root, path));

  const links = [
    await savedReviewLink(copy, copied(review)),
    await savedReviewLink(copy, copied(fix)),
  ];

  const logPath = join(temporaryDirectory(onTestFinished, 'tau-coverage-git-calls-'), 'calls.log');

  await writeFile(logPath, '');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [logCommandCalls(logPath)],
  });

  const tool = createPrTool(createGhFake().exec);

  await tool.execute(
    'call',
    { action: 'coverage', chain: links, mergeBase: base },
    undefined,
    undefined,
    noUiContext(copy),
  );

  const calls = await readCalls(logPath);

  expect(countCalls(calls, 'rev-parse --show-object-format')).toBe(1);
});
