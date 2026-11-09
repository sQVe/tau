import type { ToolCall } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { feedbackDirectories, holdFeedback, setUp } from './fixtures/toolSetup.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

describe('read arguments', () => {
  it.each([
    { repository: 'sQVe/tau', pr: 7, error: 'repository must be <host>/<owner>/<name>' },
    { repository: 'github.com/sQVe/tau/pulls', pr: 7, error: 'repository must be' },
    { repository: 'github.com/sQVe/tau', pr: 0, error: 'pr must be a pull request number' },
    { repository: 'github.com/sQVe/tau', pr: 1.5, error: 'pr must be a pull request number' },
  ])('rejects repository $repository with pr $pr', async ({ repository, pr, error }) => {
    const { root, fake, read } = await setUp();

    await expect(read({ repository, pr })).rejects.toThrow(error);
    expect(fake.calls).toEqual([]);
    expect(await feedbackDirectories(root)).toEqual([]);
  });
});

const threadPage = (node: unknown) => [
  { data: { repository: { pullRequest: { reviewThreads: { nodes: [node] } } } } },
];

describe('read output of the wrong shape', () => {
  const author = { login: 'reviewer', typename: 'User' };

  const threadNode = (change: Record<string, unknown> = {}) => ({
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    path: 'src/tau.ts',
    line: 12,
    viewerCanReply: true,
    viewerCanResolve: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          databaseId: 101,
          author,
          body: 'Rename this.',
          url: 'u',
          createdAt: 'c',
          updatedAt: 'u',
        },
      ],
    },
    ...change,
  });

  // Every field gh pr view prints for read, so a case that changes one field fails only on it.
  const pullRequest = {
    number: 7,
    url: 'https://github.com/sQVe/tau/pull/7',
    state: 'OPEN',
    author: { login: 'sqve' },
    headRefOid: 'abc123',
    baseRefName: 'main',
    headRefName: 'feature',
    headRepository: { name: 'tau' },
    headRepositoryOwner: { login: 'sQVe' },
    isCrossRepository: false,
    maintainerCanModify: false,
    mergeable: 'MERGEABLE',
  };

  it('accepts the complete pr view output', async () => {
    const { fake, read } = await setUp();

    fake.overrideOutput('pr view', JSON.stringify(pullRequest));

    expect((await read()).pr).toEqual(expect.objectContaining({ author: 'sqve' }));
  });

  it('refuses a pr view output whose author has no login', async () => {
    const { root, fake, read } = await setUp();

    fake.overrideOutput('pr view', JSON.stringify({ ...pullRequest, author: {} }));

    await expect(read()).rejects.toThrow(/printed unexpected output: \/author /u);
    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it.each([
    { key: 'user' as const, output: {} },
    { key: 'pr view' as const, output: {} },
    { key: 'graphql' as const, output: threadPage(threadNode({ comments: { nodes: [] } })) },
    {
      key: 'graphql' as const,
      output: threadPage(
        threadNode({
          comments: {
            pageInfo: {},
            nodes: [
              {
                databaseId: 101,
                author,
                body: 'b',
                url: 'u',
                createdAt: 'c',
                updatedAt: 'u',
              },
            ],
          },
        }),
      ),
    },
    {
      key: 'graphql' as const,
      output: threadPage(
        threadNode({
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                databaseId: 101,
                author: {},
                body: 'b',
                url: 'u',
                createdAt: 'c',
                updatedAt: 'u',
              },
            ],
          },
        }),
      ),
    },
    { key: 'reviews' as const, output: [[{}]] },
    {
      key: 'reviews' as const,
      output: [[{ id: 1, user: {}, state: 'COMMENTED', body: 'b', html_url: 'u' }]],
    },
    { key: 'comments' as const, output: [[{ id: 1, user: {}, body: 'b', html_url: 'u' }]] },
  ])('refuses the $key output $output and creates no directory', async ({ key, output }) => {
    const { root, fake, read } = await setUp();

    holdFeedback(fake);
    fake.overrideOutput(key, JSON.stringify(output));

    await expect(read()).rejects.toThrow('printed unexpected output');
    expect(await feedbackDirectories(root)).toEqual([]);
  });
});

const validated = (tool: ReturnType<typeof createPrFeedbackTool>, call: unknown) =>
  validateToolArguments(tool, {
    type: 'toolCall',
    id: 'call',
    name: tool.name,
    arguments: call as ToolCall['arguments'],
  }) as PrFeedbackInput;

describe('tool arguments', () => {
  it.each([
    { call: {} },
    { call: { action: 'merge' } },
    { call: { action: 'read', repository: 'github.com/sQVe/tau', pr: 0 } },
    { call: { action: 'read', repository: {}, pr: 7 } },
    { call: { action: 'post', directory: {} } },
    { call: { action: 'post', stateToken: [] } },
    { call: { action: 'checks', head: {} } },
  ])('refuses the arguments $call before anything runs', async ({ call }) => {
    const { root, fake } = await setUp();
    const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

    expect(() => validated(tool, call)).toThrow(Error);
    expect(fake.calls).toEqual([]);
    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it('accepts the arguments of a read and runs it', async () => {
    const { root, fake } = await setUp();
    const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

    const parameters = validated(tool, {
      action: 'read',
      repository: 'github.com/sQVe/tau',
      pr: 7,
    });

    await tool.execute('call', parameters, undefined, undefined, noUiContext(root));

    expect(await feedbackDirectories(root)).toHaveLength(1);
  });
});
