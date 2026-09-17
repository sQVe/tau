import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository, runCommand } from '../../../tests/commitTool.js';
import { reviewComments, reviewGit } from './commentReview.js';

afterEach(() => vi.unstubAllEnvs());

const reviewFixture = () => {
  const delegate = fauxProvider({ provider: 'delegate' }).getModel();
  const sessionModel = fauxProvider({ provider: 'session' }).getModel();
  const find = vi.fn<ExtensionContext['modelRegistry']['find']>().mockReturnValue(delegate);
  const getApiKeyAndHeaders = vi
    .fn<ExtensionContext['modelRegistry']['getApiKeyAndHeaders']>()
    .mockResolvedValue({ ok: true, apiKey: 'test' });
  const complete = vi
    .fn<ExtensionContext['modelRegistry']['complete']>()
    .mockResolvedValue(fauxAssistantMessage('{"findings":[]}'));
  const exec = vi.fn<ExtensionAPI['exec']>(async (_command, arguments_) => {
    let stdout = '';

    if (arguments_.includes('--name-only')) {
      stdout = 'file.ts\0';
    } else if (arguments_.includes('ls-tree') && arguments_.at(-1) === 'file.ts') {
      stdout = '100644 blob hash 20\tfile.ts\0';
    } else if (arguments_[0] === 'cat-file') {
      stdout = '// Existing comment.\nexport const value = 1;\n';
    }

    return { stdout, stderr: '', code: 0, killed: false };
  });
  const context = {
    cwd: '/repo',
    model: sessionModel,
    modelRegistry: { find, getApiKeyAndHeaders, complete },
  } as unknown as ExtensionContext;
  const execute = (signal?: AbortSignal) =>
    reviewComments({ exec }, context, signal, { tree: 'candidate', head: 'base' });

  return { delegate, sessionModel, context, find, getApiKeyAndHeaders, complete, exec, execute };
};

it('reviews with the shared delegate without changing the session model', async () => {
  vi.stubEnv('TAU_DELEGATE_MODEL', 'delegate/vendor/model');
  const app = reviewFixture();

  await app.execute();

  expect(app.find).toHaveBeenCalledWith('delegate', 'vendor/model');
  expect(app.getApiKeyAndHeaders).toHaveBeenCalledWith(app.delegate);
  expect(app.complete).toHaveBeenCalledWith(app.delegate, expect.anything(), expect.anything());
  expect(app.context.model).toBe(app.sessionModel);
});

it.each(['invalid', 'missing', 'authentication', 'provider'] as const)(
  'rejects delegate %s failures without using the session model',
  async (failure) => {
    vi.stubEnv('TAU_DELEGATE_MODEL', failure === 'invalid' ? 'invalid' : 'delegate/model');
    const app = reviewFixture();

    if (failure === 'missing') {
      app.find.mockReturnValue(undefined);
    } else if (failure === 'authentication') {
      app.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: 'credentials expired' });
    } else if (failure === 'provider') {
      app.complete.mockRejectedValue(new Error('provider unavailable'));
    }

    const diagnostic = {
      invalid: 'Invalid delegate model',
      missing: 'model not found',
      authentication: 'credentials expired',
      provider: 'provider unavailable',
    }[failure];

    await expect(app.execute()).rejects.toThrow(diagnostic);

    expect(app.complete.mock.calls.every(([model]) => model === app.delegate)).toBe(true);
    expect(app.complete).toHaveBeenCalledTimes(failure === 'provider' ? 1 : 0);
  },
);

it.each(['invalid', 'missing'] as const)(
  'rejects %s delegates before collecting Git evidence',
  async (failure) => {
    vi.stubEnv('TAU_DELEGATE_MODEL', failure === 'invalid' ? 'invalid' : 'missing/model');
    const app = reviewFixture();
    if (failure === 'missing') {
      app.find.mockReturnValue(undefined);
    }

    await expect(app.execute()).rejects.toThrow(
      failure === 'invalid' ? 'Invalid delegate model' : 'model not found',
    );

    expect(app.exec).not.toHaveBeenCalled();
    expect(app.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(app.complete).not.toHaveBeenCalled();
  },
);

it('retries malformed delegate findings once and preserves finding kinds', async () => {
  const app = reviewFixture();
  const findings = [
    { path: 'file.ts', line: 1, kind: 'inaccurate', message: 'Wrong behavior.' },
    { path: 'file.ts', line: 1, kind: 'policy', message: 'Obvious narration.' },
    { path: 'file.ts', line: 2, kind: 'missing', message: 'Explain the constraint.' },
  ];
  app.complete
    .mockResolvedValueOnce(fauxAssistantMessage('{"findings":[{"path":"outside.ts"}]}'))
    .mockResolvedValueOnce(fauxAssistantMessage(JSON.stringify({ findings })));

  await expect(app.execute()).resolves.toEqual({ findings });

  expect(app.complete).toHaveBeenCalledTimes(2);
  expect(app.complete.mock.calls.every(([model]) => model === app.delegate)).toBe(true);
});

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
    } else if (arguments_.includes('diff') && !arguments_.includes('--numstat')) {
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
    modelRegistry: {
      find: () => fauxProvider().getModel(),
      getApiKeyAndHeaders,
    },
  } as unknown as ExtensionContext;

  await expect(
    reviewComments({ exec }, context, undefined, { tree: 'candidate', head: 'base' }),
  ).rejects.toThrow(new Error(diagnostic));

  expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
});

describe('lockfile exclusion', () => {
  const reviewRepository = async (files: Record<string, string>) => {
    const repositoryDirectory = await createTemporaryRepository();
    const git = (commandArguments: string[]) =>
      runCommand('git', commandArguments, repositoryDirectory);

    await git(['commit', '--allow-empty', '-m', 'init']);
    await mkdir(join(repositoryDirectory, 'packages/app'), { recursive: true });
    await Promise.all(
      Object.entries(files).map(([path, content]) =>
        writeFile(join(repositoryDirectory, path), content),
      ),
    );
    await git(['add', '--', ...Object.keys(files)]);

    const tree = (await git(['write-tree'])).stdout.trim();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const app = reviewFixture();
    const pi = {
      exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
        runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    };
    const context = { ...app.context, cwd: join(repositoryDirectory, 'packages/app') };

    const review = await reviewComments(pi, context, undefined, { tree, head });

    return { review, complete: app.complete };
  };

  it('omits lockfiles from the review input', async () => {
    const { complete } = await reviewRepository({
      'packages/app/file.ts': '// Explains the value.\nexport const value = 1;\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'packages/app/Cargo.lock': 'version = 4\n',
    });

    const input = JSON.stringify(complete.mock.calls[0]?.[1].messages);

    expect(input).toContain('packages/app/file.ts');
    expect(input).not.toContain('lock');
  });

  it('reviews staged files when Git treats pathspecs literally', async () => {
    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');

    const { complete } = await reviewRepository({
      'packages/app/file.ts': '// Explains the value.\nexport const value = 1;\n',
    });

    expect(complete).toHaveBeenCalledOnce();
  });

  it('skips review when only lockfiles changed, whatever their size', async () => {
    const { review, complete } = await reviewRepository({
      'pnpm-lock.yaml': 'x'.repeat(400_001),
    });

    expect(review).toEqual({ findings: [] });
    expect(complete).not.toHaveBeenCalled();
  });
});
