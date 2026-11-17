import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { argumentAfter, createExecFake, succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import improvementExtension from './improvement.js';

const pullRequest = 'https://github.com/sqve/tau/pull/562';
const projectRoot = '/repository/tau';

const sessionContext = (cwd: string) =>
  ({
    cwd,
    hasUI: false,
    ui: { setStatus: () => undefined },
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/one.jsonl',
    },
  }) as unknown as ExtensionToolContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

it('dispatches the history action through the improvement tool', async () => {
  vi.stubEnv('TAU_ROLE', undefined);

  const fake = createExecFake<'git' | 'view' | 'inline'>({
    keyOf: (command, commandArguments) => {
      if (command === 'git') {
        return 'git';
      }

      if (command === 'gh' && commandArguments[0] === 'pr') {
        return 'view';
      }

      if (command === 'gh' && commandArguments[0] === 'api') {
        return 'inline';
      }

      return undefined;
    },
    handlerFor: (key) => {
      const outputs = {
        git: '',
        view: JSON.stringify({
          reviews: [],
          comments: [{ author: { login: 'author' }, body: 'Fixed.' }],
        }),
        inline: JSON.stringify([]),
      };

      return () => succeededResult(outputs[key]);
    },
  });

  const pi = fakeExtensionApi({ exec: fake.exec });

  improvementExtension(pi.pi);
  const tool = pi.tools.get('improvement');

  if (tool === undefined) {
    throw new Error('The manager has no improvement tool.');
  }

  const result = await tool.execute(
    'call-1',
    { action: 'history', projectRoots: [projectRoot], pullRequests: [pullRequest] },
    undefined,
    undefined,
    sessionContext('/work/tau'),
  );

  expect(result.details).toMatchObject({
    reverts: [],
    comments: [{ url: pullRequest, author: 'author', body: 'Fixed.' }],
    coverage: 'complete',
    gaps: [],
  });

  expect(fake.calls.map((call) => [call.command, call.commandArguments])).toEqual([
    ['git', ['-C', projectRoot, 'log', '--since=30.days', '--grep=Revert', '--format=%H%x09%s']],
    ['gh', ['pr', 'view', pullRequest, '--json', 'reviews,comments']],
    ['gh', ['api', 'repos/sqve/tau/pulls/562/comments']],
  ]);

  expect(argumentAfter(fake.calls[0]?.commandArguments ?? [], '-C')).toBe(projectRoot);
});
