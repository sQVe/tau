import { describe, expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import {
  bot,
  botThread,
  personThread,
  postFailure,
  readPosted,
  recordedWrite,
  recordingConfirm,
  replyTo,
  setUp,
  thread,
  writeReplies,
} from './fixtures/postRound.js';
import { createPrFeedbackTool } from './tool.js';

interface ReadDetails {
  directory: string;
  stateToken: string;
  pr: { headRefOid: string };
}

type Category = 'uncertain' | 'posted' | 'notPosted';

const writeOutputFixture = async () => {
  const context = await setUp();

  context.fake.threads = [botThread()];
  context.fake.comments = [{ id: 302, author: bot, body: 'Summary.' }];

  const details = await context.read();

  await writeReplies(details.directory, {
    version: 1,
    threads: [replyTo('thread-bot', 'Added.')],
    comment: { body: 'Done.', answers: ['302'] },
  });

  return { ...context, details };
};

const failureReportFixture = async () => {
  const context = await setUp();

  context.fake.threads = [
    botThread(),
    thread({ id: 'thread-bot-2', comments: [{ id: 202, author: bot, body: 'Fix.' }] }),
  ];

  context.fake.comments = [{ id: 302, author: bot, body: 'Summary.' }];

  const details = await context.read();

  await writeReplies(details.directory, {
    version: 1,
    threads: [replyTo('thread-bot', 'Added.', false), replyTo('thread-bot-2', null)],
    comment: { body: 'Done.', answers: ['302'] },
  });

  return { ...context, details };
};

describe('post', () => {
  it('posts writes to bots without asking and records them', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [botThread()];
    fake.reviews = [{ id: 401, author: bot, state: 'COMMENTED', body: 'Summary.' }];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: { body: 'Addressed the summary.', answers: ['401'] },
    });

    const { context, prompts } = recordingConfirm(root, false);
    const result = await post(details, context);

    expect(prompts).toEqual([]);

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 201, body: 'Added.' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'comment', body: 'Addressed the summary.' },
    ]);

    expect(result).toMatchObject({
      status: 'posted',
      posted: [
        { kind: 'reply', thread: 'thread-bot', text: 'Added.', commentId: 1000 },
        { kind: 'resolve', thread: 'thread-bot', text: null, commentId: null },
        { kind: 'comment', thread: null, text: 'Addressed the summary.', commentId: 1001 },
      ],
      skipped: [],
    });

    expect(await readPosted(details.directory)).toEqual({
      version: 2,
      writes: (result as { posted: unknown[] }).posted,
    });
  });

  it('passes --hostname and the pull request to every write', async () => {
    const { root, fake } = await setUp();
    const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

    fake.threads = [botThread()];

    const readResult = await tool.execute(
      'call',
      { action: 'read', repository: 'ghe.example.com/sQVe/tau', pr: 7 },
      undefined,
      undefined,
      noUiContext(root),
    );

    const details = readResult.details as unknown as ReadDetails;

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-bot', 'Added.')],
      comment: { body: 'Done.', answers: [] },
    });

    await tool.execute(
      'call',
      {
        action: 'post',
        directory: details.directory,
        stateToken: details.stateToken,
        head: details.pr.headRefOid,
      },
      undefined,
      undefined,
      recordingConfirm(root, true).context,
    );

    const writeCalls = fake.calls.slice(-3).map((call) => call.commandArguments);

    expect(writeCalls).toEqual([
      [
        'api',
        '--hostname',
        'ghe.example.com',
        '-X',
        'POST',
        'repos/sQVe/tau/pulls/7/comments/201/replies',
        '-f',
        'body=Added.',
      ],
      [
        'api',
        'graphql',
        '--hostname',
        'ghe.example.com',
        '-f',
        'query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }',
        '-F',
        'id=thread-bot',
      ],
      [
        'api',
        '--hostname',
        'ghe.example.com',
        '-X',
        'POST',
        'repos/sQVe/tau/issues/7/comments',
        '-f',
        'body=Done.',
      ],
    ]);
  });

  it('retries a failed post with only the missing writes', async () => {
    const { root, fake, read, post } = await setUp();

    fake.threads = [personThread(), botThread()];

    const details = await read();

    await writeReplies(details.directory, {
      version: 1,
      threads: [replyTo('thread-person', 'Renamed.'), replyTo('thread-bot', null)],
      comment: { body: 'Thanks.', answers: [] },
    });

    fake.failWrite(2);

    const failure = await postFailure(post(details, recordingConfirm(root, true).context));

    expect(failure?.message).toContain('HTTP 502');

    expect(fake.writes).toEqual([{ kind: 'reply', replyTo: 101, body: 'Renamed.' }]);

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [
        { kind: 'reply', thread: 'thread-person', state: 'posted', commentId: 1000 },
        { kind: 'resolve', thread: 'thread-person', state: 'uncertain' },
      ],
    });

    const retry = await post(details, recordingConfirm(root, true).context);

    expect(fake.writes).toEqual([
      { kind: 'reply', replyTo: 101, body: 'Renamed.' },
      { kind: 'resolve', threadId: 'thread-person' },
      { kind: 'resolve', threadId: 'thread-bot' },
      { kind: 'comment', body: 'Thanks.' },
    ]);

    expect(retry).toMatchObject({
      status: 'posted',
      posted: [
        { kind: 'resolve', thread: 'thread-person' },
        { kind: 'resolve', thread: 'thread-bot' },
        { kind: 'comment' },
      ],
      skipped: [{ kind: 'reply', thread: 'thread-person' }],
    });

    const again = await post(details, recordingConfirm(root, true).context);

    expect(again).toMatchObject({ status: 'unchanged', posted: [] });
    expect(fake.writes).toHaveLength(4);
  });
});

describe('post write output', () => {
  const writeFixture = writeOutputFixture;

  const kinds = [
    { key: 'reply' as const, index: 0, missing: '{"html_url": "u"}' },
    { key: 'resolve' as const, index: 1, missing: '{"data": {}}' },
    { key: 'issue comment' as const, index: 2, missing: '{}' },
  ];

  const writeKinds = ['reply', 'resolve', 'comment'];

  const expectedWrites = [
    { kind: 'reply', replyTo: 201, body: 'Added.' },
    { kind: 'resolve', threadId: 'thread-bot' },
    { kind: 'comment', body: 'Done.' },
  ];

  const expectedRecords = [
    recordedWrite('reply', 'thread-bot', 'Added.', 1000),
    recordedWrite('resolve', 'thread-bot', null, null),
    {
      kind: 'comment',
      thread: null,
      url: 'https://github.com/sQVe/tau/pull/7',
      text: 'Done.',
      state: 'posted',
      commentId: 1001,
      earlierCommentIds: [],
    },
  ];

  it.each(
    kinds.flatMap((kind) => [
      { ...kind, output: 'Bad credentials', problem: 'printed output that is not JSON' },
      { ...kind, output: '', problem: 'printed output that is not JSON' },
      { ...kind, output: kind.missing, problem: 'printed unexpected output' },
    ]),
  )(
    'records a $key whose output gh printed as "$output" as posted, then stops',
    async ({ key, index, output, problem }) => {
      const { root, fake, details, post } = await writeFixture();

      fake.overrideOutput(key, output);

      const failure = await postFailure(post(details));
      const saved = (await readPosted(details.directory)) as { version: number; writes: unknown[] };

      const posted = structuredClone(expectedRecords.slice(0, index + 1));

      posted[index]!.commentId = null;

      expect(failure?.message).toContain(problem);
      expect(saved.writes).toHaveLength(index + 1);
      expect(saved.writes.at(-1)).toMatchObject({ kind: writeKinds[index], commentId: null });

      expect(fake.writes).toEqual(expectedWrites.slice(0, index + 1));

      expect(fake.writes).toHaveLength(index + 1);

      expect(saved.version).toBe(2);

      expect(saved.writes).toEqual(posted);

      await post(details, recordingConfirm(root, true).context);

      expect(fake.writes).toEqual(expectedWrites);
    },
  );

  it.each(kinds)('records a failed $key command as uncertain', async ({ key, index }) => {
    const { fake, details, post } = await writeFixture();

    fake.failCommand(key);

    const failure = await postFailure(post(details));

    expect(failure?.message).toContain('HTTP 502');
    expect(fake.writes).toEqual(expectedWrites.slice(0, index));

    expect(await readPosted(details.directory)).toMatchObject({
      writes: [
        ...expectedRecords.slice(0, index),
        { kind: writeKinds[index], state: 'uncertain', commentId: null },
      ],
    });

    expect(fake.writes).toHaveLength(index);
  });
});

const categoriesOf = (message: string | undefined, markers: Record<string, string>) => {
  const sections: Record<Category, string[]> = { uncertain: [], posted: [], notPosted: [] };
  let current: Category | undefined;

  for (const line of (message ?? '').split('\n')) {
    if (/^Uncertain\b/u.test(line)) {
      current = 'uncertain';
    } else if (/^Posted\b/u.test(line)) {
      current = 'posted';
    } else if (/^Not posted\b/u.test(line)) {
      current = 'notPosted';
    } else if (current !== undefined) {
      sections[current].push(line);
    }
  }

  return Object.fromEntries(
    Object.entries(markers).map(([name, marker]) => {
      const found = (Object.keys(sections) as Category[]).filter((category) =>
        sections[category].some((line) => line.includes(marker)),
      );

      return [name, found];
    }),
  );
};

describe('post failure report', () => {
  const markers = { reply: 'discussion_r201', resolve: 'discussion_r202', comment: 'Done.' };
  const order = ['reply', 'resolve', 'comment'];

  const writeFixture = failureReportFixture;

  const expected = (category: Category, failing: number, failingCategory: Category) =>
    Object.fromEntries(
      order.map((name, index) => {
        if (index === failing) {
          return [name, [failingCategory]];
        }

        return [name, [index < failing ? 'posted' : category]];
      }),
    );

  it.each([
    { key: 'reply' as const, index: 0 },
    { key: 'resolve' as const, index: 1 },
    { key: 'issue comment' as const, index: 2 },
  ])('puts each write in its category around an uncertain $key', async ({ key, index }) => {
    const { fake, details, post } = await writeFixture();

    fake.failCommand(key);

    const failure = await postFailure(post(details));

    expect(categoriesOf(failure?.message, markers)).toEqual(
      expected('notPosted', index, 'uncertain'),
    );
  });

  it.each([
    { key: 'reply' as const, index: 0, output: '{"html_url": "u"}' },
    { key: 'resolve' as const, index: 1, output: '{"data": {}}' },
    { key: 'issue comment' as const, index: 2, output: '{}' },
  ])(
    'puts each write in its category around a $key whose output is unreadable',
    async ({ key, index, output }) => {
      const { fake, details, post } = await writeFixture();

      fake.overrideOutput(key, output);

      const failure = await postFailure(post(details));

      expect(categoriesOf(failure?.message, markers)).toEqual(
        expected('notPosted', index, 'posted'),
      );
    },
  );

  it.each([
    { output: '{"data": {"resolveReviewThread": {}}}' },
    { output: '{"data": {"resolveReviewThread": {"thread": {}}}}' },
  ])('records a resolve whose output is $output as posted', async ({ output }) => {
    const { fake, details, post } = await writeFixture();

    fake.overrideOutput('resolve', output);

    const failure = await postFailure(post(details));
    const saved = (await readPosted(details.directory)) as { writes: { kind: string }[] };

    expect(categoriesOf(failure?.message, markers)).toEqual(expected('notPosted', 1, 'posted'));
    expect(saved.writes.map((write) => write.kind)).toEqual(['reply', 'resolve']);
  });

  it('records a resolve that GitHub reports unresolved as not posted', async () => {
    const { fake, details, post } = await writeFixture();

    fake.overrideOutput(
      'resolve',
      JSON.stringify({
        data: { resolveReviewThread: { thread: { isResolved: false } } },
      }),
    );

    const failure = await postFailure(post(details));

    const saved = (await readPosted(details.directory)) as {
      writes: { kind: string }[];
    };

    expect(categoriesOf(failure?.message, markers)).toEqual({
      reply: ['posted'],
      resolve: ['notPosted'],
      comment: ['notPosted'],
    });

    expect(saved.writes.map((write) => write.kind)).toEqual(['reply']);
  });
});
