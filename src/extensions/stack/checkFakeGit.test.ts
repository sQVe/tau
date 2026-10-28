import { expect, it } from 'vitest';

import { installCommandShim } from '../../../tests/commandShimFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createStackFake } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

const setUp = async () => {
  const gitFake = await installCommandShim('git', { otherCalls: 'fail' });
  const fake = createStackFake();

  gitFake.answer({ prefix: 'symbolic-ref --quiet --short HEAD', stdout: 'feature\n' });

  const run = async () => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      { action: 'check' },
      undefined,
      undefined,
      noUiContext(process.cwd()),
    );

    return result.details;
  };

  return { gitFake, fake, run };
};

it.each([
  {
    name: 'a failing command',
    answer: { code: 128, stderr: 'fatal: boom\n' },
    detail: 'fatal: boom',
  },
  {
    name: 'a failing command that printed a path',
    answer: { code: 128, stdout: '/tmp/elsewhere\n', stderr: 'fatal: boom\n' },
    detail: 'fatal: boom',
  },
  { name: 'empty output', answer: { stdout: '\n', stderr: 'nothing\n' }, detail: 'nothing' },
])('decides unknown, with no facts, for $name from git rev-parse', async ({ answer, detail }) => {
  const { gitFake, fake, run } = await setUp();

  gitFake.answer({ prefix: 'rev-parse --absolute-git-dir', ...answer });

  expect(await run()).toMatchObject({
    result: 'unknown',
    reason: `git rev-parse --absolute-git-dir failed: ${detail}`,
    branch: 'feature',
    evidence: { current: null, resolved: null, github: null },
  });

  expect(fake.calls).toEqual([]);
});
