import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateToolArguments } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished } from 'vitest';

import { succeededResult } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import type { Exec } from '../../command.js';
import { createGhFake, fakePullRequest } from './fixtures/ghFake.js';
import { person, thread } from './fixtures/toolSetup.js';
import type { StatusResult } from './statusDecisions.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

const validatedStatus = (
  tool: ReturnType<typeof createPrFeedbackTool>,
  input: Partial<PrFeedbackInput>,
) =>
  validateToolArguments(tool, {
    type: 'toolCall',
    id: 'call',
    name: tool.name,
    arguments: {
      action: 'status',
      repository: 'github.com/sQVe/tau',
      prs: [{ pr: 7, head: 'abc123' }],
      ...input,
    },
  }) as PrFeedbackInput;

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-status-config-');
  const fake = createGhFake();

  fake.checks = [{ name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: '' }];

  const context = { ...noUiContext(root), isProjectTrusted: () => true };

  const run = async (input: Partial<PrFeedbackInput> = {}, exec: Exec = fake.exec) => {
    const tool = createPrFeedbackTool(exec, fake.execInGroup, { agentDirectory });

    const parameters = validatedStatus(tool, input);
    const result = await tool.execute('call', parameters, undefined, undefined, context);

    return result.details as {
      prs: StatusResult[];
      recommended: number | null;
      attention: number[];
    };
  };

  return { root, agentDirectory, fake, run };
};

const fileContents = async (root: string) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);

      return [path, await readFile(path, 'hex')];
    }),
  );
};

it.each<{ name: string; parameters: PrFeedbackInput; error: string }>([
  {
    name: 'missing repository',
    parameters: { action: 'status', prs: [{ pr: 7, head: 'abc123' }] },
    error: 'status needs repository.',
  },
  {
    name: 'missing prs',
    parameters: { action: 'status', repository: 'github.com/sQVe/tau' },
    error: 'status needs prs ordered bottom to top.',
  },
  {
    name: 'empty prs',
    parameters: { action: 'status', repository: 'github.com/sQVe/tau', prs: [] },
    error: 'status needs prs ordered bottom to top.',
  },
  {
    name: 'whitespace head',
    parameters: {
      action: 'status',
      repository: 'github.com/sQVe/tau',
      prs: [{ pr: 7, head: ' \t\n' }],
    },
    error: 'status needs a nonempty head for each PR.',
  },
])('refuses execution with $name without reads or writes', async ({ parameters, error }) => {
  const { root, agentDirectory, fake } = await setUp();
  const tool = createPrFeedbackTool(fake.exec, fake.execInGroup, { agentDirectory });
  const beforeFiles = await fileContents(root);
  const beforeEntries = await readdir(root);

  await expect(
    tool.execute('call', parameters, undefined, undefined, noUiContext(root)),
  ).rejects.toThrow(error);

  expect(fake.calls).toEqual([]);
  expect(await fileContents(root)).toEqual(beforeFiles);
  expect(await readdir(root)).toEqual(beforeEntries);
});

it('reads a clear snapshot without GitHub writes or filesystem changes', async () => {
  const { root, fake, run } = await setUp();
  const before = await fileContents(root);
  const result = await run();

  expect(result).toMatchObject({
    prs: [{ pr: 7, verdict: 'clear', reasons: [], head: 'abc123', draft: false, gaps: [] }],
    recommended: null,
    attention: [],
  });

  expect(fake.calls.length).toBeGreaterThan(0);

  for (const { command, commandArguments } of fake.calls) {
    expect(command).toBe('gh');
    expect(commandArguments.slice(0, 2)).not.toEqual(['pr', 'comment']);
    expect(commandArguments.slice(0, 2)).not.toEqual(['pr', 'edit']);
    expect(commandArguments.some((argument) => /\bmutation\b/u.test(argument))).toBe(false);

    const methods = commandArguments.flatMap((argument, index) =>
      argument === '--method' || argument === '-X' ? [commandArguments[index + 1]] : [],
    );

    expect(methods.every((method) => method === 'GET')).toBe(true);
  }

  expect(fake.writes).toEqual([]);
  expect(await fileContents(root)).toEqual(before);
  expect(await readdir(root)).not.toContain('.tau');
});

it('keeps unknown mergeability after settling', async () => {
  const { fake, run } = await setUp();

  fake.pullRequest = { ...fakePullRequest(), mergeable: 'UNKNOWN' };

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'unknown',
    reasons: [{ code: 'mergeabilityUnknown' }],
    mergeable: 'UNKNOWN',
  });
});

it('settles unknown mergeability before deciding', async () => {
  const { fake, run } = await setUp();

  fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];

  expect((await run()).prs[0]).toMatchObject({ verdict: 'clear', mergeable: 'MERGEABLE' });
});

it('keeps known action reasons alongside a partial read gap', async () => {
  const { fake, run } = await setUp();

  fake.threads = [
    thread({ id: 'open' }),
    thread({ id: 'resolved', isResolved: true }),
    thread({
      id: 'viewer',
      comments: [{ id: 103, author: { login: fake.viewer, bot: false }, body: 'Note' }],
    }),
  ];

  fake.failCommand('reviews');

  const result = (await run()).prs[0];

  expect(result).toMatchObject({
    verdict: 'action-required',
    reasons: [{ code: 'unresolvedThreads', count: 1 }, { code: 'readGap' }],
  });

  expect(result?.gaps).toEqual([expect.stringContaining('reviews')]);
});

it('reports unread threads instead of counting a partial conversation', async () => {
  const { fake, run } = await setUp();

  fake.threads = [thread({ id: 'long', hasMoreComments: true })];

  const result = (await run()).prs[0];

  expect(result).toMatchObject({ verdict: 'unknown', reasons: [{ code: 'readGap' }] });
  expect(result?.gaps).toEqual([expect.stringContaining('too long to read')]);
});

it.each([
  ['pr checks', 'printed no output'],
  ['graphql', 'HTTP 502'],
  ['user', 'HTTP 502'],
] as const)('reports unread evidence from %s as a gap', async (source, cause) => {
  const { fake, run } = await setUp();

  fake.failCommand(source);

  const result = (await run()).prs[0];

  expect(result).toMatchObject({ verdict: 'unknown', reasons: [{ code: 'readGap' }] });
  expect(result?.gaps).toEqual([expect.stringContaining(cause)]);
});

it('reports unread bot configuration as a gap', async () => {
  const { agentDirectory, run } = await setUp();

  await writeFile(join(agentDirectory, 'tau.json'), '{');

  const result = (await run()).prs[0];

  expect(result).toMatchObject({ verdict: 'unknown', reasons: [{ code: 'readGap' }] });
  expect(result?.gaps).toEqual([expect.stringContaining('not valid JSON')]);
});

it('reports a failed final PR read as a gap', async () => {
  const { fake, run } = await setUp();
  let reads = 0;

  const exec: Exec = (command, commandArguments, options) => {
    if (commandArguments[1] === 'view') {
      reads += 1;
    }

    if (reads === 4) {
      fake.failCommand('pr view');
    }

    return fake.exec(command, commandArguments, options);
  };

  const result = (await run({}, exec)).prs[0];

  expect(result).toMatchObject({
    verdict: 'unknown',
    head: 'abc123',
    reasons: [{ code: 'readGap' }],
  });

  expect(result?.gaps).toEqual([expect.stringContaining('HTTP 502')]);
});

it('reports failed PR reads and still reads the rest of the stack', async () => {
  const { fake, run } = await setUp();
  const failed = createGhFake();

  failed.failCommand('pr view');

  const exec: Exec = (command, commandArguments, options) =>
    commandArguments[2] === '8'
      ? failed.exec(command, commandArguments, options)
      : fake.exec(command, commandArguments, options);

  const result = await run(
    {
      prs: [
        { pr: 8, head: 'unread-head' },
        { pr: 7, head: 'abc123' },
      ],
    },
    exec,
  );

  expect(result.prs).toMatchObject([
    { pr: 8, verdict: 'unknown', head: 'unread-head', gaps: [expect.stringContaining('pr view')] },
    { pr: 7, verdict: 'clear' },
  ]);

  expect(result.recommended).toBe(8);
});

it('stops after an initial head mismatch', async () => {
  const { fake, run } = await setUp();

  fake.nextHeads = ['other'];

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'unknown',
    head: 'other',
    reasons: [{ code: 'headMoved' }],
  });

  expect(fake.calls.map((call) => call.commandArguments.slice(0, 2))).toEqual([['pr', 'view']]);
});

it.each([
  { name: 'checks head guard', heads: ['abc123', 'other'] },
  { name: 'final read', heads: ['abc123', 'abc123', 'abc123', 'other'] },
])('reports a head that moves at the $name', async ({ heads }) => {
  const { fake, run } = await setUp();

  fake.nextHeads = heads;

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'unknown',
    head: 'other',
    reasons: [{ code: 'headMoved' }],
  });
});

it('keeps a head mismatch when the head returns before the final read', async () => {
  const { fake, run } = await setUp();

  fake.nextHeads = ['abc123', 'other', 'abc123'];

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'unknown',
    head: 'abc123',
    reasons: [{ code: 'headMoved' }],
  });
});

it('reports a head that moves while mergeability settles', async () => {
  const { fake, run } = await setUp();

  fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];
  fake.nextHeads = ['abc123', 'other', 'abc123'];

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'unknown',
    head: 'abc123',
    reasons: [{ code: 'headMoved' }],
  });
});

it.each([
  { state: 'CLOSED', verdict: 'unknown', code: 'closed' },
  { state: 'MERGED', verdict: 'clear', code: 'merged' },
])('reads only PR metadata for $state', async ({ state, verdict, code }) => {
  const { fake, run } = await setUp();

  fake.pullRequest = { ...fakePullRequest(), state };

  expect((await run()).prs[0]).toMatchObject({ verdict, reasons: [{ code }] });
  expect(fake.calls.map((call) => call.commandArguments.slice(0, 2))).toEqual([['pr', 'view']]);
});

it('returns waiting checks and waiting human outcomes', async () => {
  const { fake, run } = await setUp();

  fake.checks = [{ name: 'test', workflow: 'CI', bucket: 'pending', state: 'PENDING', link: '' }];

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'waiting-checks',
    reasons: [{ code: 'pendingChecks', names: ['test'] }],
  });

  fake.checks = [{ name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: '' }];
  fake.pullRequest = { ...fakePullRequest(), isDraft: true };

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'waiting-human',
    draft: true,
    reasons: [{ code: 'draft' }],
  });
});

it('uses configured bots without requesting reviews', async () => {
  const { fake, agentDirectory, run } = await setUp();

  await writeFile(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({
      reviews: {
        repositories: {
          'sQVe/tau': { bots: [{ login: 'custom-reviewer', comment: 'Review please' }] },
        },
      },
    }),
  );

  const exec: Exec = (command, commandArguments, options) => {
    if (commandArguments.includes('headRefOid,reviews,comments')) {
      return Promise.resolve(
        succeededResult(
          JSON.stringify({
            headRefOid: 'abc123',
            reviews: [],
            comments: [{ body: 'Review please', createdAt: '2026-10-15T10:00:00Z' }],
          }),
        ),
      );
    }

    if (commandArguments.some((argument) => argument.includes('/commits/'))) {
      return Promise.resolve(succeededResult('2026-10-14T10:00:00Z'));
    }

    return fake.exec(command, commandArguments, options);
  };

  expect((await run({}, exec)).prs[0]).toMatchObject({
    verdict: 'waiting-checks',
    reasons: [{ code: 'botReviewPending', logins: ['custom-reviewer'] }],
  });

  expect(fake.writes).toEqual([]);
});

it('keeps a latest changes-requested review even when its body is empty', async () => {
  const { fake, run } = await setUp();

  fake.reviews = [{ id: 1, author: person, body: '', state: 'CHANGES_REQUESTED' }];

  expect((await run()).prs[0]).toMatchObject({
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: [person.login] }],
  });
});
