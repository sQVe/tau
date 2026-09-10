import { execFile } from 'node:child_process';
import type * as fileSystem from 'node:fs/promises';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commentPolicyHash, reviewGit } from './commentReview.js';
import type { CommentReview, reviewComments } from './commentReview.js';
import type { CommitInput } from './tool.js';
import {
  commitFailedError,
  createCommitTool as createReviewedCommitTool,
  validatePaths,
  validateSubject,
} from './tool.js';

// Git and approval tests use a clean reviewer.
// tests/commitFlow.integration.test.ts covers real Pi review.
const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  createReviewedCommitTool(pi, async () => ({ findings: [] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return { ...original, rename: vi.fn<typeof rename>(original.rename) };
});

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runCommand = async (
  command: string,
  commandArguments: string[],
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArguments, {
      cwd: workingDirectory,
      ...(signal ? { signal } : {}),
    });

    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
      killed: failure.killed ?? false,
    };
  }
};

const git = async (repositoryDirectory: string, commandArguments: string[]): Promise<string> => {
  const result = await runCommand('git', commandArguments, repositoryDirectory);

  if (result.code !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

const createTemporaryRepository = async (): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-'));
  temporaryDirectories.push(repositoryDirectory);

  await git(repositoryDirectory, ['init']);
  await git(repositoryDirectory, ['config', 'user.name', 'Tau Test']);
  await git(repositoryDirectory, ['config', 'user.email', 'tau@example.com']);
  await git(repositoryDirectory, ['config', 'commit.gpgsign', 'false']);

  return repositoryDirectory;
};

const writeRepositoryFile = async (
  repositoryDirectory: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(repositoryDirectory, relativePath);

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
};

const getStoredCommitMessage = async (repositoryDirectory: string): Promise<string> => {
  const commitObject = await git(repositoryDirectory, ['cat-file', '-p', 'HEAD']);
  const separatorIndex = commitObject.indexOf('\n\n');

  if (separatorIndex === -1) {
    throw new Error('Could not locate commit message in git cat-file output');
  }

  return commitObject.slice(separatorIndex + 2);
};

const confirmedContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: { custom: () => Promise.resolve('approve') },
  }) as never;

const declinedContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: { custom: () => Promise.resolve('abort') },
  }) as never;

const noUiContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: false,
    ui: {},
  }) as never;

const executeCommit = async (repositoryDirectory: string, input: CommitInput) => {
  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  return commitTool.execute(
    'tool-call-1',
    input,
    undefined,
    undefined,
    confirmedContext(repositoryDirectory),
  );
};

const fakeCommit = (choices: (string | undefined)[], edits: (string | undefined)[] = []) => {
  const previews: string[] = [];
  const custom = vi.fn<
    (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<string | undefined>
  >(async (factory) => {
    const component = await factory(
      { requestRender: () => {}, terminal: { rows: 60 } } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      () => {},
    );
    previews.push(component.render(80).join('\n'));

    return choices.shift();
  });

  const editor = vi.fn<ExtensionContext['ui']['editor']>(() => Promise.resolve(edits.shift()));

  const exec = vi.fn<ExtensionAPI['exec']>((_command, commandArguments) => {
    let stdout = '';

    if (commandArguments.includes('--numstat')) {
      stdout = '2\t1\tREADME.md\0-\t-\timage.png\0';
    }

    if (commandArguments[0] === 'rev-parse' || commandArguments[0] === 'write-tree') {
      stdout = 'abc123\n';
    }

    return Promise.resolve({ code: 0, killed: false, stderr: '', stdout });
  });
  const tool = createCommitTool({ exec });
  const context = { cwd: '/repo', hasUI: true, ui: { custom, editor } };
  const input = {
    groups: [
      {
        files: ['README.md'],
        subject: 'feat: add thing',
        body: 'Original body',
      },
    ],
  };

  const execute = (signal?: AbortSignal) =>
    tool.execute('call', input, signal, undefined, context as never);

  return { custom, editor, exec, context, input, execute, previews };
};

it('rejects calls outside Git before running configured commands or changing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-no-git-'));
  temporaryDirectories.push(directory);

  const config = JSON.stringify({
    prepare: ['sh', '-c', 'touch mutated'],
    check: ['sh', '-c', 'touch checked'],
  });

  await writeFile(join(directory, 'tau.json'), config);

  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? directory),
  );
  const tool = createCommitTool({ exec });

  await expect(
    tool.execute(
      'outside-git',
      {
        groups: [{ files: ['tau.json'], subject: 'chore: configure commands' }],
      },
      undefined,
      undefined,
      confirmedContext(directory),
    ),
  ).rejects.toThrow(/not a git repository/i);
  expect(exec.mock.calls.map(([command, arguments_]) => [command, arguments_])).toEqual([
    ['git', ['rev-parse', '--show-toplevel']],
  ]);
  expect(await readFile(join(directory, 'tau.json'), 'utf8')).toBe(config);
  await expect(readFile(join(directory, 'mutated'))).rejects.toThrow(/ENOENT/);
  await expect(readFile(join(directory, 'checked'))).rejects.toThrow(/ENOENT/);
});

it('prepares each executed group after staging and reviews prepared bytes', async () => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(
    directory,
    'tau.json',
    JSON.stringify({
      prepare: [
        'node',
        '-e',
        `const fs = require('node:fs'); const cp = require('node:child_process'); const paths = cp.execFileSync('git', ['diff', '--cached', '--name-only', '-z']).toString().split('\\0').filter(Boolean); if (paths.length !== 1) throw Error('expected one staged path'); fs.writeFileSync(paths[0], 'prepared');`,
      ],
      check: [
        'node',
        '-e',
        `const fs = require('node:fs'); if (!['one', 'two'].some(path => fs.readFileSync(path, 'utf8') === 'prepared')) process.exit(1);`,
      ],
    }),
  );
  await writeRepositoryFile(directory, 'one', 'base');
  await writeRepositoryFile(directory, 'two', 'base');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'test: baseline']);
  await writeRepositoryFile(directory, 'one', 'dirty');
  await writeRepositoryFile(directory, 'two', 'dirty');

  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? directory),
  );
  const review = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
    expect(
      await git(directory, [
        'show',
        `${snapshot.tree}:${review.mock.calls.length === 1 ? 'one' : 'two'}`,
      ]),
    ).toBe('prepared');

    return { findings: [] };
  });
  const tool = createReviewedCommitTool({ exec }, review);
  const result = await tool.execute(
    'groups',
    {
      groups: [
        { files: ['one'], subject: 'feat: one' },
        { files: ['two'], subject: 'feat: two' },
      ],
    },
    undefined,
    undefined,
    confirmedContext(directory),
  );

  expect(result.details.groups).toHaveLength(2);
  expect(review).toHaveBeenCalledTimes(2);
  expect(
    exec.mock.calls.filter(([, arguments_]) =>
      arguments_.some((argument) => argument.includes('expected one staged path')),
    ),
  ).toHaveLength(2);
  expect(await git(directory, ['show', 'HEAD:two'])).toBe('prepared');
});

describe('preparation ownership', () => {
  const fixture = async (script: string) => {
    const directory = await createTemporaryRepository();

    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ prepare: ['node', '-e', script] }),
    );
    await writeRepositoryFile(directory, 'requested', 'base');
    await writeRepositoryFile(directory, 'other', 'base');
    await git(directory, ['add', '.']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(directory, 'requested', 'staged');
    await git(directory, ['add', 'requested']);
    await writeRepositoryFile(directory, 'requested', 'working');
    await writeRepositoryFile(directory, 'user data\n.txt', 'untracked prior bytes');

    return directory;
  };

  const recovery = async (directory: string) => {
    const root = (
      await git(directory, ['rev-parse', '--path-format=absolute', '--git-path', 'tau-recovery'])
    ).trim();
    const paths = await readdir(root);
    const path = join(root, paths[0]!);
    const working = JSON.parse(await readFile(join(path, 'working.json'), 'utf8')) as Record<
      string,
      { content: string; kind: string; mode: number } | null
    >;

    return { path, working };
  };

  it('allows index cache refreshes but restores the exact original index', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'formatted')");
    const originalIndex = await readFile(join(directory, '.git/index'));
    const tool = createCommitTool({
      exec: (command, arguments_, options) =>
        runCommand(command, arguments_, options?.cwd ?? directory),
    });
    const result = await tool.execute(
      'refresh',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      undefined,
      undefined,
      {
        cwd: directory,
        hasUI: true,
        ui: {
          custom: async () => {
            await writeFile(join(directory, 'requested'), 'formatted');
            await git(directory, ['update-index', '--refresh']);

            return 'skip';
          },
        },
      } as never,
    );

    expect(result.details.groups[0]?.skipped).toBe(true);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
  });

  it('does not remove a later writer lock after publishing its index', async () => {
    const directory = await fixture('');
    const original = await vi.importActual<typeof fileSystem>('node:fs/promises');

    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await original.rename(source, destination);
      await writeFile(`${String(destination)}.lock`, 'another writer');
    });

    try {
      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/lock/);
      expect(await readFile(join(directory, '.git/index.lock'), 'utf8')).toBe('another writer');
    } finally {
      vi.mocked(rename).mockImplementation(original.rename);
    }
  });

  it('rejects paths assigned to two groups before preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, {
        groups: [
          { files: ['requested'], subject: 'feat: one' },
          { files: ['./requested'], subject: 'feat: two' },
        ],
      }),
    ).rejects.toThrow(/assigned.*multiple groups/i);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('reports earlier commits on cancellation without a second cleanup conflict', async () => {
    const directory = await fixture('');
    await writeFile(join(directory, 'other'), 'second change');
    const controller = new AbortController();
    let preparations = 0;
    let firstSha = '';
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        if (command === 'env' && arguments_.includes('node')) {
          preparations += 1;

          if (preparations === 2) {
            firstSha = (await git(directory, ['rev-parse', 'HEAD'])).trim();
            controller.abort();
          }
        }

        return runCommand(command, arguments_, options?.cwd ?? directory);
      },
    });
    const caught = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['requested'], subject: 'feat: one' },
            { files: ['other'], subject: 'feat: two' },
          ],
        },
        controller.signal,
        undefined,
        confirmedContext(directory),
      )
      .catch((error: unknown) => {
        if (error instanceof Error) {
          return error;
        }

        throw error;
      });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(firstSha);
    expect((caught as Error).message).toContain('Commit cancelled');
    expect((caught as Error).message).not.toContain('ownership conflict');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('reports earlier commits when later cleanup encounters concurrent staging', async () => {
    const directory = await fixture('');
    await writeFile(join(directory, 'other'), 'second change');
    let approvals = 0;
    let firstSha = '';
    const tool = createCommitTool({
      exec: (command, arguments_, options) =>
        runCommand(command, arguments_, options?.cwd ?? directory),
    });

    const caught = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['requested'], subject: 'feat: one' },
            { files: ['other'], subject: 'feat: two' },
          ],
        },
        undefined,
        undefined,
        {
          cwd: directory,
          hasUI: true,
          ui: {
            custom: async () => {
              approvals += 1;

              if (approvals === 2) {
                firstSha = (await git(directory, ['rev-parse', 'HEAD'])).trim();
                await writeFile(join(directory, 'other'), 'concurrent staging');
                await git(directory, ['add', 'other']);

                return 'abort';
              }

              return 'approve';
            },
          },
        } as never,
      )
      .catch((error: unknown) => {
        if (error instanceof Error) {
          return error;
        }

        throw error;
      });

    expect((caught as Error).message).toMatch(
      /declined[\s\S]*ownership conflict[\s\S]*Already committed:[\s\S]*feat: one/,
    );
    expect(firstSha).toHaveLength(40);
    expect((caught as Error).message).toContain(firstSha);
    expect(await git(directory, ['show', ':other'])).toBe('concurrent staging');
  });

  it('returns cancellation and recovery after interrupting a real preparation process', async () => {
    const directory = await fixture(
      "require('node:fs').writeFileSync('requested', 'interrupted'); setInterval(() => {}, 1000)",
    );
    const originalIndex = await readFile(join(directory, '.git/index'));
    const controller = new AbortController();
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        const pending = runCommand(command, arguments_, options?.cwd ?? directory, options?.signal);

        if (command === 'env' && arguments_.includes('node')) {
          await vi.waitFor(async () =>
            readFile(join(directory, 'requested'), 'utf8').then((content) => {
              if (content !== 'interrupted') {
                throw new Error('Preparation has not started.');
              }
            }),
          );
          controller.abort();
        }

        return pending;
      },
    });
    const result = await tool.execute(
      'cancel',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      controller.signal,
      undefined,
      confirmedContext(directory),
    );

    expect(result.content).toContainEqual({ type: 'text', text: 'Commit cancelled' });
    expect(JSON.stringify(result.content)).toContain('Recovery saved');
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(
      Buffer.from((await recovery(directory)).working.requested!.content, 'base64').toString(),
    ).toBe('working');
  });

  it.each(['', "; require('node:child_process').execFileSync('git', ['add', 'generated'])"])(
    'stops unassigned generated additions before approval: %s',
    async (stage) => {
      const directory = await fixture(
        `require('node:fs').writeFileSync('generated', 'new bytes')${stage}`,
      );
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/Preparation added paths.*generated.*Assign/s);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, 'generated'), 'utf8')).toBe('new bytes');
      const saved = await recovery(directory);
      expect(Buffer.from(saved.working['user data\n.txt']!.content, 'base64').toString()).toBe(
        'untracked prior bytes',
      );
    },
  );

  it.each(['other', 'user data\n.txt'])(
    'rejects unrequested worktree edits without absorbing them: %s',
    async (path) => {
      const directory = await fixture(
        `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'formatter bytes')`,
      );
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [
            { files: ['requested'], subject: 'feat: requested' },
            { files: ['other'], subject: 'feat: other' },
          ],
        }),
      ).rejects.toThrow(/ownership conflict/);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, path), 'utf8')).toBe('formatter bytes');
    },
  );

  it('recovers exact tracked and untracked bytes after a real process is killed', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); fs.writeFileSync('requested', 'damaged'); fs.unlinkSync('user data\\n.txt'); process.kill(process.pid, 'SIGKILL');`,
    );
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/preparation failed[\s\S]*Recovery saved/i);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    const saved = await recovery(directory);
    expect(Buffer.from(saved.working.requested!.content, 'base64').toString()).toBe('working');
    expect(Buffer.from(saved.working['user data\n.txt']!.content, 'base64').toString()).toBe(
      'untracked prior bytes',
    );
    expect(await readFile(join(saved.path, 'original-index'))).toEqual(originalIndex);
    expect(await readFile(join(saved.path, 'recovery.txt'), 'utf8')).toContain('Never copy');
  });

  it('classifies clean tracked generated changes separately from user edits', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('other', 'generated bytes')");

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Preparation added paths.*other.*Assign/s);
    await writeFile(join(directory, 'other'), 'user edit');

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/ownership conflict.*other/);
  });

  it('handles a requested new file deleted by preparation', async () => {
    const directory = await fixture(
      "require('node:fs').unlinkSync('new file'); require('node:child_process').execFileSync('git', ['add', '-A', '--', 'new file']);",
    );
    await writeFile(join(directory, 'new file'), 'new data');

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested', 'new file'], subject: 'feat: requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'new file'])).toBe('');
  });

  it('uses literal root-relative paths from a nested cwd in a linked worktree', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); const cp = require('node:child_process'); for (const path of cp.execFileSync('git', ['diff', '--cached', '--name-only', '-z']).toString().split('\\0').filter(Boolean)) fs.writeFileSync(path, 'prepared literal');`,
    );
    const linked = join(directory, 'linked');
    await git(directory, ['worktree', 'add', '-b', 'linked', linked, 'HEAD']);
    const files = ['space name', 'line\nname', '[literal]', 'back\\slash', './:(literal)name'];

    for (const file of files) {
      await writeRepositoryFile(linked, `nested\nfolder/${file}`, 'new');
    }

    const result = await executeCommit(join(linked, 'nested\nfolder'), {
      groups: [{ files, subject: 'feat: literal paths' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    for (const file of files) {
      expect(await git(linked, ['show', `HEAD:nested\nfolder/${file.replace(/^\.\//, '')}`])).toBe(
        'prepared literal',
      );
    }

    const recoveryRoot = (
      await git(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'tau-recovery'])
    ).trim();
    expect(recoveryRoot).toContain('/worktrees/linked/');
    expect(await readdir(recoveryRoot)).toEqual([]);
  });

  it('saves executable modes and symlink targets without following symlinks', async () => {
    const directory = await fixture(
      "const fs = require('node:fs'); fs.unlinkSync('link'); fs.chmodSync('other', 0o644); process.exit(1)",
    );
    await symlink('other', join(directory, 'link'));
    await chmod(join(directory, 'other'), 0o755);

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Recovery saved/);
    const saved = await recovery(directory);

    expect(saved.working.other!.mode).toBe(0o755);
    expect(saved.working.link!.kind).toBe('symlink');
    expect(Buffer.from(saved.working.link!.content, 'base64').toString()).toBe('other');
  });

  it('rejects a symlink ancestor before running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeRepositoryFile(directory, 'folder/child', 'tracked');
    await git(directory, ['add', 'folder/child']);
    await rm(join(directory, 'folder'), { recursive: true });
    await mkdir(join(directory, 'elsewhere'));
    await symlink('elsewhere', join(directory, 'folder'));

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested', 'folder/child'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow(/directory symlinks/);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects unsupported index flags before running preparation: %s',
    async (flag) => {
      const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
      await git(directory, ['update-index', flag, 'other']);
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/Unsupported index/);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    },
  );

  it('leaves unknown pre-staged files untouched without running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeFile(join(directory, 'other'), 'staged user content');
    await git(directory, ['add', 'other']);
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/already staged: other/);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('rejects submodules before preparation and keeps recovery objects reachable', async () => {
    const directory = await fixture('process.exit(1)');

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Recovery saved/);
    const saved = await recovery(directory);
    const reference = (await readFile(join(saved.path, 'recovery-ref'), 'utf8')).trim();
    await git(directory, ['gc', '--prune=now']);
    expect(await git(directory, ['show', `${reference}:requested`])).toBe('staged');
    expect(await git(directory, ['stash', 'list'])).toBe('');

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    await git(directory, ['update-index', '--add', '--cacheinfo', `160000,${head},submodule`]);
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Unsupported index/);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
  });

  it('rejects a symlink index before snapshot or preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    const index = join(directory, '.git/index');
    const originalIndex = await readFile(index);
    await rename(index, `${index}-target`);
    await symlink('index-target', index);

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/regular index file/);
    expect(await readFile(index)).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    await expect(readdir(join(directory, '.git/tau-recovery'))).rejects.toThrow(/ENOENT/);
  });

  it('supports an existing staged-only requested deletion', async () => {
    const directory = await fixture('');
    await git(directory, ['rm', '-f', 'requested']);

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: delete requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'requested'])).toBe('');
  });

  it('rejects directory requests before running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeRepositoryFile(directory, 'folder/child', 'child');

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested', 'folder'], subject: 'feat: folder' }],
      }),
    ).rejects.toThrow(/individual files.*directory/i);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('restages requested deletions after preparation', async () => {
    const directory = await fixture('');

    await rm(join(directory, 'requested'));
    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: delete requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'requested'])).toBe('');
  });

  it.each(['skip', 'abort'])(
    'preserves prior staging and current user edits on %s',
    async (choice) => {
      const directory = await fixture("require('node:fs').writeFileSync('requested', 'formatted')");
      const originalIndex = await readFile(join(directory, '.git/index'));
      const tool = createCommitTool({
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      });
      const call = tool.execute(
        'cleanup',
        { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        {
          cwd: directory,
          hasUI: true,
          ui: {
            custom: async () => {
              await writeFile(join(directory, 'requested'), 'concurrent working edit');

              return choice;
            },
          },
        } as never,
      );

      const outcome = await call.then(
        (result) => JSON.stringify(result.content),
        (error: unknown) => String(error),
      );

      expect(outcome).toContain(
        choice === 'abort' ? 'Commit declined by user' : 'Commit skipped by user',
      );
      expect(outcome).toContain('Recovery saved');

      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('concurrent working edit');
      expect((await recovery(directory)).working.requested).not.toBeNull();
    },
  );
});

it('prepares and checks without a package manifest', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'README.md', 'unformatted');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({
      prepare: [
        'sh',
        '-c',
        'test "$#" = 1 && test "$1" = "" && printf "formatted\\n" > README.md',
        'prepare',
        '',
      ],
      check: [
        'sh',
        '-c',
        'grep -qx formatted README.md && test "$#" = 1 && test "$1" = ""',
        'check',
        '',
      ],
    }),
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [{ files: ['README.md', 'tau.json'], subject: 'docs: format readme' }],
  });

  expect(JSON.stringify(result.content)).toContain('Project preparation passed: sh');
  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed: sh');
  expect(await git(repositoryDirectory, ['show', 'HEAD:README.md'])).toBe('formatted\n');
});

it.each([
  '{',
  'null',
  '[]',
  '{"prepare":null}',
  '{"prepare":[]}',
  '{"prepare":"make format"}',
  '{"prepare":[" "]}',
  '{"prepare":["make",1]}',
  '{"prepare":["make","\\u0000"]}',
  '{"check":null}',
  '{"check":[]}',
  '{"check":"make check"}',
  '{"check":[" "]}',
  '{"check":["make",1]}',
  '{"check":["make","\\u0000"]}',
])('rejects invalid command config before staging: %s', async (config) => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'tau.json', config);

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['tau.json'], subject: 'chore: configure commands' }],
    }),
  ).rejects.toThrow(/tau.json/);
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it.each([false, true])(
  'does not infer commands from package scripts with config present: %s',
  async (present) => {
    const repositoryDirectory = await createTemporaryRepository();

    if (present) {
      await writeRepositoryFile(repositoryDirectory, 'tau.json', '{}');
    }

    await writeRepositoryFile(
      repositoryDirectory,
      'package.json',
      JSON.stringify({
        packageManager: 'unsupported@1',
        scripts: { fix: 'exit 1', prepare: 'exit 1', check: 'exit 1' },
      }),
    );

    const result = await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: present ? ['tau.json', 'package.json'] : ['package.json'],
          subject: 'chore: configure project',
        },
      ],
    });

    expect(JSON.stringify(result.content)).toContain(
      present
        ? 'Project preparation unavailable: no prepare command in tau.json.'
        : 'Project preparation unavailable: no root tau.json.',
    );
    expect(result.details.groups[0]?.projectCheck).toBe(
      present
        ? 'Project check unavailable: no check command in tau.json.'
        : 'Project check unavailable: no root tau.json.',
    );
  },
);

it('rejects obsolete reserved and unknown settings before preparation or staging', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  );
  const tool = createCommitTool({ exec });
  const settings = [
    { fix: ['make', 'format'] },
    { checkMessage: ['make', 'message'] },
    { hooks: 'skip' },
    { hooks: 'run' },
    { chek: ['make', 'check'] },
    { check: [] },
  ];
  const errors = [
    /fix.*rename.*prepare/i,
    /checkMessage.*not implemented/i,
    /hooks.*not implemented/i,
    /hooks.*not implemented/i,
    /unknown.*chek/i,
    /check.*nonempty/i,
  ];

  for (const [index, setting] of settings.entries()) {
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'touch mutated'],
        ...setting,
      }),
    );
    exec.mockClear();

    await expect(
      tool.execute(
        'invalid',
        {
          groups: [{ files: ['tau.json'], subject: 'chore: config' }],
        },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      ),
    ).rejects.toThrow(errors[index]);
    expect(
      exec.mock.calls.every(
        ([command, arguments_]) => command === 'git' && arguments_[0] === 'rev-parse',
      ),
    ).toBe(true);
    await expect(readFile(join(repositoryDirectory, 'mutated'))).rejects.toThrow(/ENOENT/);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  }
});

it('reports a failing preparation before staging or approval', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({
      prepare: ['sh', '-c', 'echo preparation failed >&2; exit 1'],
      check: ['sh', '-c', 'exit 0'],
    }),
  );
  const approval = vi.fn<ExtensionContext['ui']['custom']>();
  const tool = createCommitTool({
    exec: (command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  });

  await expect(
    tool.execute(
      'fix',
      { groups: [{ files: ['tau.json'], subject: 'feat: fixture' }] },
      undefined,
      undefined,
      { cwd: repositoryDirectory, hasUI: true, ui: { custom: approval } } as never,
    ),
  ).rejects.toThrow(/Project preparation failed[\s\S]*preparation failed/);
  expect(approval).not.toHaveBeenCalled();
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('reports missing preparation while still checking the candidate', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['sh', '-c', 'exit 0'] }),
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [{ files: ['tau.json'], subject: 'feat: fixture' }],
  });

  expect(JSON.stringify(result.content)).toContain(
    'Project preparation unavailable: no prepare command in tau.json.',
  );
  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
});

it('rejects an array as the root config before approval', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'tau.json', '[]');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['tau.json'], subject: 'feat: package' }],
    }),
  ).rejects.toThrow('tau.json must be an object');
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('rejects a staged candidate whose project check fails despite an unstaged fix', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ prepare: ['sh', '-c', 'exit 0'], check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "if (require('./value.cjs') !== 2) throw Error('wrong value');",
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 1;');
  await git(repositoryDirectory, ['add', '.']);
  await git(repositoryDirectory, ['commit', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 2;');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', '-e', 'process.exit(0)'] }),
  );
  await writeRepositoryFile(repositoryDirectory, 'README.md', 'Document the change.');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['README.md'], subject: 'docs: update' }],
    }),
  ).rejects.toThrow(/Project check failed.*|wrong value/s);
  expect(await git(repositoryDirectory, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('checks the first commit and leaves unrelated working changes untouched', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require.resolve('typebox'); require('node:assert').equal(require('./value.cjs'), 2);",
  );
  await symlink(
    join(import.meta.dirname, '../../../node_modules'),
    join(repositoryDirectory, 'node_modules'),
    'dir',
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 2;');
  await writeRepositoryFile(repositoryDirectory, 'unrelated.txt', 'Leave this alone.');

  const result = await executeCommit(repositoryDirectory, {
    groups: [
      {
        files: ['tau.json', 'check.cjs', 'value.cjs'],
        subject: 'feat: initial value',
      },
    ],
  });

  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
  expect(await readFile(join(repositoryDirectory, 'unrelated.txt'), 'utf8')).toBe(
    'Leave this alone.',
  );
  expect(await git(repositoryDirectory, ['ls-tree', '--name-only', 'HEAD'])).not.toContain(
    'unrelated.txt',
  );
}, 30_000);

it('checks a staged tree that tracks node_modules', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require('./node_modules/vendored.cjs');",
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'node_modules/vendored.cjs',
    'module.exports = 1;',
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [
      {
        files: ['tau.json', 'check.cjs', 'node_modules/vendored.cjs'],
        subject: 'feat: vendored dependency',
      },
    ],
  });

  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
}, 30_000);

it('returns cancelled when aborted while the project check runs', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const controller = new AbortController();

  await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(repositoryDirectory, 'check.cjs', '');

  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      if (command === 'node' && commandArguments.includes('check.cjs')) {
        controller.abort();
      }

      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  const result = await commitTool.execute(
    'tool-call-1',
    { groups: [{ files: ['tau.json', 'check.cjs'], subject: 'feat: check' }] },
    controller.signal,
    undefined,
    confirmedContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content).toEqual([
    { type: 'text', text: 'no test runner resolves from this worktree' },
    { type: 'text', text: 'Commit cancelled' },
  ]);
  expect(currentHead).toBe(head);
  expect(stagedFiles).toBe('');
});

it('returns cancelled when aborted while project preparation runs', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const controller = new AbortController();

  await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(repositoryDirectory, 'check.cjs', '');
  await writeRepositoryFile(repositoryDirectory, 'prepare.cjs', '');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ prepare: ['node', 'prepare.cjs'], check: ['node', 'check.cjs'] }),
  );

  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      if (command === 'env' && commandArguments.includes('prepare.cjs')) {
        controller.abort();
      }

      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  const result = await commitTool.execute(
    'tool-call-1',
    {
      groups: [
        { files: ['tau.json', 'check.cjs', 'prepare.cjs'], subject: 'feat: prepare and check' },
      ],
    },
    controller.signal,
    undefined,
    confirmedContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content.slice(0, 2)).toEqual([
    { type: 'text', text: 'no test runner resolves from this worktree' },
    { type: 'text', text: 'Commit cancelled' },
  ]);
  expect(JSON.stringify(result.content[2])).toContain('Recovery saved at');
  expect(currentHead).toBe(head);
  expect(stagedFiles).toBe('');
});

it.each(['pass', 'fail', 'killed', 'cancel'] as const)(
  'cleans up the candidate after check result: %s',
  async (outcome) => {
    const repositoryDirectory = await createTemporaryRepository();
    const controller = new AbortController();
    let candidateDirectory = '';

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['check-command', ''] }),
    );

    const tool = createCommitTool({
      exec: (command, arguments_, options) => {
        if (command !== 'check-command') {
          return runCommand(command, arguments_, options?.cwd ?? repositoryDirectory);
        }

        candidateDirectory = options?.cwd ?? '';
        expect(candidateDirectory).not.toBe(repositoryDirectory);
        expect(arguments_).toEqual(['']);
        expect(options).toMatchObject({ signal: controller.signal, timeout: 600_000 });

        if (outcome === 'cancel') {
          controller.abort();
        }

        return Promise.resolve({
          code: outcome === 'fail' ? 1 : 0,
          killed: outcome === 'killed',
          stdout: '',
          stderr: 'check diagnostic',
        });
      },
    });
    const result = tool.execute(
      'cleanup',
      {
        groups: [{ files: ['tau.json'], subject: 'chore: configure check' }],
      },
      controller.signal,
      undefined,
      confirmedContext(repositoryDirectory),
    );

    const message = await result.then(
      (committed) => JSON.stringify(committed.content),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const expected = {
      pass: /Project check passed/,
      fail: /Project check failed.*check diagnostic/s,
      killed: /Project check failed.*check diagnostic/s,
      cancel: /Commit cancelled/,
    };

    expect(message).toMatch(expected[outcome]);

    expect(candidateDirectory).not.toBe('');
    await expect(readFile(join(candidateDirectory, 'tau.json'))).rejects.toThrow(/ENOENT/);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  },
);

it('rejects check-time formatting without modifying the working file', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require('node:fs').writeFileSync('value.cjs', 'module.exports = 2;');",
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = (2);');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['tau.json', 'check.cjs', 'value.cjs'],
          subject: 'feat: initial value',
        },
      ],
    }),
  ).rejects.toThrow('Project check changed tracked files');
  expect(await readFile(join(repositoryDirectory, 'value.cjs'), 'utf8')).toBe(
    'module.exports = (2);',
  );
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

describe('validateSubject', () => {
  it('throws a validation error naming the subject when it is not a conventional commit', () => {
    const subject = 'Add stuff.';

    expect(() => {
      validateSubject(subject);
    }).toThrow(new RegExp(`subject.*${subject.replace('.', '\\.')}`, 'i'));
  });

  it('returns without throwing when the subject is a conventional commit', () => {
    expect(() => {
      validateSubject('feat: add thing');
    }).not.toThrow();
    expect(() => {
      validateSubject('fix(scope): do it');
    }).not.toThrow();
    expect(() => {
      validateSubject('chore!: breaking');
    }).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('throws an error naming the offending path when any file matches the sensitive denylist', () => {
    expect(() => {
      validatePaths(['.env']);
    }).toThrow(/\.env/);
    expect(() => {
      validatePaths(['db/credentials.json']);
    }).toThrow(/db\/credentials\.json/);
    expect(() => {
      validatePaths(['keys/id_rsa']);
    }).toThrow(/keys\/id_rsa/);
    expect(() => {
      validatePaths(['.ssh/config']);
    }).toThrow(/\.ssh\/config/);
  });

  it('rejects paths with leading dot-slash that would bypass anchored patterns', () => {
    expect(() => {
      validatePaths(['./.env']);
    }).toThrow(/\.env/);
  });

  it('rejects sensitive paths that redundant separators would otherwise hide', () => {
    expect(() => {
      validatePaths(['.//id_rsa']);
    }).toThrow(/id_rsa/);
    expect(() => {
      validatePaths(['./././id_rsa']);
    }).toThrow(/id_rsa/);
  });

  it('rejects sensitive files in subdirectories', () => {
    expect(() => {
      validatePaths(['config/.env']);
    }).toThrow(/config\/\.env/);
    expect(() => {
      validatePaths(['packages/app/.npmrc']);
    }).toThrow(/\.npmrc/);
    expect(() => {
      validatePaths(['home/.ssh/config']);
    }).toThrow(/\.ssh/);
  });

  it('rejects sensitive paths whose casing differs from the pattern', () => {
    expect(() => {
      validatePaths(['.ENV']);
    }).toThrow(/\.ENV/);
    expect(() => {
      validatePaths(['.Env.production']);
    }).toThrow(/\.Env\.production/);
  });

  it('rejects paths that resolve to the repository root', () => {
    for (const pathspec of ['./', '.', './.', 'src/..']) {
      expect(() => {
        validatePaths([pathspec]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects an .ssh directory named without a trailing slash', () => {
    expect(() => {
      validatePaths(['.ssh']);
    }).toThrow(/\.ssh/);
    expect(() => {
      validatePaths(['home/.ssh']);
    }).toThrow(/\.ssh/);
  });

  it('accepts filenames containing glob characters, which git takes literally', () => {
    expect(() => {
      validatePaths(['app/[slug]/page.tsx', 'docs/faq?.md']);
    }).not.toThrow();
  });

  it('rejects pathspec magic and traversal attempts', () => {
    expect(() => {
      validatePaths([':(glob)*.ts']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['/etc/passwd']);
    }).toThrow(/Invalid path/);
  });

  it('keeps backslash traversal and sensitive path validation', () => {
    for (const path of [
      '..\\private',
      'src\\..\\..\\private',
      '.ssh\\config',
      'config\\.env',
      'folder\\credentials.json',
    ]) {
      expect(() => {
        validatePaths([path]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects traversal that only escapes the repository once collapsed', () => {
    expect(() => {
      validatePaths(['src/../../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['src/..']);
    }).toThrow(/Invalid path/);
  });

  it('returns without throwing when all files are outside the sensitive denylist', () => {
    expect(() => {
      validatePaths(['src/foo.ts', 'README.md', 'docs/env.md']);
    }).not.toThrow();
  });
});

describe('commitTool.execute', () => {
  const createPrefetchRepository = async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, ['add', 'base.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

    const groups = ['one', 'two', 'three'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    return { repositoryDirectory, groups };
  };

  it('returns findings for corrections before requiring a waiver under approve-all', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const groups = ['one', 'two', 'three'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    const review = vi
      .fn<typeof reviewComments>()
      .mockResolvedValueOnce({ findings: [] })
      .mockResolvedValue({
        findings: [{ path: 'two.txt', line: 1, kind: 'policy', message: 'Remove stale note.' }],
      });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const { context, custom } = fakeCommit(['approveAll', 'approveAll']);
    context.cwd = repositoryDirectory;

    await expect(
      tool.execute('batch', { groups }, undefined, undefined, context as never),
    ).rejects.toThrow(
      /Comment review needs corrections \(1\/2 automatic returns\):\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);

    const retry = () =>
      tool.execute('retry', { groups: groups.slice(1) }, undefined, undefined, context as never);

    await expect(retry()).rejects.toThrow(
      /Comment review needs corrections \(2\/2 automatic returns\):\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(1);
    await expect(retry()).rejects.toThrow(
      /Comment review requires an explicit user waiver\.\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(2);
    expect((await git(repositoryDirectory, ['log', '--format=%s'])).trim()).toBe(
      groups[0]!.subject,
    );
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('reviews the next group while the current overlay is open', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const reviewsWhenOverlayOpened: number[] = [];
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: () => {
          reviewsWhenOverlayOpened.push(review.mock.calls.length);

          return Promise.resolve('approve');
        },
      },
    };
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(reviewsWhenOverlayOpened).toEqual([2, 3, 3]);
    expect(review).toHaveBeenCalledTimes(3);
    expect(
      (await git(repositoryDirectory, ['log', '--format=%s', '-3'])).trim().split('\n'),
    ).toEqual(['feat: add three', 'feat: add two', 'feat: add one']);
  });

  it('re-reviews a group whose prefetch assumed an earlier group would commit', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const reviewed: string[][] = [];

    const review = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
      reviewed.push(
        (await git(repositoryDirectory, ['ls-tree', '--name-only', snapshot.tree]))
          .trim()
          .split('\n'),
      );

      return { findings: [] };
    });
    const choices = ['approve', 'skip', 'approve'];
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom: () => Promise.resolve(choices.shift()) },
    } as never);

    // Skipping two.txt invalidates the third group's planned tree, so it needs another review.
    expect(reviewed).toEqual([
      ['base.txt', 'one.txt'],
      ['base.txt', 'one.txt', 'two.txt'],
      ['base.txt', 'one.txt', 'three.txt', 'two.txt'],
      ['base.txt', 'one.txt', 'three.txt'],
    ]);

    expect(
      (await git(repositoryDirectory, ['log', '--format=%s', '-2'])).trim().split('\n'),
    ).toEqual(['feat: add three', 'feat: add one']);
  });

  it('reopens the overlay for a group whose files changed after approve all', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const choices = ['approveAll'];

    const custom = vi.fn<() => Promise<string | undefined>>(() =>
      Promise.resolve(choices.shift() ?? 'approve'),
    );
    const tool = createReviewedCommitTool(
      {
        exec: async (command, commandArguments, options) => {
          const result = await runCommand(
            command,
            commandArguments,
            options?.cwd ?? repositoryDirectory,
          );

          // Simulate a group-1 hook that edits a later group's file without staging it.
          if (commandArguments[0] === 'commit') {
            await writeRepositoryFile(repositoryDirectory, 'three.txt', 'rewritten by a hook');
          }

          return result;
        },
      },
      async () => ({ findings: [] }),
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom },
    } as never);

    // Group 3 changed after approve-all, so it needs another overlay.
    expect(custom).toHaveBeenCalledTimes(2);
    expect(await git(repositoryDirectory, ['show', 'HEAD:three.txt'])).toBe('rewritten by a hook');
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it('reviews every remaining group as soon as approve all is chosen', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const events: string[] = [];

    const review = vi.fn<typeof reviewComments>(() => {
      events.push('review');

      return Promise.resolve({ findings: [] });
    });

    const custom = vi.fn<() => Promise<string>>(() => Promise.resolve('approveAll'));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) => {
          if (commandArguments[0] === 'commit') {
            events.push('commit');
          }

          return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
        },
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom },
    } as never);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['review', 'review', 'review', 'commit', 'commit', 'commit']);
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it.each(['approve', 'skip', 'approveAll'])(
    'processes three groups sequentially using %s',
    async (middle) => {
      const repositoryDirectory = await createTemporaryRepository();

      const groups = ['one', 'two', 'three'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));

      for (const group of groups) {
        await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
      }

      const heads: (string | null)[] = [];
      const trees: string[][] = [];

      const review: typeof reviewComments = async (_pi, _context, _signal, snapshot) => {
        heads.push(snapshot.head);
        trees.push(
          (await git(repositoryDirectory, ['ls-tree', '--name-only', snapshot.tree]))
            .trim()
            .split('\n'),
        );

        return { findings: [] };
      };
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );
      const { context, custom, previews } = fakeCommit(
        middle === 'approveAll' ? ['approveAll'] : ['approve', middle, 'approve'],
      );
      context.cwd = repositoryDirectory;
      const result = await tool.execute(
        'batch',
        { groups },
        undefined,
        undefined,
        context as never,
      );
      const commitHashes = (await git(repositoryDirectory, ['log', '--reverse', '--format=%H']))
        .trim()
        .split('\n');

      expect(commitHashes).toHaveLength(middle === 'skip' ? 2 : 3);
      expect(
        (await git(repositoryDirectory, ['log', '--reverse', '--format=%s'])).trim().split('\n'),
      ).toEqual(
        groups.filter((_, index) => middle !== 'skip' || index !== 1).map((group) => group.subject),
      );

      expect(result.details.groups.map((group) => group.sha).filter(Boolean)).toEqual(commitHashes);

      for (const commitHash of commitHashes) {
        expect(JSON.stringify(result.content)).toContain(commitHash);
      }

      expect(result.details.groups[1]?.skipped).toBe(middle === 'skip' ? true : undefined);
      expect(JSON.stringify(result.content).includes('Group 2/3: Commit skipped')).toBe(
        middle === 'skip',
      );

      expect(heads).toEqual([
        null,
        commitHashes[0],
        middle === 'skip' ? commitHashes[0] : commitHashes[1],
      ]);
      expect(trees).toEqual([
        ['one.txt'],
        ['one.txt', 'two.txt'],
        middle === 'skip' ? ['one.txt', 'three.txt'] : ['one.txt', 'three.txt', 'two.txt'],
      ]);

      expect(custom).toHaveBeenCalledTimes(middle === 'approveAll' ? 1 : 3);
      expect(previews.map((preview, index) => preview.includes(`commit ${index + 1}/3`))).toEqual(
        middle === 'approveAll' ? [true] : [true, true, true],
      );

      expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it.each([
    { files: ['two.txt'], subject: 'invalid' },
    { files: ['.env'], subject: 'feat: add two' },
  ])('validates all groups before staging: %j', async (invalid) => {
    const { input, execute, exec } = fakeCommit(['approve', 'approve']);
    input.groups.push({ ...invalid, body: '' });

    await expect(execute()).rejects.toThrow(/Invalid/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['abort', 'cancel', 'corrections', 'retry', 'hook'])(
    'stops on %s and names earlier commits',
    async (failure) => {
      const repositoryDirectory = await createTemporaryRepository();

      const groups = ['one', 'two', 'three', 'four'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));

      for (const group of groups) {
        await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
      }

      const controller = new AbortController();
      let reviews = 0;

      const review = async () => {
        reviews += 1;

        if (reviews === 3 && failure === 'corrections') {
          return {
            findings: [
              { path: 'three.txt', line: 1, kind: 'policy' as const, message: 'Fix comment.' },
            ],
          };
        }

        if (reviews === 3 && failure === 'retry') {
          throw new Error('Reviewer unavailable');
        }

        return { findings: [] };
      };
      let overlays = 0;
      const context = {
        cwd: repositoryDirectory,
        hasUI: true,
        ui: {
          custom: async () => {
            overlays += 1;

            if (overlays <= 2) {
              return 'approve';
            }

            if (failure === 'cancel') {
              controller.abort();
            }

            if (failure === 'hook') {
              await writeRepositoryFile(
                repositoryDirectory,
                '.git/hooks/pre-commit',
                '#!/bin/sh\necho hook said no >&2\nexit 1\n',
              );
              await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

              return 'approve';
            }

            return failure === 'retry' ? 'retry' : 'abort';
          },
        },
      };
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );
      const failureError = await tool
        .execute('batch', { groups }, controller.signal, undefined, context as never)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const commitHashes = (await git(repositoryDirectory, ['log', '--reverse', '--format=%H']))
        .trim()
        .split('\n');

      expect(failureError).toBeInstanceOf(Error);
      expect(commitHashes).toHaveLength(2);

      for (const [index, commitHash] of commitHashes.entries()) {
        expect((failureError as Error).message).toContain(`Group ${index + 1}/4: ${commitHash}`);
      }

      expect((failureError as Error).message).toContain('Group 3/4');
      expect((failureError as Error).message).toContain(
        {
          abort: 'declined',
          cancel: 'cancelled',
          corrections: '1/2 automatic returns',
          retry: 'User requested fixes',
          hook: 'hook said no',
        }[failure]!,
      );

      expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
      expect(reviews).toBe(3);
      expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

      if (failure === 'hook') {
        await rm(join(repositoryDirectory, '.git/hooks/pre-commit'));
      }

      const result = await tool.execute(
        'retry',
        { groups: groups.slice(3) },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      );

      expect(result.details.groups[0]!.sha).not.toBe('');
      expect(
        (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
      ).toBe('four.txt');

      expect(await git(repositoryDirectory, ['status', '--short'])).toBe('?? three.txt\n');
    },
  );

  it('undoes a commit when a hook changes reviewed content in an approved file', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const hookPath = join(repositoryDirectory, '.git/hooks/pre-commit');

    await writeFile(
      hookPath,
      '#!/bin/sh\nprintf "// Unreviewed comment\\n" >> retry.ts\ngit add retry.ts\n',
    );
    await chmod(hookPath, 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }],
      }),
    ).rejects.toThrow(/changed reviewed content/);
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('rejects staged content changed while commit approval is open', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const tool = createCommitTool({
      exec: (command, commandArguments, options) =>
        runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    });
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: async () => {
          await writeRepositoryFile(
            repositoryDirectory,
            'retry.ts',
            '// Unreviewed comment\nexport const retries = 1;\n',
          );
          await git(repositoryDirectory, ['add', 'retry.ts']);

          return 'approve';
        },
      },
    } as never;

    await expect(
      tool.execute(
        'changed',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/changed since comment review/);
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('expires old abandoned review groups', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [{ path: 'retry.ts', line: 1, kind: 'policy' as const, message: 'Stale comment.' }],
    }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    const call = (path: string) =>
      tool.execute(
        'test',
        { groups: [{ files: [path], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      );
    for (let index = 0; index < 33; index += 1) {
      const path = `retry${index}.ts`;

      await writeRepositoryFile(repositoryDirectory, path, '// stale\n');

      await expect(call(path)).rejects.toThrow('1/2 automatic returns');
    }

    await expect(call('retry0.ts')).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(34);
  }, 30_000);

  it.each(['skip', 'abort', 'cancel'])('resets correction attempts after %s', async (choice) => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(
      repositoryDirectory,
      'retry.ts',
      '// stale\nexport const retries = 0;\n',
    );

    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [
        { path: 'retry.ts', line: 1, kind: 'inaccurate' as const, message: 'Stale comment.' },
      ],
    }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const controller = new AbortController();
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: async () => {
          if (choice === 'cancel') {
            controller.abort();
          }

          return choice;
        },
      },
    } as unknown as ExtensionContext;

    const call = () =>
      tool.execute(
        'test',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        context,
      );

    await expect(call()).rejects.toThrow('1/2 automatic returns');
    await expect(call()).rejects.toThrow('2/2 automatic returns');

    const finish = tool.execute(
      'test',
      { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
      controller.signal,
      undefined,
      context,
    );
    const outcome = await finish.then(
      () => 'returned',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toBe(choice === 'abort' ? 'Commit declined by user' : 'returned');
    await expect(call()).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('throws and unstages when the user aborts the overlay', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        declinedContext(repositoryDirectory),
      ),
    ).rejects.toThrow(/declined/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('throws in non-interactive mode without attempting to commit', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).rejects.toThrow(/non-interactive/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('creates one commit and returns the HEAD hash in details', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const result = await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add thing',
          body: 'Initial project file.',
        },
      ],
    });

    const commitHashOutput = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
    const logOutput = await git(repositoryDirectory, ['log', '--oneline']);
    const latestSubjectOutput = await git(repositoryDirectory, ['log', '-1', '--format=%s']);

    const commitHash = commitHashOutput.trim();
    const logLines = logOutput.trim().split('\n');
    const latestSubject = latestSubjectOutput.trim();

    expect(logLines).toHaveLength(1);
    expect(latestSubject).toBe('feat: add thing');
    expect(result.details.groups[0]).toEqual({
      sha: commitHash,
      files: ['README.md'],
      subject: 'feat: add thing',
      body: 'Initial project file.',
      projectCheck: 'Project check unavailable: no root tau.json.',
      commentReview: {
        status: 'passed',
        tree: (await git(repositoryDirectory, ['rev-parse', 'HEAD^{tree}'])).trim(),
        policy: commentPolicyHash,
        report: '',
      },
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'no test runner resolves from this worktree' },
      {
        type: 'text',
        text: `${commitHash} feat: add thing\nProject preparation unavailable: no root tau.json.\nProject check unavailable: no root tau.json.`,
      },
    ]);
  });

  it('includes the body in the committed message when body is provided', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add',
          body: 'Longer explanation here.',
        },
      ],
    });

    const body = await getStoredCommitMessage(repositoryDirectory);

    expect(body).toBe('feat: add\n\nLonger explanation here.\n');
  });

  it('refuses to commit when unrelated paths are already staged', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'notes.md', 'keep staged\n');
    await git(repositoryDirectory, ['add', '--', 'notes.md']);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: notes\.md/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit a glob, because git matches the pattern literally', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['*'],
            subject: 'feat: add everything',
          },
        ],
      }),
    ).rejects.toThrow(/git add failed/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('commits when the working directory is a subdirectory of the repository', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'sub/a.txt', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      'sub/tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'exit 81'],
        check: ['sh', '-c', 'exit 82'],
      }),
    );
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'printf "prepared\\n" > sub/a.txt'],
        check: ['grep', '-qx', 'prepared', 'sub/a.txt'],
      }),
    );
    await git(repositoryDirectory, ['add', 'tau.json', 'sub/tau.json']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: configure commands']);

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    const result = await commitTool.execute(
      'tool-call-1',
      { groups: [{ files: ['a.txt'], subject: 'feat: add a' }] },
      undefined,
      undefined,
      confirmedContext(join(repositoryDirectory, 'sub')),
    );

    expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
    expect(await git(repositoryDirectory, ['show', 'HEAD:sub/a.txt'])).toBe('prepared\n');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
    expect(
      (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
    ).toBe('sub/a.txt');
  });

  it('restores the index when staging pulls in files alongside a requested one', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src/a.ts', 'src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses to commit when staging a named path pulls in files it did not name', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit when an unrelated staged type change exists', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'link.txt', 'plain\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'link.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);

    await rm(join(repositoryDirectory, 'link.txt'));
    await symlink('/etc/hostname', join(repositoryDirectory, 'link.txt'));
    await git(repositoryDirectory, ['add', '--', 'link.txt']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: link\.txt/i);
  });

  it('refuses to commit when an unrelated staged deletion exists', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'old.md']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);
    await git(repositoryDirectory, ['rm', '--', 'old.md']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: old\.md/i);
  });

  it('prepares each staged group and keeps hooks enabled on the first call', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);
    await writeRepositoryFile(repositoryDirectory, 'second.txt', 'second group');
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngrep -qx formatted README.md || exit 1\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await writeRepositoryFile(
      repositoryDirectory,
      'prepare.cjs',
      "require('node:assert').notEqual(require('node:child_process').execSync('git diff --cached --name-only').toString(), ''); require('node:fs').writeFileSync('README.md', 'formatted\\n');",
    );
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['node', 'prepare.cjs'],
        check: ['grep', '-qx', 'formatted', 'README.md'],
      }),
    );
    const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
    );
    const tool = createReviewedCommitTool({ exec }, async (_pi, _context, _signal, snapshot) => {
      expect(await git(repositoryDirectory, ['show', `${snapshot?.tree}:README.md`])).toBe(
        'formatted\n',
      );

      return { findings: [] };
    });
    const result = await tool.execute(
      'fix',
      {
        groups: [
          {
            files: ['README.md', 'prepare.cjs', 'tau.json'],
            subject: 'feat: add readme',
          },
          { files: ['second.txt'], subject: 'feat: second group' },
        ],
      },
      undefined,
      undefined,
      confirmedContext(repositoryDirectory),
    );

    expect(JSON.stringify(result.content)).toContain(
      'Project preparation passed: node prepare.cjs',
    );
    expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
    expect(
      exec.mock.calls.filter(
        ([command, arguments_]) =>
          command === 'env' && arguments_.includes('prepare.cjs') && arguments_.includes('node'),
      ),
    ).toHaveLength(2);
    expect(exec.mock.calls.filter(([command]) => command === 'grep')).toHaveLength(2);

    const statusOutput = await git(repositoryDirectory, ['status', '--short']);
    const committedContent = await git(repositoryDirectory, ['show', 'HEAD:README.md']);

    expect(await git(repositoryDirectory, ['rev-list', '--all', '--count'])).toBe('3\n');
    expect(statusOutput).toBe('');
    expect(committedContent).toBe('formatted\n');
  });

  it('undoes the commit when a hook stages unrequested paths', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested: sneaky\.txt/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('README.md\n');
  });

  it('undoes only the new commit when a hook stages an unrequested path', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, ['add', '--', 'base.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

    const baseCommitHash = (await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested/i);

    expect((await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(baseCommitHash);
  });

  it('reports hook failure details and leaves no commits when git commit fails', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho hook output\necho hook said no >&2\nexit 1\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    let thrown: unknown;

    try {
      await executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add',
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('git commit failed:');
    expect((thrown as Error).message).toContain('hook said no');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  }, 10_000);

  it('falls back to stdout in the error message when stderr is only whitespace', () => {
    expect(commitFailedError('hook output\n', '   \n').message).toBe(
      'git commit failed: hook output',
    );
  });

  it('keeps both streams in the error message when a hook writes to each', () => {
    const message = commitFailedError('lint failed on src/a.ts\n', 'warning: slow hook\n').message;

    expect(message).toContain('lint failed on src/a.ts');
    expect(message).toContain('warning: slow hook');
  });
});

describe('preapproved commits', () => {
  it('reviews and commits every group without opening the overlay', async () => {
    const { exec, context, custom } = fakeCommit(['abort']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review, () => true);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];

    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(result.details.groups.map((group) => group.subject)).toEqual(
      groups.map((group) => group.subject),
    );
    expect(review).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.filter((call) => call[1][0] === 'commit')).toHaveLength(2);
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns review failures and never opens a waiver dialog', async () => {
    const { exec, context, custom, input } = fakeCommit(['waive']);
    const review = vi
      .fn<typeof reviewComments>()
      .mockRejectedValue(new Error('Reviewer unavailable'));
    const tool = createReviewedCommitTool({ exec }, review, () => true);

    await expect(
      tool.execute('call', input, undefined, undefined, context as never),
    ).rejects.toThrow(/requires an explicit user waiver.*Reviewer unavailable/s);

    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('returns a blocker after two correction attempts without waiving findings', async () => {
    const { exec, context, custom, input } = fakeCommit(['waive']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({
      findings: [{ path: 'README.md', line: 1, kind: 'inaccurate', message: 'Incorrect claim.' }],
    });
    const tool = createReviewedCommitTool({ exec }, review, () => true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        tool.execute('call', input, undefined, undefined, context as never),
      ).rejects.toThrow(
        attempt <= 2 ? `needs corrections (${attempt}/2` : 'requires an explicit user waiver',
      );
    }

    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it('still rejects failed project checks without a UI', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
      () => true,
    );

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['node', '-e', 'process.exit(1)'] }),
    );

    await expect(
      tool.execute(
        'call',
        {
          groups: [{ files: ['tau.json'], subject: 'feat: add package' }],
        },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).rejects.toThrow('Project check failed');

    expect(review).not.toHaveBeenCalled();
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });
});

describe('commit overlay flow', () => {
  it('applies a dispute only to the group carrying it', async () => {
    const { exec, context } = fakeCommit(['approve', 'approve']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one', commentDispute: 'Explains a constraint.' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];
    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(review.mock.calls.map((call) => call[3].dispute)).toEqual([
      'Explains a constraint.',
      undefined,
    ]);

    expect(result.details.groups[0]!.commentReview!.report).toContain('rechecked after dispute');
    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'rechecked after dispute',
    );

    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'No prior findings available.',
    );
  });

  it('stages and reads numstat before showing the overlay', async () => {
    const { execute, exec, custom, previews } = fakeCommit(['approve']);

    await execute();

    expect(previews[0]).toMatch(/\n commit *\n/);
    expect(previews[0]).not.toContain('1/1');
    expect(previews[0]).toContain('README.md +2 -1');
    expect(previews[0]).toContain('image.png binary');
    expect(exec.mock.calls.slice(0, 5).map((call) => call[1])).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--show-prefix'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
      ['--literal-pathspecs', 'add', '--', 'README.md'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
    ]);

    const numstatCall = exec.mock.calls.findIndex((call) => call[1].includes('--numstat'));

    expect(numstatCall).toBeGreaterThan(2);
    expect(exec.mock.invocationCallOrder[numstatCall]).toBeLessThan(
      custom.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('commits subject and body edits and returns the edited details', async () => {
    const { execute, editor, exec, custom } = fakeCommit(
      ['subject', 'body', 'approve'],
      ['fix: edited', 'Edited body'],
    );
    const result = await execute();

    expect(editor.mock.calls).toEqual([
      ['Edit subject', 'feat: add thing'],
      ['Edit body', 'Original body'],
    ]);

    expect(custom).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('git', ['commit', '-m', 'fix: edited\n\nEdited body'], {
      cwd: '/repo',
    });

    expect(result.details.groups[0]).toMatchObject({ subject: 'fix: edited', body: 'Edited body' });
  });

  it('retains the subject when the edit is cancelled', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], [undefined]);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).not.toContain('Invalid subject');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it('retains the subject and shows a notice when the edit is invalid', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], ['not conventional']);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).toContain('Invalid subject: not conventional');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ''])('handles a cancelled or empty body edit: %s', async (edit) => {
    const { execute } = fakeCommit(['body', 'approve'], [edit]);
    const result = await execute();

    expect(result.details.groups[0]!.body).toBe(edit ?? 'Original body');
  });

  it('opens an empty body editor when no body was supplied', async () => {
    const { execute, input, editor } = fakeCommit(['body', 'approve'], [undefined]);
    Reflect.deleteProperty(input.groups[0]!, 'body');
    const result = await execute();

    expect(editor).toHaveBeenCalledWith('Edit body', '');
    expect(result.details.groups[0]!.body).toBeNull();
  });

  it('unstages skipped groups and returns without committing', async () => {
    const { execute, exec } = fakeCommit(['skip']);
    const result = await execute();

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'TDD gate status unknown: unreadable evidence at /repo/.tau/state.json',
      },
      { type: 'text', text: 'Commit skipped by user' },
    ]);
    expect(result.details.groups[0]!.skipped).toBe(true);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );

    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it.each(['abort', undefined])('unstages and throws on abort or dismissal: %s', async (choice) => {
    const { execute, exec } = fakeCommit([choice]);

    await expect(execute()).rejects.toThrow('Commit declined by user');
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('rejects headless calls before staging', async () => {
    const { execute, exec, context, custom } = fakeCommit(['approve']);
    context.hasUI = false;

    await expect(execute()).rejects.toThrow(
      'Cannot commit without user confirmation (non-interactive mode)',
    );

    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns without UI or git operations when already cancelled', async () => {
    const { execute, exec, custom } = fakeCommit(['approve']);

    await execute(AbortSignal.abort());

    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns cancelled and unstages when aborted while the overlay is open', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit([]);
    custom.mockImplementation(
      (factory) =>
        new Promise<string | undefined>((resolve) => {
          void factory(
            { requestRender: () => {}, terminal: { rows: 60 } } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            {} as never,
            (result: unknown) => {
              resolve(typeof result === 'string' ? result : undefined);
            },
          );
          controller.abort();
        }),
    );

    const result = await execute(controller.signal);

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'TDD gate status unknown: unreadable evidence at /repo/.tau/state.json',
      },
      { type: 'text', text: 'Commit cancelled' },
    ]);
    expect(exec).toHaveBeenCalledWith('git', ['--literal-pathspecs', 'reset', '--', 'README.md'], {
      cwd: '/repo',
    });

    expect(exec).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit']),
      expect.anything(),
    );
  });

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit(['approve']);
    exec.mockImplementation((_command, commandArguments) => {
      if (commandArguments.includes('add')) {
        controller.abort();
      }

      return Promise.resolve({
        code: 0,
        killed: false,
        stdout: commandArguments.includes('--show-toplevel') ? '/repo\n' : '',
        stderr: '',
      });
    });

    await execute(controller.signal);

    expect(custom).not.toHaveBeenCalled();
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });
});
