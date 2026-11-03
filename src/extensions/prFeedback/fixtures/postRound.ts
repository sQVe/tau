import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { confirmContext, noUiContext } from '../../../../tests/toolContext.js';
import type { Exec } from '../../../command.js';
import { isMissingFile } from '../../../errors.js';
import type { PostedWrite } from '../replies.js';
import { createPrFeedbackTool } from '../tool.js';
import type { PrFeedbackInput } from '../tool.js';
import { createGhFake, groupExecOf } from './ghFake.js';
import type { FakeThread, GhFake } from './ghFake.js';

interface ReadDetails {
  directory: string;
  stateToken: string;
  pr: { headRefOid: string };
}

type PrFeedbackTool = ReturnType<typeof createPrFeedbackTool>;

interface PausedSession {
  tool: PrFeedbackTool;
  entered: Promise<undefined>;
  open: () => void;
}

interface RoundSetUp {
  root: string;
  fake: GhFake;
  read: () => Promise<ReadDetails>;
  post: (
    details: ReadDetails,
    context?: ExtensionToolContext,
    input?: Partial<PrFeedbackInput>,
    session?: PrFeedbackTool,
  ) => Promise<unknown>;
}

interface Confirmation {
  context: ExtensionToolContext;
  prompts: { title: string; message: string }[];
}

export const person = { login: 'reviewer', bot: false };
export const bot = { login: 'coderabbitai', bot: true };

export const thread = (overrides: Partial<FakeThread> & { id: string }): FakeThread => ({
  path: 'src/tau.ts',
  line: 12,
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  hasMoreComments: false,
  comments: [{ id: 101, author: person, body: 'Rename this.' }],
  ...overrides,
});

const run = async (
  session: PrFeedbackTool,
  input: PrFeedbackInput,
  context: ExtensionToolContext,
) => {
  const result = await session.execute('call', input, undefined, undefined, context);

  return result.details;
};

export const pausedSession = (fake: GhFake): PausedSession => {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  let paused = false;

  const exec: Exec = async (command, commandArguments, options) => {
    if (!paused && commandArguments.includes('POST')) {
      paused = true;
      entered.resolve(undefined);
      await gate.promise;
    }

    return fake.exec(command, commandArguments, options);
  };

  return {
    tool: createPrFeedbackTool(
      exec,
      groupExecOf(exec, () => fake.commandGroup),
    ),
    entered: entered.promise,
    open: () => {
      gate.resolve(undefined);
    },
  };
};

export const setUp = async (): Promise<RoundSetUp> => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();
  const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

  const read = async () =>
    (await run(
      tool,
      { action: 'read', repository: 'github.com/sQVe/tau', pr: 7 },
      noUiContext(root),
    )) as unknown as ReadDetails;

  const post = (
    details: ReadDetails,
    context: ExtensionToolContext = noUiContext(root),
    input: Partial<PrFeedbackInput> = {},
    session = tool,
  ) =>
    run(
      session,
      {
        action: 'post',
        directory: details.directory,
        stateToken: details.stateToken,
        head: details.pr.headRefOid,
        ...input,
      },
      context,
    );

  return { root, fake, read, post };
};

export const writeReplies = (directory: string, replies: unknown): Promise<void> =>
  writeFile(join(directory, 'replies.json'), JSON.stringify(replies));

export const snapshotRound = async (directory: string): Promise<string[][]> => {
  const names = await readdir(directory);

  return Promise.all(
    names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );
};

export const readPosted = (directory: string): Promise<unknown> =>
  readFile(join(directory, 'posted.json'), 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    (error: unknown) => {
      if (isMissingFile(error)) {
        return undefined;
      }

      throw error;
    },
  );

export const personThread = (): FakeThread =>
  thread({ id: 'thread-person', comments: [{ id: 101, author: person, body: 'Rename this.' }] });

export const botThread = (): FakeThread =>
  thread({ id: 'thread-bot', comments: [{ id: 201, author: bot, body: 'Add a test.' }] });

export const replyTo = (
  id: string,
  reply: string | null,
  resolve = true,
): { id: string; reply: string | null; resolve: boolean } => ({
  id,
  reply,
  resolve,
});

export const recordingConfirm = (
  root: string,
  answer: boolean,
  during?: () => void | Promise<void>,
): Confirmation => {
  const prompts: { title: string; message: string }[] = [];

  const context = confirmContext(root, async (title, message): Promise<boolean> => {
    prompts.push({ title, message });
    await during?.();

    return answer;
  });

  return { context, prompts };
};

export const mixedReplies = {
  version: 1,
  threads: [replyTo('thread-bot', 'Added.'), replyTo('thread-person', 'Renamed.', false)],
  comment: null,
};

const threadCommentIds = { 'thread-person': 101, 'thread-bot': 201 };

type FixtureThreadId = keyof typeof threadCommentIds;

const threadUrl = (threadId: FixtureThreadId) =>
  `https://github.com/sQVe/tau/pull/7#discussion_r${threadCommentIds[threadId]}`;

export const recordedReply = (
  threadId: FixtureThreadId,
  text: string,
  commentId: number | null,
): PostedWrite => ({
  kind: 'reply',
  thread: threadId,
  url: threadUrl(threadId),
  text,
  state: 'posted',
  commentId,
  earlierCommentIds: [],
});

export const recordedResolve = (threadId: FixtureThreadId): PostedWrite => ({
  kind: 'resolve',
  thread: threadId,
  url: threadUrl(threadId),
  text: null,
  state: 'posted',
  commentId: null,
  earlierCommentIds: [],
});

export const postFailure = (promise: Promise<unknown>): Promise<Error | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
