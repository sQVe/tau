import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository, runCommand } from '../../../tests/commitTool.js';
import { reviewComments, reviewGit } from './commentReview.js';

describe('reviewGit', () => {
  it('identifies the failing command after global Git options', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await expect(
      reviewGit(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        repositoryDirectory,
        ['--literal-pathspecs', 'ls-tree', 'missing-tree'],
      ),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});

it.each([
  ['file', 'Comment review input is too large: file.ts. Reduce the file and retry.'],
  ['count', 'Comment review input is too large: 301 files. Split the commit and retry.'],
  ['payload', 'Comment review input is too large. Split the commit and retry.'],
])('rejects oversized %s input without offering a waiver', async (limit, diagnostic) => {
  const exec = vi.fn<ExtensionAPI['exec']>(async (_command, arguments_) => {
    let stdout = '';

    if (arguments_.includes('--name-only')) {
      stdout =
        limit === 'count'
          ? Array.from({ length: 301 }, (_, index) => `${index}.ts\0`).join('')
          : 'file.ts\0';
    } else if (arguments_.includes('ls-tree') && arguments_.at(-1) === 'file.ts') {
      stdout = `100644 blob hash ${limit === 'file' ? 400_001 : 0}\tfile.ts\0`;
    } else if (arguments_[0] === 'diff' && !arguments_.includes('--numstat')) {
      stdout = limit === 'payload' ? 'x'.repeat(1_000_001) : '';
    }

    return { stdout, stderr: '', code: 0, killed: false };
  });
  const getApiKeyAndHeaders = vi.fn<() => never>(() => {
    throw new Error('Oversized input must fail before authentication');
  });
  const context = {
    cwd: '/repo',
    model: { api: 'openai-completions' },
    modelRegistry: { getApiKeyAndHeaders },
  } as unknown as ExtensionContext;

  await expect(
    reviewComments({ exec }, context, undefined, { tree: 'candidate', head: 'base' }),
  ).rejects.toThrow(new Error(diagnostic));

  expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
});
