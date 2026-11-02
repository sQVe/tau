import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { runGit } from '../../git.js';
import { createGhFake } from './fixtures/ghFake.js';
import { createPublicationRepository, pushFeature } from './fixtures/publicationRepository.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const toolContext = (root: string) =>
  ({
    ...noUiContext(root),
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  }) as unknown as ExtensionToolContext;

// A checkout whose origin is github.com/<origin>, with main pushed and the feature branch checked
// out. forkPoint is the SHA where feature leaves main.
const setUp = async (origin = 'sQVe/tau') => {
  const { root, forkPoint } = await createPublicationRepository(onTestFinished, {
    origin,
    remote: true,
  });

  const fake = createGhFake();
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-pr-tool-agent-');

  fake.repositories[`github.com/${origin}`] = { defaultBranch: 'main' };

  const run = async (input: PrInput) => {
    const tool = createPrTool(fake.exec, { agentDirectory });
    const result = await tool.execute('call', input, undefined, undefined, toolContext(root));

    return result.details;
  };

  return { root, fake, forkPoint, run };
};

it('makes a check log match evidence for a committed diff over 1 MiB', async () => {
  const { root, forkPoint, fake, run } = await setUp();
  const content = 'a line of committed content\n'.repeat(80_000);

  await writeFile(join(root, 'large.txt'), content);
  await git(root, 'add', 'large.txt');
  await git(root, 'commit', '--quiet', '-m', 'large change');
  await pushFeature(root);

  const { stdout: diff } = await runGit(root, ['diff', forkPoint, 'HEAD']);

  expect(diff.length).toBeGreaterThan(1_048_576);

  const { directory } = await run({ action: 'prepare' });
  const checks = join(String(directory), 'checks');

  await mkdir(checks);
  await writeFile(join(root, 'large.txt'), `${content}dirty\n`);

  const files = await readdir(root, { recursive: true });
  const status = await git(root, 'status', '--porcelain');
  const head = await git(root, 'rev-parse', 'HEAD');
  const header = await run({ action: 'checkHeader', mergeBase: forkPoint });

  expect(header['lines']).toHaveLength(3);
  expect(await readdir(root, { recursive: true })).toEqual(files);
  expect(await git(root, 'status', '--porcelain')).toBe(status);
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(fake.calls).toEqual([]);

  const path = join(checks, 'test.log');
  const lines = header['lines'] as string[];

  await writeFile(path, `${lines.join('\n')}\ntests passed\n`);

  const evidence = await run({ action: 'evidence' });

  expect(evidence['checks']).toEqual([
    { path, matches: true, reasons: [], excerpt: 'tests passed', truncated: false },
  ]);
});

it.each([
  { name: 'a missing mergeBase', mergeBase: undefined, error: 'checkHeader needs mergeBase.' },
  { name: 'an unknown revision', mergeBase: 'missing-commit', error: /^git rev-parse .* failed:/u },
  {
    name: 'a tree instead of a commit',
    mergeBase: 'HEAD^{tree}',
    error: /^git rev-parse .* failed:/u,
  },
])(
  'refuses check headers for $name without changing the checkout',
  async ({ mergeBase, error }) => {
    const { root, fake, run } = await setUp();
    const files = await readdir(root, { recursive: true });
    const head = await git(root, 'rev-parse', 'HEAD');
    const status = await git(root, 'status', '--porcelain');

    const input: PrInput = {
      action: 'checkHeader',
      ...(mergeBase === undefined ? {} : { mergeBase }),
    };

    await expect(run(input)).rejects.toThrow(error);

    expect(await readdir(root, { recursive: true })).toEqual(files);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe(status);
    expect(fake.calls).toEqual([]);
  },
);

it('reads check identity without refreshing the Git index', async () => {
  const { root, forkPoint, run } = await setUp();
  const path = join(root, 'feature.txt');

  await writeFile(path, 'tracked\n');
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'tracked file');
  await utimes(path, 1, 1);

  const index = join(root, '.git', 'index');
  const before = await readFile(index);

  await run({ action: 'checkHeader', mergeBase: forkPoint });

  expect(await readFile(index)).toEqual(before);
});

it.each([
  { name: 'color', key: 'color.diff', value: 'always' },
  { name: 'external diff', key: 'diff.external', value: 'false' },
  { name: 'text conversion', key: 'diff.test.textconv', value: 'false' },
])(
  'keeps check headers and evidence independent of $name configuration',
  async ({ key, value }) => {
    const { root, forkPoint, run } = await setUp();

    await writeFile(join(root, 'feature.txt'), 'tracked\n');
    await writeFile(join(root, '.gitattributes'), 'feature.txt diff=test\n');
    await git(root, 'add', 'feature.txt', '.gitattributes');
    await git(root, 'commit', '--quiet', '-m', 'tracked file');

    const { directory } = await run({ action: 'prepare' });
    const checks = join(String(directory), 'checks');

    await mkdir(checks);

    const canonical = await run({ action: 'checkHeader', mergeBase: forkPoint });

    await git(root, 'config', key, value);

    const configured = await run({ action: 'checkHeader', mergeBase: forkPoint });

    expect(configured).toEqual(canonical);

    const path = join(checks, 'test.log');
    const lines = configured['lines'] as string[];

    await writeFile(path, `${lines.join('\n')}\ntests passed\n`);

    const evidence = await run({ action: 'evidence', remote: 'origin' });

    expect(evidence['checks']).toEqual([
      { path, matches: true, reasons: [], excerpt: 'tests passed', truncated: false },
    ]);
  },
);
