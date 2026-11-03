import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import { createPublicationTool, pushFeature } from './fixtures/publicationRepository.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const setUp = (remote = false) => createPublicationTool(onTestFinished, { remote });

it('returns the details as JSON text for the model', async () => {
  const { root, fake } = await setUp();
  const tool = createPrTool(fake.exec);

  const result = await tool.execute(
    'call',
    { action: 'prepare' },
    undefined,
    undefined,
    noUiContext(root),
  );

  const text = result.content.find((item) => item.type === 'text');

  expect(text).toBeDefined();
  expect(JSON.parse(text?.type === 'text' ? text.text : '')).toEqual(result.details);
});

const validated = (tool: ReturnType<typeof createPrTool>, call: unknown) =>
  validateToolArguments(tool, {
    type: 'toolCall',
    id: 'call',
    name: tool.name,
    arguments: call as ToolCall['arguments'],
  }) as PrInput;

it.each([
  { call: {} },
  { call: { action: 'delete' } },
  { call: { action: 'target', remote: {} } },
  { call: { action: 'verify', pr: 'seven' } },
  { call: { action: 'verify', draft: 'yes' } },
])('refuses the arguments $call before anything runs', async ({ call }) => {
  const { root, fake } = await setUp();
  const tool = createPrTool(fake.exec);

  expect(() => validated(tool, call)).toThrow(Error);
  expect(fake.calls).toEqual([]);
  expect(await readdir(root)).not.toContain('.tau');
});

it.each(['prepare', 'target', 'evidence', 'checkHeader', 'reuse', 'verify', 'reviewBots'])(
  'accepts the %s action and passes it on',
  (action) => {
    const tool = createPrTool(createGhFake().exec);

    expect(validated(tool, { action })).toEqual({ action });
  },
);

it('prepares a fresh run directory that Git ignores', async () => {
  const { root, run } = await setUp();

  const first = await run({ action: 'prepare' });
  const second = await run({ action: 'prepare' });
  const directory = String(first['directory']);

  expect(relative(root, directory)).toMatch(/^\.tau\/pr\/run-\w{6}$/u);
  expect(second['directory']).not.toBe(directory);
  expect((await stat(directory)).isDirectory()).toBe(true);
  await expect(git(root, 'check-ignore', '--quiet', join(directory, 'body.md'))).resolves.toBe('');
});

it('returns publication evidence through the tool', async () => {
  const { root, forkPoint, run } = await setUp(true);

  await pushFeature(root);

  const evidence = await run({ action: 'evidence' });

  expect(evidence).toMatchObject({
    target: { mergeBase: forkPoint, head: { branch: 'feature' }, pr: null, closedPrs: [] },
    branch: 'feature',
    subjects: ['feature'],
    reuse: null,
    review: null,
    checks: [],
    gaps: [{ kind: 'noReview' }, { kind: 'fullCheck', status: 'missing' }, { kind: 'noChecks' }],
  });
});
