import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { noUiContext } from '../../../../tests/toolContext.js';
import { isMissingFile } from '../../../errors.js';
import { createPrFeedbackTool } from '../tool.js';
import type { PrFeedbackInput } from '../tool.js';
import { createGhFake } from './ghFake.js';
import type { FakeThread, GhFake } from './ghFake.js';

type ReadResult = Record<string, unknown> & { directory: string; stateToken: string };

export interface ChecksResult {
  pr: number;
  checks: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
}

interface ToolSetup {
  root: string;
  fake: GhFake;
  read: (input?: Partial<PrFeedbackInput>) => Promise<ReadResult>;
  readChecks: (input?: Partial<PrFeedbackInput>) => Promise<ChecksResult>;
}

export const person = { login: 'reviewer', bot: false };
const bot = { login: 'coderabbitai', bot: true };

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

export const setUp = async (): Promise<ToolSetup> => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();

  const read = async (input: Partial<PrFeedbackInput> = {}) => {
    const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

    const result = await tool.execute(
      'call',
      { action: 'read', repository: 'github.com/sQVe/tau', pr: 7, ...input },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details as ReadResult;
  };

  const readChecks = async (input: Partial<PrFeedbackInput> = {}) => {
    const tool = createPrFeedbackTool(fake.exec, fake.execInGroup);

    const result = await tool.execute(
      'call',
      { action: 'checks', repository: 'github.com/sQVe/tau', pr: 7, head: 'abc123', ...input },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details as unknown as ChecksResult;
  };

  return { root, fake, read, readChecks };
};

export const feedbackDirectories = (root: string): Promise<string[]> =>
  readdir(join(root, '.tau', 'pr-feedback')).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

export const holdFeedback = (fake: GhFake): void => {
  fake.threads = [
    thread({
      id: 'thread-resolved',
      isResolved: true,
      comments: [{ id: 90, author: person, body: 'Fixed already.' }],
    }),
    thread({
      id: 'thread-open',
      line: null,
      isOutdated: true,
      viewerCanResolve: false,
      comments: [
        { id: 101, author: person, body: 'Rename this.' },
        { id: 102, author: { login: 'sqve', bot: false }, body: 'Will do.' },
        { id: 103, author: bot, body: 'Agreed.' },
      ],
    }),
  ];

  fake.reviews = [
    { id: 201, author: bot, state: 'COMMENTED', body: 'Summary of the changes.' },
    { id: 202, author: person, state: 'APPROVED', body: '' },
  ];

  fake.comments = [{ id: 301, author: person, body: 'Can this land today?' }];
};
