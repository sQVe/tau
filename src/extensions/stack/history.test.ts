import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { createStackCheckout, git } from './fixtures/checkout.js';
import { createStackFake } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';
import type { StackInput } from './tool.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const layer = (name: string, flags: Record<string, unknown> = {}) => ({
  name,
  base: 'b'.repeat(40),
  isCurrent: false,
  isMerged: false,
  isQueued: false,
  needsRebase: false,
  pr: null,
  ...flags,
});

const commit = async (root: string, file: string, message = file) => {
  await writeFile(join(root, file), file);
  await git(root, 'add', file);
  await git(root, 'commit', '--quiet', '-m', message);
};

// main -> lower -> upper, both pushed.
const setUp = async () => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();

  await git(root, 'checkout', '--quiet', '-b', 'lower');
  await commit(root, 'lower.txt');
  await git(root, 'checkout', '--quiet', '-b', 'upper');
  await commit(root, 'upper.txt');
  await git(root, 'push', '--quiet', 'origin', 'lower', 'upper');
  await git(root, 'fetch', '--quiet', 'origin');

  const setStack = (...layers: ReturnType<typeof layer>[]) => {
    const view = { trunk: 'main', currentBranch: 'upper', branches: layers };

    fake.stackView = { code: 0, stdout: JSON.stringify(view), stderr: '' };
  };

  setStack(layer('lower'), layer('upper'));

  const run = async (input: Partial<StackInput> = {}) => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      { action: 'history', remote: 'origin', ...input },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details as {
      layers: { branch: string; status: string; remoteTip: string | null }[];
      stop: string | null;
    };
  };

  const statuses = async (input: Partial<StackInput> = {}) => {
    const details = await run(input);

    return Object.fromEntries(details.layers.map((entry) => [entry.branch, entry.status]));
  };

  return { root, fake, run, setStack, statuses };
};

it('reports current for branches level with their remote, with the noted remote tips', async () => {
  const { root, run } = await setUp();

  const details = await run();

  expect(details.layers).toMatchObject([
    { branch: 'lower', status: 'current', remoteTip: await git(root, 'rev-parse', 'origin/lower') },
    { branch: 'upper', status: 'current', remoteTip: await git(root, 'rev-parse', 'origin/upper') },
  ]);

  expect(details.stop).toBeNull();
});

it('reports behind for a branch named like an object property without a start tip', async () => {
  const { root, setStack, statuses } = await setUp();

  await git(root, 'checkout', '--quiet', '-b', 'constructor');
  await commit(root, 'constructor.txt');
  await commit(root, 'more.txt');
  await git(root, 'push', '--quiet', 'origin', 'constructor');
  await git(root, 'reset', '--quiet', '--hard', 'HEAD~1');
  setStack(layer('lower'), layer('upper'), layer('constructor'));

  expect(await statuses()).toEqual({ lower: 'current', upper: 'current', constructor: 'behind' });
});

it('reports unpublished for a branch without a remote branch', async () => {
  const { root, statuses } = await setUp();

  await git(root, 'update-ref', '-d', 'refs/remotes/origin/upper');

  expect(await statuses()).toEqual({ lower: 'current', upper: 'unpublished' });
});

it('reports behind for a branch only behind its remote', async () => {
  const { root, statuses } = await setUp();

  await commit(root, 'more.txt');
  await git(root, 'push', '--quiet', 'origin', 'upper');
  await git(root, 'reset', '--quiet', '--hard', 'HEAD~1');

  expect(await statuses()).toEqual({ lower: 'current', upper: 'behind' });
});

it('reports diverged for a branch with commits the remote lacks and the remote has commits it lacks', async () => {
  const { root, statuses } = await setUp();

  await commit(root, 'remote-only.txt');
  await git(root, 'push', '--quiet', 'origin', 'upper');
  await git(root, 'reset', '--quiet', '--hard', 'HEAD~1');
  await commit(root, 'local-only.txt');

  expect(await statuses()).toEqual({ lower: 'current', upper: 'diverged' });
});

it('reports diverged when the remote has an unrelated commit and the branch has none of its own', async () => {
  const { root, statuses } = await setUp();

  await git(root, 'checkout', '--quiet', 'lower');
  await commit(root, 'other.txt');
  await git(root, 'push', '--quiet', '--force', 'origin', 'lower');
  await git(root, 'reset', '--quiet', '--hard', 'HEAD~1');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'different');

  expect((await statuses()).lower).toBe('diverged');
});

// GitHub merged lower by squash: main gets the same change as a new commit, and the remote upper
// is rewritten onto main.
const rewriteRemoteUpper = async (root: string) => {
  await git(root, 'checkout', '--quiet', 'main');
  await commit(root, 'lower.txt', 'squash lower');
  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'rewrite');
  await git(root, 'cherry-pick', 'upper');
  await git(root, 'push', '--quiet', '--force', 'origin', 'rewrite:upper');
  await git(root, 'checkout', '--quiet', 'upper');
  await git(root, 'fetch', '--quiet', 'origin');
};

it('reports rewritten for a branch GitHub rewrote after the lower pull request merged', async () => {
  const { root, setStack, statuses } = await setUp();

  await rewriteRemoteUpper(root);
  setStack(layer('lower', { isMerged: true }), layer('upper'));

  expect(await statuses()).toEqual({ upper: 'rewritten' });
});

it('uses the tip from before the rebase when the branch was rebased since its push', async () => {
  const { root, setStack, statuses } = await setUp();

  const startTip = await git(root, 'rev-parse', 'upper');

  await rewriteRemoteUpper(root);
  await git(root, 'rebase', '--quiet', '--onto', 'main', 'lower');
  setStack(layer('lower', { isMerged: true }), layer('upper'));

  expect(await statuses({ startTips: { upper: startTip } })).toEqual({ upper: 'rewritten' });
});

it('reports diverged when the remote rewrite holds a change the branch lacks', async () => {
  const { root, setStack, statuses } = await setUp();

  await rewriteRemoteUpper(root);
  await git(root, 'checkout', '--quiet', 'rewrite');
  await commit(root, 'extra.txt');
  await git(root, 'push', '--quiet', '--force', 'origin', 'rewrite:upper');
  await git(root, 'checkout', '--quiet', 'upper');
  await git(root, 'fetch', '--quiet', 'origin');
  setStack(layer('lower', { isMerged: true }), layer('upper'));

  expect(await statuses()).toEqual({ upper: 'diverged' });
});

it('reports unknown, not diverged, when a branch the cherry reads needs is gone', async () => {
  const { root, setStack, run } = await setUp();

  await rewriteRemoteUpper(root);
  await git(root, 'branch', '--quiet', '-D', 'lower');
  setStack(layer('lower', { isMerged: true }), layer('upper'));

  const details = await run();

  expect(details.layers).toMatchObject([{ branch: 'upper', status: 'unknown' }]);
});

it('skips merged and queued branches and passes over the queued one as a parent', async () => {
  const { setStack, run } = await setUp();

  setStack(layer('lower', { isQueued: true }), layer('upper'));

  const details = await run();

  expect(details.layers.map((entry) => entry.branch)).toEqual(['upper']);
});

it.each([
  { name: 'no stack', view: { code: 2, stdout: '', stderr: 'no stack' } },
  { name: 'several stacks', view: { code: 6, stdout: '', stderr: 'several' } },
  { name: 'empty output', view: { code: 0, stdout: '', stderr: '' } },
  { name: 'malformed output', view: { code: 0, stdout: '[]', stderr: '' } },
])('stops, with no layers, for $name from gh stack view', async ({ view }) => {
  const { fake, run } = await setUp();

  fake.stackView = view;

  const details = await run();

  expect(details.layers).toEqual([]);
  expect(details.stop).toEqual(containing('gh stack view --json'));
});

it('refuses an empty remote name with its own error', async () => {
  const { run } = await setUp();

  await expect(run({ remote: '' })).rejects.toThrow('remote must not be empty');
});

it('refuses a remote that is not a Git remote', async () => {
  const { run } = await setUp();

  await expect(run({ remote: 'nowhere' })).rejects.toThrow('remote nowhere is not a Git remote');
});

it('refuses a start tip that is not a commit SHA', async () => {
  const { run } = await setUp();

  await expect(run({ startTips: { upper: '--all' } })).rejects.toThrow('must be a commit SHA');
});

it('changes nothing in the repository', async () => {
  const { root, run } = await setUp();

  const before = await git(root, 'for-each-ref');

  await run();

  expect(await git(root, 'for-each-ref')).toBe(before);
});
