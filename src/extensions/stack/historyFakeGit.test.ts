import { expect, it, onTestFinished } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { createGitFake } from './fixtures/gitFake.js';
import type { GitFake } from './fixtures/gitFake.js';
import { createStackFake } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

interface Layers {
  layers: { branch: string; status: string; reason: string | null; remoteTip: string | null }[];
  evidence: { layers: { branch: string; facts: Record<string, unknown> }[] };
}

const sha = 'c'.repeat(40);

const layer = (name: string) => ({
  name,
  base: 'b'.repeat(40),
  isCurrent: false,
  isMerged: false,
  isQueued: false,
  needsRebase: false,
  pr: null,
});

const setUp = async () => {
  const gitFake = await createGitFake(onTestFinished);
  const fake = createStackFake();
  const view = { trunk: 'main', currentBranch: 'a', branches: [layer('a')] };

  fake.stackView = { code: 0, stdout: JSON.stringify(view), stderr: '' };
  gitFake.answer('remote', { stdout: 'origin\n' });
  gitFake.answer('rev-parse --verify --quiet refs/remotes/origin/a', { stdout: `${sha}\n` });
  gitFake.answer('log --oneline', { stdout: 'abc1234 remote commit\n' });
  gitFake.answer('merge-base --is-ancestor', { code: 1 });

  const run = async () => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      { action: 'history', remote: 'origin' },
      undefined,
      undefined,
      noUiContext(process.cwd()),
    );

    return result.details as unknown as Layers;
  };

  return { gitFake, fake, run };
};

const answerCherry = (gitFake: GitFake, newOutput: string, oldOutput: string) => {
  gitFake.answer('cherry refs/heads/a refs/remotes/origin/a', { stdout: newOutput });
  gitFake.answer('cherry refs/remotes/origin/a refs/heads/a', { stdout: oldOutput });
};

it('reads well-formed git output as a rewritten layer', async () => {
  const { gitFake, run } = await setUp();

  answerCherry(gitFake, '- abcdef0123\n', '- 0123456789ab\n');

  expect((await run()).layers).toMatchObject([
    { branch: 'a', status: 'rewritten', remoteTip: sha },
  ]);
});

it('reads a missing remote branch as unpublished', async () => {
  const { gitFake, run } = await setUp();

  gitFake.answer('rev-parse --verify --quiet refs/remotes/origin/a', { code: 1 });

  expect((await run()).layers).toMatchObject([{ status: 'unpublished', remoteTip: null }]);
});

it.each([
  { name: 'a failing git cherry', first: { code: 128, stderr: 'fatal: bad object' }, second: {} },
  {
    name: 'a failing second git cherry',
    first: { stdout: '- abcdef0123\n' },
    second: { code: 128 },
  },
  {
    name: 'garbage cherry lines',
    first: { stdout: 'garbage\n' },
    second: { stdout: '- abcdef0123\n' },
  },
  { name: 'a verbose cherry line', first: { stdout: '- abcdef0123 subject\n' }, second: {} },
])('decides unknown for $name', async ({ first, second }) => {
  const { gitFake, run } = await setUp();

  gitFake.answer('cherry refs/heads/a refs/remotes/origin/a', first);
  gitFake.answer('cherry refs/remotes/origin/a refs/heads/a', second);

  expect((await run()).layers).toMatchObject([{ status: 'unknown', remoteTip: sha }]);
});

it.each([
  { name: 'rev-parse output that is not a SHA', answer: { stdout: 'not-a-sha\n' } },
  { name: 'empty rev-parse output', answer: { stdout: '' } },
  { name: 'a failing rev-parse', answer: { code: 128, stderr: 'fatal: boom' } },
])('decides unknown for $name', async ({ answer }) => {
  const { gitFake, run } = await setUp();

  gitFake.answer('rev-parse --verify --quiet refs/remotes/origin/a', answer);

  expect((await run()).layers).toMatchObject([{ status: 'unknown', remoteTip: null }]);
});

it('decides unknown when git log fails', async () => {
  const { gitFake, run } = await setUp();

  gitFake.answer('log --oneline', { code: 128, stderr: 'fatal: bad revision' });

  const { layers } = await run();

  expect(layers).toMatchObject([{ status: 'unknown' }]);
  expect(layers[0]?.reason).toContain('git log --oneline');
});

it('leaves the published facts out of the evidence when the remote tip read fails', async () => {
  const { gitFake, run } = await setUp();

  gitFake.answer('rev-parse --verify --quiet refs/remotes/origin/a', {
    code: 128,
    stderr: 'fatal: boom',
  });

  const { evidence } = await run();

  expect(evidence.layers).toHaveLength(1);
  expect(evidence.layers[0]?.facts).toMatchObject({ remoteTip: { ok: false }, published: null });
});

it('leaves the published facts out of the evidence when the remote branch is missing', async () => {
  const { gitFake, run } = await setUp();

  gitFake.answer('rev-parse --verify --quiet refs/remotes/origin/a', { code: 1 });

  const { evidence } = await run();

  expect(evidence.layers[0]?.facts).toMatchObject({
    remoteTip: { ok: true, value: null },
    published: null,
  });
});

it.each(['abcdef1x', 'abcdef', 'x abcdef1', 'abcdef1\n--all'])(
  'refuses the start tip %j',
  async (startTip) => {
    const { fake } = await setUp();

    const result = createStackTool(fake.exec).execute(
      'call',
      { action: 'history', remote: 'origin', startTips: { a: startTip } },
      undefined,
      undefined,
      noUiContext(process.cwd()),
    );

    await expect(result).rejects.toThrow('must be a commit SHA');
    expect(fake.calls).toEqual([]);
  },
);
