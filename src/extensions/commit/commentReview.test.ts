import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository, runCommand } from '../../../tests/commitTool.js';
import { reviewComments, reviewGit } from './commentReview.js';

afterEach(() => vi.unstubAllEnvs());

const reviewInput = (request?: Parameters<ExtensionContext['modelRegistry']['complete']>[1]) => {
  const content = request?.messages[0]?.content;

  return typeof content === 'string' ? content : '';
};

const reviewFiles = (request?: Parameters<ExtensionContext['modelRegistry']['complete']>[1]) => {
  const input = JSON.parse(reviewInput(request)) as {
    files: { path: string; content: string }[];
  };

  return input.files;
};

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
  const exec = vi.fn<ExtensionAPI['exec']>(async (_command, argumentsList) => {
    let stdout = '';

    if (argumentsList.includes('--name-only')) {
      stdout = 'file.ts\0';
    } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'file.ts') {
      stdout = '100644 blob hash 20\tfile.ts\0';
    } else if (argumentsList[0] === 'cat-file') {
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

  // One malformed review retry plus one verifier call per non-missing finding.
  expect(app.complete).toHaveBeenCalledTimes(4);
  expect(app.complete.mock.calls.every(([model]) => model === app.delegate)).toBe(true);
});

it('numbers sent file content with 1-based lines including blank and trailing lines', async () => {
  const content = '// First.\n\n// Third.\n';
  const app = reviewFixture();
  app.exec.mockImplementation(async (_command, argumentsList) => {
    let stdout = '';

    if (argumentsList.includes('--name-only')) {
      stdout = 'file.ts\0';
    } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'file.ts') {
      stdout = '100644 blob hash 20\tfile.ts\0';
    } else if (argumentsList[0] === 'cat-file') {
      stdout = content;
    }

    return { stdout, stderr: '', code: 0, killed: false };
  });

  await app.execute();

  expect(reviewFiles(app.complete.mock.calls[0]?.[1])).toEqual([
    { path: 'file.ts', content: '1\t// First.\n2\t\n3\t// Third.\n4\t' },
  ]);
});

it('rejects findings beyond the raw source line count after numbering', async () => {
  const app = reviewFixture();
  app.complete.mockResolvedValue(
    fauxAssistantMessage(
      '{"findings":[{"path":"file.ts","line":4,"kind":"policy","message":"Narration."}]}',
    ),
  );

  await expect(app.execute()).rejects.toThrow('Comment review returned invalid findings.');
});

it('rejects findings on an empty file after numbering', async () => {
  const app = reviewFixture();
  app.exec.mockImplementation(async (_command, argumentsList) => {
    let stdout = '';

    if (argumentsList.includes('--name-only')) {
      stdout = 'empty.ts\0';
    } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'empty.ts') {
      stdout = '100644 blob hash 0\tempty.ts\0';
    }

    return { stdout, stderr: '', code: 0, killed: false };
  });
  app.complete.mockResolvedValue(
    fauxAssistantMessage(
      '{"findings":[{"path":"empty.ts","line":1,"kind":"policy","message":"Narration."}]}',
    ),
  );

  await expect(app.execute()).rejects.toThrow('Comment review returned invalid findings.');
});

it('counts numbering prefixes in the input budget', async () => {
  // 130,000 short lines fit the raw budget but exceed it once every line is numbered.
  const content = 'x\n'.repeat(130_000);
  const app = reviewFixture();
  app.exec.mockImplementation(async (_command, argumentsList) => {
    let stdout = '';

    if (argumentsList.includes('--name-only')) {
      stdout = 'big.ts\0';
    } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'big.ts') {
      stdout = `100644 blob hash ${content.length}\tbig.ts\0`;
    } else if (argumentsList[0] === 'cat-file') {
      stdout = content;
    }

    return { stdout, stderr: '', code: 0, killed: false };
  });

  await expect(app.execute()).rejects.toThrow(
    'Comment review input is too large: big.ts. Reduce the file and retry.',
  );
});

describe('finding verification', () => {
  const finding = {
    path: 'file.ts',
    line: 1,
    kind: 'policy',
    message: 'Narration.',
  };

  const reviewWithVerdict = (reviewed: unknown, verdict: string) => {
    const app = reviewFixture();

    app.complete
      .mockResolvedValueOnce(fauxAssistantMessage(JSON.stringify({ findings: [reviewed] })))
      .mockResolvedValueOnce(fauxAssistantMessage(verdict));

    return app;
  };

  const verifierInput = (request?: Parameters<ExtensionContext['modelRegistry']['complete']>[1]) =>
    JSON.parse(reviewInput(request)) as { finding: unknown; excerpt: string };

  it('downgrades a finding the verifier does not establish', async () => {
    const app = reviewWithVerdict(
      finding,
      '{"verdict":"not_established","reason":"Other files decide this."}',
    );

    const review = await app.execute();

    expect(review.findings).toEqual([
      {
        ...finding,
        kind: 'unverified',
        message: 'Narration. Unverified: Other files decide this.',
      },
    ]);
    expect(app.complete).toHaveBeenCalledTimes(2);
  });

  it('keeps a finding the verifier establishes', async () => {
    const app = reviewWithVerdict(finding, '{"verdict":"established","reason":"Shown code."}');

    const review = await app.execute();

    expect(review.findings).toEqual([finding]);
  });

  it.each([
    ['invalid JSON', fauxAssistantMessage('not json')],
    [
      'an error stop reason',
      fauxAssistantMessage('{"verdict":"not_established","reason":"x"}', {
        stopReason: 'error',
        errorMessage: 'verifier failed',
      }),
    ],
    ['a rejected call', new Error('provider unavailable')],
  ])('keeps a finding blocking after %s', async (_name, response) => {
    const app = reviewFixture();

    app.complete.mockResolvedValueOnce(
      fauxAssistantMessage(JSON.stringify({ findings: [finding] })),
    );

    if (response instanceof Error) {
      app.complete.mockRejectedValueOnce(response);
    } else {
      app.complete.mockResolvedValueOnce(response);
    }

    const review = await app.execute();

    expect(review.findings).toEqual([finding]);
  });

  it('never verifies missing findings', async () => {
    const advisory = { path: 'file.ts', line: 1, kind: 'missing', message: 'Explain it.' };
    const app = reviewFixture();

    app.complete.mockResolvedValueOnce(
      fauxAssistantMessage(JSON.stringify({ findings: [advisory] })),
    );

    const review = await app.execute();

    expect(review.findings).toEqual([advisory]);
    expect(app.complete).toHaveBeenCalledTimes(1);
  });

  it('numbers the verifier excerpt from the raw content and clamps it to the file', async () => {
    const content = Array.from({ length: 200 }, (_value, index) => `line ${index + 1}`).join('\n');
    const app = reviewFixture();

    app.exec.mockImplementation(async (_command, argumentsList) => {
      let stdout = '';

      if (argumentsList.includes('--name-only')) {
        stdout = 'file.ts\0';
      } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'file.ts') {
        stdout = `100644 blob hash ${content.length}\tfile.ts\0`;
      } else if (argumentsList[0] === 'cat-file') {
        stdout = content;
      }

      return { stdout, stderr: '', code: 0, killed: false };
    });
    const findings = [
      { ...finding, line: 5 },
      { ...finding, line: 200 },
    ];

    app.complete
      .mockResolvedValueOnce(fauxAssistantMessage(JSON.stringify({ findings })))
      .mockResolvedValue(fauxAssistantMessage('{"verdict":"established","reason":"Shown code."}'));

    await app.execute();

    const earlyLines = verifierInput(app.complete.mock.calls[1]?.[1]).excerpt.split('\n');

    expect(earlyLines[0]).toBe('1\tline 1');
    expect(earlyLines.at(-1)).toBe('65\tline 65');

    const lateLines = verifierInput(app.complete.mock.calls[2]?.[1]).excerpt.split('\n');

    expect(lateLines[0]).toBe('140\tline 140');
    expect(lateLines.at(-1)).toBe('200\tline 200');
  });

  it('sends the verifier the finding together with the excerpt', async () => {
    const app = reviewWithVerdict(finding, '{"verdict":"established","reason":"Shown code."}');

    await app.execute();

    expect(verifierInput(app.complete.mock.calls[1]?.[1]).finding).toEqual(finding);
  });

  it('uses the verifier policy unchanged', async () => {
    const app = reviewWithVerdict(finding, '{"verdict":"established","reason":"Shown code."}');

    await app.execute();

    expect(app.complete.mock.calls[1]?.[1].systemPrompt).toBe(
      `You verify one finding from a code-comment review. You receive the finding and a numbered excerpt of the file around the cited line. Decide whether the excerpt alone establishes the finding.
For an inaccurate finding, the code shown must contradict the comment. For a policy finding, the comment must clearly narrate obvious code, be commented-out code, or be a temporary note.
Answer not_established when the claim depends on code that is not shown, such as other files, callers, or other processes, or when the excerpt does not contradict the comment. Read the code carefully; a claim about concurrency, propagation, or control flow needs the shown code to support it.
Return only JSON: {"verdict":"established|not_established","reason":"one sentence"}.`,
    );
  });

  it('asks the verifier for one attempt with a bounded token budget', async () => {
    const app = reviewWithVerdict(finding, '{"verdict":"established","reason":"Shown code."}');

    await app.execute();

    expect(app.complete.mock.calls[1]?.[2]).toMatchObject({ maxTokens: 1024 });
  });
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
  ['diff', 'Comment review input is too large: file.ts. Reduce the file and retry.'],
])('rejects oversized %s input without offering a waiver', async (limit, diagnostic) => {
  const exec = vi.fn<ExtensionAPI['exec']>(async (_command, argumentsList) => {
    let stdout = '';

    if (argumentsList.includes('--name-only')) {
      stdout = 'file.ts\0';
    } else if (argumentsList.includes('ls-tree') && argumentsList.at(-1) === 'file.ts') {
      stdout = `100644 blob hash ${limit === 'file' ? 400_001 : 0}\tfile.ts\0`;
    } else if (argumentsList.includes('diff') && !argumentsList.includes('--numstat')) {
      stdout = limit === 'diff' ? 'x'.repeat(1_000_001) : '';
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

it('sends removed lines only through the diff', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const git = (commandArguments: string[]) =>
    runCommand('git', commandArguments, repositoryDirectory);

  await writeFile(
    join(repositoryDirectory, 'file.ts'),
    '// Removed comment.\nexport const a = 1;\n',
  );
  await git(['add', 'file.ts']);
  await git(['commit', '-m', 'init']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(repositoryDirectory, 'file.ts'), 'export const a = 1;\n');
  await git(['add', 'file.ts']);
  const tree = (await git(['write-tree'])).stdout.trim();
  const app = reviewFixture();
  const pi = {
    exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
      runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
  };

  await reviewComments(pi, { ...app.context, cwd: repositoryDirectory }, undefined, { tree, head });

  const input = reviewInput(app.complete.mock.calls[0]?.[1]);
  expect(input.split('Removed comment.')).toHaveLength(2);
});

it('drops findings on deleted files instead of rejecting the review', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const git = (commandArguments: string[]) =>
    runCommand('git', commandArguments, repositoryDirectory);

  await writeFile(join(repositoryDirectory, 'gone.ts'), '// Old comment.\nexport const a = 1;\n');
  await git(['add', 'gone.ts']);
  await git(['commit', '-m', 'init']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['rm', '-q', 'gone.ts']);
  const tree = (await git(['write-tree'])).stdout.trim();
  const app = reviewFixture();
  app.complete.mockResolvedValue(
    fauxAssistantMessage(
      '{"findings":[{"path":"gone.ts","line":1,"kind":"policy","message":"Narration."}]}',
    ),
  );
  const pi = {
    exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
      runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
  };

  const review = await reviewComments(pi, { ...app.context, cwd: repositoryDirectory }, undefined, {
    tree,
    head,
  });

  expect(review).toEqual({ findings: [] });
  expect(app.complete).toHaveBeenCalledOnce();
});

it('reviews submodule changes when Git summarizes submodules as logs', async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.submodule');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'log');
  const repositoryDirectory = await createTemporaryRepository();
  const git = (commandArguments: string[]) =>
    runCommand('git', commandArguments, repositoryDirectory);

  await git(['commit', '--allow-empty', '-m', 'init']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(repositoryDirectory, 'file.ts'), 'export const a = 1;\n');
  await git(['add', 'file.ts']);
  await git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor`]);
  const tree = (await git(['write-tree'])).stdout.trim();
  const app = reviewFixture();
  const pi = {
    exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
      runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
  };

  await reviewComments(pi, { ...app.context, cwd: repositoryDirectory }, undefined, { tree, head });

  expect(app.complete).toHaveBeenCalledOnce();
});

it('names the dispute when the shared review context exceeds the limit', async () => {
  const app = reviewFixture();

  await expect(
    reviewComments({ exec: app.exec }, app.context, undefined, {
      tree: 'candidate',
      head: 'base',
      dispute: 'x'.repeat(1_000_001),
    }),
  ).rejects.toThrow(
    new Error('Comment review context is too large. Shorten the dispute and retry.'),
  );
});

describe('large commits', () => {
  it('reviews input over the payload limit in sequential bounded batches and merges their findings', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    const git = (commandArguments: string[]) =>
      runCommand('git', commandArguments, repositoryDirectory);
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

    await git(['commit', '--allow-empty', '-m', 'init']);
    await Promise.all(
      paths.map((path) =>
        writeFile(join(repositoryDirectory, path), `// ${path}\n${'x'.repeat(200_000)}\n`),
      ),
    );
    await git(['add', '--', ...paths]);

    const tree = (await git(['write-tree'])).stdout.trim();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const app = reviewFixture();
    let running = 0;
    let mostRunning = 0;
    app.complete.mockImplementation(async (_model, request) => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      const input = reviewInput(request);
      const findings = paths
        .filter((path) => input.includes(`// ${path}`))
        .map((path) => ({ path, line: 1, kind: 'policy', message: `Narrates ${path}.` }));

      return fauxAssistantMessage(JSON.stringify({ findings }));
    });
    const pi = {
      exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
        runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    };

    const review = await reviewComments(
      pi,
      { ...app.context, cwd: repositoryDirectory },
      undefined,
      {
        tree,
        head,
      },
    );

    const inputs = app.complete.mock.calls.map(([, request]) => reviewInput(request));
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((input) => input.length <= 1_000_000)).toBe(true);
    expect(mostRunning).toBe(1);
    expect(review.findings.map((finding) => finding.path).toSorted()).toEqual(paths);
  });

  it('reviews commits that delete files larger than the input budget', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    const git = (commandArguments: string[]) =>
      runCommand('git', commandArguments, repositoryDirectory);

    await writeFile(join(repositoryDirectory, 'gone.ts'), 'x\n'.repeat(300_000));
    await git(['add', 'gone.ts']);
    await git(['commit', '-m', 'init']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['rm', '-q', 'gone.ts']);
    await writeFile(join(repositoryDirectory, 'file.ts'), 'export const a = 1;\n');
    await git(['add', 'file.ts']);
    const tree = (await git(['write-tree'])).stdout.trim();
    const app = reviewFixture();
    const pi = {
      exec: (command: string, commandArguments: string[], options?: { cwd?: string }) =>
        runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    };

    await reviewComments(pi, { ...app.context, cwd: repositoryDirectory }, undefined, {
      tree,
      head,
    });

    const input = reviewInput(app.complete.mock.calls[0]?.[1]);
    expect(input).toContain('gone.ts');
    expect(input.length).toBeLessThan(10_000);
  });
});
